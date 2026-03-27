(function () {
  "use strict";

  const STORAGE_KEY = "sunriseAlarm.v1";

  const skyCanvas = document.getElementById("sky-gl");
  const wakeInput = document.getElementById("wake-time");
  const durationSelect = document.getElementById("duration");
  const soundCheckbox = document.getElementById("sound-enabled");
  const waterSoundCheckbox = document.getElementById("water-sound-enabled");
  const statusEl = document.getElementById("status");
  const progressLabel = document.getElementById("progress-label");
  const timelineTrack = document.getElementById("timeline-track");
  const timelineRampBand = document.getElementById("timeline-ramp-band");
  const timelineMarkerRamp = document.getElementById("timeline-marker-ramp");
  const timelineMarkerWake = document.getElementById("timeline-marker-wake");
  const timelineMarkerNow = document.getElementById("timeline-marker-now");
  const timelineTicks = document.getElementById("timeline-ticks");

  const HOUR_MS = 60 * 60 * 1000;
  const MIN_TIMELINE_HOURS = 4;
  const MAX_TIMELINE_HOURS = 36;
  let timelineTickBucket = "";

  const btnArm = document.getElementById("btn-arm");
  const btnPreview = document.getElementById("btn-preview");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const btnDisarm = document.getElementById("btn-disarm");

  let loopTimer = null;
  let audioCtx = null;
  let wakeLockHandle = null;
  let birdMasterGain = null;
  let waterMasterGain = null;
  let birdPlayers = [];
  /** @type {HTMLAudioElement | null} */
  let waterAudio = null;

  const BIRD_TRACKS = [
    { src: "assets/audio/royal-natal-dawn-chorus.ogg", gain: 0.42 },
    { src: "assets/audio/cape-rock-thrush.ogg", gain: 0.48 },
    { src: "assets/audio/bird-singing.ogg", gain: 0.52 },
  ];

  const WATER_TRACK = {
    src: "assets/audio/creek-stream.ogg",
    gain: 0.38,
  };

  /** @type {Date | null} */
  let armedWakeAt = null;
  let armedDurationMin = 0;
  let armedWakeMinutes = 0;

  let previewStartMs = 0;
  let previewActive = false;

  function parseTimeToMinutes(value) {
    const s = String(value || "").trim();
    const match =
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([aApP][mM])?/.exec(s);
    if (!match) return NaN;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const ap = match[4];
    if (m > 59 || m < 0) return NaN;

    if (ap) {
      if (h < 1 || h > 12) return NaN;
      const up = ap.toUpperCase();
      if (up === "AM") {
        if (h === 12) h = 0;
      } else {
        if (h !== 12) h += 12;
      }
    } else if (h > 23 || h < 0) {
      return NaN;
    }

    return h * 60 + m;
  }

  /** 12-hour display for the wake field (e.g. 8:48 PM). */
  function minutesToTimeValue12(totalMin) {
    const t = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
    let h = Math.floor(t / 60);
    const m = t % 60;
    const isPm = h >= 12;
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    const ap = isPm ? "PM" : "AM";
    return h12 + ":" + String(m).padStart(2, "0") + " " + ap;
  }

  function floorToHour(d) {
    const t = new Date(d);
    t.setMinutes(0, 0, 0);
    return t;
  }

  function ceilToHour(d) {
    const t = new Date(d);
    if (t.getMinutes() === 0 && t.getSeconds() === 0 && t.getMilliseconds() === 0)
      return t;
    t.setMinutes(0, 0, 0);
    t.setHours(t.getHours() + 1);
    return t;
  }

  function computeTimelineWindow(now, rampStart, wakeAt) {
    const anchor = new Date(floorToHour(now).getTime() - HOUR_MS);
    const latest = new Date(
      Math.max(now.getTime(), rampStart.getTime(), wakeAt.getTime())
    );
    const endMin = new Date(ceilToHour(latest).getTime() + HOUR_MS);
    let spanMs = endMin.getTime() - anchor.getTime();
    const minMs = MIN_TIMELINE_HOURS * HOUR_MS;
    const maxMs = MAX_TIMELINE_HOURS * HOUR_MS;
    if (spanMs < minMs) spanMs = minMs;
    if (spanMs > maxMs) spanMs = maxMs;
    return { anchor, spanMs };
  }

  function formatTime12(d) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  function formatDayTime12(d) {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  function pctOnTimeline(when, anchor, spanMs) {
    return ((when.getTime() - anchor.getTime()) / spanMs) * 100;
  }

  function clampPct(p) {
    return Math.min(100, Math.max(0, p));
  }

  function getDisplaySchedule(now) {
    if (previewActive) return null;
    const durSel = Math.max(
      1,
      Math.min(180, Number(durationSelect.value) || 30)
    );

    if (armedWakeAt) {
      return {
        rampStart: new Date(
          armedWakeAt.getTime() - armedDurationMin * 60 * 1000
        ),
        wakeAt: armedWakeAt,
        ghost: false,
      };
    }

    const wm = parseTimeToMinutes(wakeInput.value);
    if (!Number.isFinite(wm)) return null;
    const wakeAt = scheduleNextFullRamp(wm, durSel, now);
    return {
      rampStart: new Date(wakeAt.getTime() - durSel * 60 * 1000),
      wakeAt,
      ghost: true,
    };
  }

  function formatHourLabel(d) {
    let h = d.getHours();
    const ap = h >= 12 ? "p" : "a";
    h = h % 12;
    if (h === 0) h = 12;
    return h + ap;
  }

  function updateTimelineTicks(anchor, spanMs) {
    const bucket = anchor.getTime() + "_" + spanMs;
    if (bucket === timelineTickBucket) return;
    timelineTickBucket = bucket;
    timelineTicks.replaceChildren();

    const totalHours = Math.round(spanMs / HOUR_MS);
    let step = 1;
    if (totalHours > 24) step = 3;
    else if (totalHours > 12) step = 2;

    const firstHour = ceilToHour(anchor);
    for (
      let t = firstHour.getTime();
      t <= anchor.getTime() + spanMs;
      t += HOUR_MS
    ) {
      const d = new Date(t);
      const hoursSinceFirst =
        Math.round((t - firstHour.getTime()) / HOUR_MS);
      if (hoursSinceFirst % step !== 0) continue;

      const pct = ((t - anchor.getTime()) / spanMs) * 100;
      if (pct < 0 || pct > 100) continue;

      const el = document.createElement("span");
      el.className = "timeline-tick";
      el.style.left = pct + "%";
      el.textContent = formatHourLabel(d);
      timelineTicks.appendChild(el);
    }
  }

  function setMarker(el, pct, titleText) {
    el.hidden = false;
    const c = clampPct(pct);
    el.style.left = c + "%";
    const clipped = pct < 0 || pct > 100;
    el.title =
      titleText + (clipped ? " (clipped to bar edge — see tooltip time)" : "");
    el.classList.toggle("timeline-marker-clipped", clipped);
  }

  function updateTimelineUi() {
    const now = new Date();
    const sched = getDisplaySchedule(now);

    let anchor, spanMs;
    if (sched) {
      ({ anchor, spanMs } = computeTimelineWindow(
        now,
        sched.rampStart,
        sched.wakeAt
      ));
    } else {
      anchor = new Date(floorToHour(now).getTime() - HOUR_MS);
      spanMs = MIN_TIMELINE_HOURS * HOUR_MS;
    }

    updateTimelineTicks(anchor, spanMs);

    const pNow = pctOnTimeline(now, anchor, spanMs);
    setMarker(timelineMarkerNow, pNow, "Now — " + formatDayTime12(now));

    const nowTag = timelineMarkerNow.querySelector(".timeline-marker-tag");
    if (nowTag) nowTag.textContent = formatTime12(now);

    if (!sched) {
      timelineRampBand.hidden = true;
      timelineMarkerRamp.hidden = true;
      timelineMarkerWake.hidden = true;
      timelineRampBand.classList.remove("is-ghost");
      timelineMarkerRamp.classList.remove("timeline-marker-ghost");
      timelineMarkerWake.classList.remove("timeline-marker-ghost");
      timelineTrack.setAttribute(
        "aria-label",
        "Preview: ramp markers hidden; end preview to see schedule"
      );
      return;
    }

    const pr = pctOnTimeline(sched.rampStart, anchor, spanMs);
    const pw = pctOnTimeline(sched.wakeAt, anchor, spanMs);
    const left = clampPct(Math.min(pr, pw));
    const right = clampPct(Math.max(pr, pw));
    const showRamp = right > left + 0.05;

    timelineRampBand.hidden = !showRamp;
    if (showRamp) {
      timelineRampBand.style.left = left + "%";
      timelineRampBand.style.width = right - left + "%";
    }
    timelineRampBand.classList.toggle("is-ghost", sched.ghost);

    timelineMarkerRamp.hidden = false;
    timelineMarkerWake.hidden = false;
    setMarker(
      timelineMarkerRamp,
      pr,
      "Ramp starts — " + formatTime12(sched.rampStart)
    );
    setMarker(
      timelineMarkerWake,
      pw,
      "Full brightness — " + formatTime12(sched.wakeAt)
    );
    timelineMarkerRamp.classList.toggle("timeline-marker-ghost", sched.ghost);
    timelineMarkerWake.classList.toggle("timeline-marker-ghost", sched.ghost);

    const rampTag = timelineMarkerRamp.querySelector(".timeline-marker-tag");
    if (rampTag) rampTag.textContent = formatTime12(sched.rampStart);
    const wakeTag = timelineMarkerWake.querySelector(".timeline-marker-tag");
    if (wakeTag) wakeTag.textContent = formatTime12(sched.wakeAt);

    const spanH = Math.round(spanMs / HOUR_MS);
    timelineTrack.setAttribute(
      "aria-label",
      spanH +
        "h window. Ramp " +
        formatTime12(sched.rampStart) +
        ", full " +
        formatTime12(sched.wakeAt) +
        ", now " +
        formatTime12(now)
    );
  }

  function nextWakeDate(wakeMinutes, now) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    let target = new Date(dayStart);
    target.setMinutes(wakeMinutes);
    if (target <= now) {
      target = new Date(dayStart);
      target.setDate(target.getDate() + 1);
      target.setMinutes(wakeMinutes);
    }
    return target;
  }

  /** Next wake time that hasn't passed yet. If the ramp already started, we jump in mid-ramp. */
  function scheduleNextFullRamp(wakeMinutes, durationMin, now) {
    return nextWakeDate(wakeMinutes, now);
  }

  function progressFromSchedule(wakeAt, durationMin, now) {
    const start = new Date(wakeAt.getTime() - durationMin * 60 * 1000);
    if (now < start) return 0;
    if (now >= wakeAt) return 1;
    const elapsed = now - start;
    const total = wakeAt - start;
    return elapsed / total;
  }

  function activeProgress() {
    const now = Date.now();
    if (previewActive) {
      const span = 30000;
      return Math.min(1, (now - previewStartMs) / span);
    }
    if (armedWakeAt) {
      return progressFromSchedule(
        armedWakeAt,
        armedDurationMin,
        new Date(now)
      );
    }
    return 0;
  }

  function updateProgressUi() {
    const nowMs = Date.now();
    if (previewActive && nowMs - previewStartMs < 30000) {
      const p = Math.round(
        Math.min(1, (nowMs - previewStartMs) / 30000) * 100
      );
      progressLabel.textContent = `Preview ramp — ${p}% (30s demo)`;
      return;
    }
    if (previewActive) {
      progressLabel.textContent =
        "Preview at full brightness — Arm to schedule or Disarm to clear";
      return;
    }
    if (!armedWakeAt) {
      progressLabel.textContent =
        "Not armed — markers show the next run if you Arm with current Wake & Ramp (12-hour clock).";
      return;
    }
    const t = new Date();
    const start = new Date(
      armedWakeAt.getTime() - armedDurationMin * 60 * 1000
    );
    if (t < start) {
      progressLabel.textContent =
        "Black until " +
        formatTime12(start) +
        " — then sunrise until Wake (full brightness) at " +
        formatTime12(armedWakeAt) +
        " (now " +
        formatTime12(t) +
        ").";
    } else if (t < armedWakeAt) {
      const raw = progressFromSchedule(armedWakeAt, armedDurationMin, t);
      const pct = Math.round(raw * 100);
      progressLabel.textContent =
        "Sunrise " +
        pct +
        "% toward Wake at " +
        formatTime12(armedWakeAt) +
        " (now " +
        formatTime12(t) +
        ").";
    } else {
      progressLabel.textContent =
        "Full brightness — Arm for the next sunrise or Disarm.";
    }
  }

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function rampCurveFromProgress(p) {
    const warmup = Math.max(0, (p - 0.06) / 0.94);
    return Math.pow(Math.min(1, warmup), 1.65) * 0.95;
  }

  function ensureNatureAudio() {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (birdMasterGain) return;

    birdMasterGain = ctx.createGain();
    birdMasterGain.gain.value = 0.0001;
    waterMasterGain = ctx.createGain();
    waterMasterGain.gain.value = 0.0001;
    birdMasterGain.connect(ctx.destination);
    waterMasterGain.connect(ctx.destination);

    birdPlayers = BIRD_TRACKS.map((track) => {
      const audio = new Audio(track.src);
      audio.loop = true;
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";

      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = track.gain;
      source.connect(gain);
      gain.connect(birdMasterGain);
      return audio;
    });

    waterAudio = new Audio(WATER_TRACK.src);
    waterAudio.loop = true;
    waterAudio.preload = "auto";
    waterAudio.crossOrigin = "anonymous";
    const waterSource = ctx.createMediaElementSource(waterAudio);
    const waterGain = ctx.createGain();
    waterGain.gain.value = WATER_TRACK.gain;
    waterSource.connect(waterGain);
    waterGain.connect(waterMasterGain);
  }

  function updateNatureRamp() {
    if (!audioCtx) return;
    const p = activeProgress();
    const curve = rampCurveFromProgress(p);
    const birdTarget = soundCheckbox.checked ? curve : 0;
    const waterTarget = waterSoundCheckbox.checked ? curve : 0;

    if (birdMasterGain) {
      birdMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      birdMasterGain.gain.linearRampToValueAtTime(
        birdTarget,
        audioCtx.currentTime + 0.8
      );
    }
    if (waterMasterGain) {
      waterMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      waterMasterGain.gain.linearRampToValueAtTime(
        waterTarget,
        audioCtx.currentTime + 0.8
      );
    }
  }

  function natureSoundWanted() {
    return soundCheckbox.checked || waterSoundCheckbox.checked;
  }

  function syncNaturePlayback() {
    if (!natureSoundWanted()) {
      stopNatureAudio();
      return;
    }
    ensureNatureAudio();
    if (!audioCtx || !birdMasterGain || !waterMasterGain) return;
    audioCtx.resume();

    if (soundCheckbox.checked) {
      birdPlayers.forEach((audio) => {
        audio.play().catch(() => {});
      });
    } else {
      birdPlayers.forEach((audio) => {
        audio.pause();
        audio.currentTime = 0;
      });
    }

    if (waterSoundCheckbox.checked && waterAudio) {
      waterAudio.play().catch(() => {});
    } else if (waterAudio) {
      waterAudio.pause();
      waterAudio.currentTime = 0;
    }

    updateNatureRamp();
  }

  function stopNatureAudio() {
    if (birdMasterGain && audioCtx) {
      birdMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      birdMasterGain.gain.linearRampToValueAtTime(
        0.0001,
        audioCtx.currentTime + 0.3
      );
    }
    if (waterMasterGain && audioCtx) {
      waterMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      waterMasterGain.gain.linearRampToValueAtTime(
        0.0001,
        audioCtx.currentTime + 0.3
      );
    }
    birdPlayers.forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
    if (waterAudio) {
      waterAudio.pause();
      waterAudio.currentTime = 0;
    }
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && navigator.wakeLock?.request) {
        wakeLockHandle = await navigator.wakeLock.request("screen");
        wakeLockHandle.addEventListener("release", () => {
          wakeLockHandle = null;
        });
      }
    } catch {
      /* ignore */
    }
  }

  function releaseWakeLock() {
    wakeLockHandle?.release?.();
    wakeLockHandle = null;
  }

  function clearArmPersistence() {
    localStorage.removeItem(STORAGE_KEY + ".arm");
  }

  function persistArmState() {
    if (!armedWakeAt) {
      clearArmPersistence();
      return;
    }
    localStorage.setItem(
      STORAGE_KEY + ".arm",
      JSON.stringify({
        wakeAt: armedWakeAt.toISOString(),
        duration: armedDurationMin,
        wakeMinutes: armedWakeMinutes,
      })
    );
  }

  function stopLoop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    stopNatureAudio();
    releaseWakeLock();
    armedWakeAt = null;
    armedDurationMin = 0;
    armedWakeMinutes = 0;
    clearArmPersistence();
  }

  function tryRestoreArmState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY + ".arm");
      if (!raw) return;
      const o = JSON.parse(raw);
      const wm =
        typeof o.wakeMinutes === "number" ? o.wakeMinutes : null;
      if (wm === null || wm < 0 || wm >= 24 * 60) {
        clearArmPersistence();
        return;
      }
      armedWakeMinutes = wm;
      armedDurationMin = Number(o.duration) || 30;

      const parsed = o.wakeAt ? new Date(o.wakeAt) : null;
      const now = new Date();
      if (parsed && !Number.isNaN(parsed.getTime())) {
        armedWakeAt = parsed;
        if (armedWakeAt.getTime() <= now.getTime()) {
          armedWakeAt = scheduleNextFullRamp(
            armedWakeMinutes,
            armedDurationMin,
            now
          );
        }
      } else {
        armedWakeAt = scheduleNextFullRamp(
          armedWakeMinutes,
          armedDurationMin,
          now
        );
      }
      persistArmState();
      wakeInput.value = minutesToTimeValue12(armedWakeMinutes);

      ensureAudio();
      syncNaturePlayback();
      requestWakeLock();
      ensureLoop();
      tick();
      statusEl.textContent =
        "Schedule restored — wake target " + formatDayTime12(armedWakeAt);
    } catch {
      clearArmPersistence();
    }
  }

  function tick() {
    updateNatureRamp();
    updateProgressUi();
    updateTimelineUi();
  }

  function ensureLoop() {
    if (loopTimer) return;
    loopTimer = setInterval(tick, 500);
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o.wake) wakeInput.value = o.wake;
      if (o.duration) durationSelect.value = String(o.duration);
      if (typeof o.sound === "boolean") soundCheckbox.checked = o.sound;
      if (typeof o.water === "boolean")
        waterSoundCheckbox.checked = o.water;
      const wm = parseTimeToMinutes(wakeInput.value);
      if (Number.isFinite(wm)) wakeInput.value = minutesToTimeValue12(wm);
    } catch {
      /* ignore */
    }
  }

  function saveSettings() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        wake: wakeInput.value,
        duration: Number(durationSelect.value),
        sound: soundCheckbox.checked,
        water: waterSoundCheckbox.checked,
      })
    );
  }

  btnArm.addEventListener("click", () => {
    ensureAudio();
    previewActive = false;
    previewStartMs = 0;

    const wakeMin = parseTimeToMinutes(wakeInput.value);
    if (!Number.isFinite(wakeMin)) {
      statusEl.textContent =
        "Wake time is invalid. Use 12-hour times like 7:07 AM or 8:48 PM (or 24-hour 20:48).";
      refreshScheduleUi();
      return;
    }

    let durationMin = Number(durationSelect.value);
    if (!Number.isFinite(durationMin) || durationMin < 1) durationMin = 30;
    durationMin = Math.min(180, durationMin);

    const now = new Date();
    armedWakeMinutes = wakeMin;
    armedDurationMin = durationMin;
    armedWakeAt = scheduleNextFullRamp(wakeMin, durationMin, now);
    wakeInput.value = minutesToTimeValue12(wakeMin);
    durationSelect.value = String(durationMin);
    persistArmState();
    saveSettings();

    const startAt = new Date(
      armedWakeAt.getTime() - durationMin * 60 * 1000
    );
    statusEl.textContent =
      "Armed: light ramps from " +
      formatTime12(startAt) +
      " to " +
      formatTime12(armedWakeAt) +
      " (Wake = full brightness) — " +
      armedWakeAt.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

    syncNaturePlayback();
    requestWakeLock();
    ensureLoop();
    tick();
    refreshScheduleUi();
  });

  btnPreview.addEventListener("click", () => {
    saveSettings();
    ensureAudio();
    previewActive = true;
    previewStartMs = Date.now();
    statusEl.textContent =
      "Preview running — ramps for 30 seconds, then stays bright until Arm or Disarm.";
    syncNaturePlayback();
    ensureLoop();
    tick();
    updateProgressUi();
  });

  btnDisarm.addEventListener("click", () => {
    stopLoop();
    previewActive = false;
    previewStartMs = 0;
    skyRenderer.forceBlack();
    statusEl.textContent = "Schedule cleared.";
    refreshScheduleUi();
  });

  btnFullscreen.addEventListener("click", () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  });

  soundCheckbox.addEventListener("change", () => {
    syncNaturePlayback();
    saveSettings();
  });
  waterSoundCheckbox.addEventListener("change", () => {
    syncNaturePlayback();
    saveSettings();
  });

  function refreshScheduleUi() {
    timelineTickBucket = "";
    updateTimelineUi();
    updateProgressUi();
  }

  wakeInput.addEventListener("input", refreshScheduleUi);
  wakeInput.addEventListener("change", refreshScheduleUi);
  durationSelect.addEventListener("change", refreshScheduleUi);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && armedWakeAt) {
      ensureAudio();
      requestWakeLock();
      syncNaturePlayback();
    }
  });

  loadSettings();
  tryRestoreArmState();

  const skyRenderer =
    typeof initSunriseSky === "function"
      ? initSunriseSky(skyCanvas, () => activeProgress(), "warmSunrise")
      : {
          start: function () {},
          forceBlack: function () {},
          setShader: function () {
            return false;
          },
          ok: false,
        };

  if (!skyRenderer.ok) {
    statusEl.textContent =
      "WebGL2 is not available. Use a current Safari or Chrome.";
  }
  skyRenderer.start();

  function uiFrame() {
    updateNatureRamp();
    updateProgressUi();
    updateTimelineUi();
    requestAnimationFrame(uiFrame);
  }
  requestAnimationFrame(uiFrame);

  updateProgressUi();
  updateTimelineUi();
})();

(function () {
  "use strict";

  const STORAGE_KEY = "sunriseAlarm.v1";

  const skyCanvas = document.getElementById("sky-gl");
  const wakeInput = document.getElementById("wake-time");
  const durationSelect = document.getElementById("duration");
  const soundCheckbox = document.getElementById("sound-enabled");
  const waterSoundCheckbox = document.getElementById("water-sound-enabled");
  const statusEl = document.getElementById("status");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const progressTrack = document.getElementById("progress-track");
  const btnArm = document.getElementById("btn-arm");
  const btnReset = document.getElementById("btn-reset");
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
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
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
    const raw = activeProgress();
    const pct = Math.min(100, Math.max(0, Math.round(raw * 100)));
    progressFill.style.width = pct + "%";
    progressTrack.setAttribute("aria-valuenow", String(pct));

    const now = Date.now();
    if (previewActive && now - previewStartMs < 30000) {
      progressLabel.textContent = `Preview ramp — ${pct}%`;
      return;
    }
    if (previewActive) {
      progressLabel.textContent = "Preview hold — full brightness";
      return;
    }
    if (!armedWakeAt) {
      progressLabel.textContent = "Not armed";
      return;
    }
    const t = new Date();
    const start = new Date(
      armedWakeAt.getTime() - armedDurationMin * 60 * 1000
    );
    if (t < start) {
      progressLabel.textContent =
        "Black — ramp starts " +
        start.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
    } else if (t < armedWakeAt) {
      progressLabel.textContent = `Sunrise — ${pct}%`;
    } else {
      progressLabel.textContent =
        "Full brightness — tap Reset when you're up";
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
      if (parsed && !Number.isNaN(parsed.getTime())) {
        armedWakeAt = parsed;
      } else {
        armedWakeAt = nextWakeDate(armedWakeMinutes, new Date());
      }
      persistArmState();

      ensureAudio();
      syncNaturePlayback();
      requestWakeLock();
      ensureLoop();
      tick();
      statusEl.textContent = `Schedule restored — wake target ${armedWakeAt.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    } catch {
      clearArmPersistence();
    }
  }

  function tick() {
    updateNatureRamp();
    updateProgressUi();
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
    saveSettings();
    ensureAudio();
    previewActive = false;
    previewStartMs = 0;
    const wakeMin = parseTimeToMinutes(wakeInput.value);
    const durationMin = Number(durationSelect.value);
    const now = new Date();
    armedWakeAt = nextWakeDate(wakeMin, now);
    armedDurationMin = durationMin;
    armedWakeMinutes = wakeMin;
    persistArmState();

    const startAt = new Date(
      armedWakeAt.getTime() - durationMin * 60 * 1000
    );
    statusEl.textContent = `Armed: black until ${startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, full at ${armedWakeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

    syncNaturePlayback();
    requestWakeLock();
    ensureLoop();
    tick();
    updateProgressUi();
  });

  btnReset.addEventListener("click", () => {
    if (previewActive && !armedWakeAt) {
      previewActive = false;
      previewStartMs = 0;
      skyRenderer.forceBlack();
      statusEl.textContent = "Preview cleared.";
      updateProgressUi();
      return;
    }
    if (!armedWakeAt) {
      statusEl.textContent = "Arm the alarm first.";
      return;
    }
    previewActive = false;
    previewStartMs = 0;
    saveSettings();
    armedWakeMinutes = parseTimeToMinutes(wakeInput.value);
    armedDurationMin = Number(durationSelect.value);
    armedWakeAt = nextWakeDate(armedWakeMinutes, new Date());
    persistArmState();
    statusEl.textContent = `Next sunrise: ${armedWakeAt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${armedWakeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    ensureAudio();
    syncNaturePlayback();
    requestWakeLock();
    ensureLoop();
    tick();
    updateProgressUi();
  });

  btnPreview.addEventListener("click", () => {
    saveSettings();
    ensureAudio();
    previewActive = true;
    previewStartMs = Date.now();
    statusEl.textContent =
      "Preview running — ramps for 30 seconds, then stays bright until Reset or Disarm.";
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
    updateProgressUi();
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && armedWakeAt) {
      ensureAudio();
      requestWakeLock();
      syncNaturePlayback();
    }
  });

  loadSettings();

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
  skyRenderer.forceBlack();

  function uiFrame() {
    updateNatureRamp();
    updateProgressUi();
    requestAnimationFrame(uiFrame);
  }
  requestAnimationFrame(uiFrame);

  tryRestoreArmState();
  updateProgressUi();
})();

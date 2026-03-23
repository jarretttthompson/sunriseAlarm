/**
 * WebGL2 sky renderer (warm sunrise scene).
 * u_brightness 0 = black, 1 = full scene.
 */
(function (global) {
  "use strict";

  const VERT = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_fragCoord;
uniform vec2 u_resolution;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_fragCoord = vec2(
    (a_position.x * 0.5 + 0.5) * u_resolution.x,
    (a_position.y * 0.5 + 0.5) * u_resolution.y
  );
}
`;

  const FRAG_WARM_SUNRISE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_brightness;
in vec2 v_fragCoord;
out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  fp = smoothstep(0.0, 1.0, fp);
  return mix(
    mix(hash12(ip + vec2(0.0, 0.0)), hash12(ip + vec2(1.0, 0.0)), fp.x),
    mix(hash12(ip + vec2(0.0, 1.0)), hash12(ip + vec2(1.0, 1.0)), fp.x),
    fp.y
  );
}

float fbm8(vec2 p) {
  float a = 1.0;
  float t = 0.0;
  mat2 rot = mat2(vec2(3.0, 4.0), vec2(-4.0, 3.0)) * 0.4;
  for (int i = 0; i < 8; i++) {
    p += vec2(13.102, 1.535);
    t += a * noise(p);
    p = p * rot;
    a *= 0.5;
  }
  return 0.5 * t;
}

float fbm3(vec2 p) {
  float a = 1.0;
  float t = 0.0;
  mat2 rot = mat2(vec2(3.0, 4.0), vec2(-4.0, 3.0)) * 0.4;
  for (int i = 0; i < 3; i++) {
    p += vec2(13.102, 1.535);
    t += a * noise(p);
    p = p * rot;
    a *= 0.5;
  }
  return 0.5 * t;
}

void main() {
  vec2 fragCoord = v_fragCoord;
  vec2 iResolution = u_resolution;
  float iTime = u_time;
  float sunriseT = smoothstep(0.0, 1.0, u_brightness);
  vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

  float mtHeight = fbm8(uv.xx + 0.6);
  float mtHeightSm = fbm3(uv.xx + 0.6);
  vec3 col = vec3(0.0);
  vec2 sunPos = vec2(0.45, mix(-0.95, 0.28, sunriseT));
  vec3 skyCol = vec3(0.10, 0.08, 0.11);
  float q = uv.y - sunPos.y;
  float q2 = uv.x - sunPos.x;
  skyCol = mix(skyCol, vec3(0.42, 0.28, 0.26), exp(-0.5 * q * q - 0.2 * q2 * q2));
  vec3 cloudCol = mix(skyCol, vec3(0.58, 0.50, 0.44), 0.12);
  skyCol = mix(skyCol, vec3(0.70, 0.46, 0.30), exp(-q * q * 3.0 - 0.5 * q2 * q2));
  skyCol = mix(skyCol, vec3(0.95, 0.70, 0.42), exp(-q * q * 10.0 - 0.5 * q2 * q2));
  skyCol = mix(skyCol, vec3(1.0, 0.92, 0.70), exp(-3.0 * length(uv - sunPos)));
  vec3 cloudCol3 = mix(vec3(0.70, 0.47, 0.33), vec3(0.98, 0.86, 0.66), exp(-1.9 * length(uv - sunPos)));
  cloudCol3 = mix(cloudCol3, cloudCol, smoothstep(0.0, -1.0, uv.y + 0.3 * uv.x));

  float w = 1.5 * length(fwidth(uv));
  float isSky = smoothstep(0.0, w, uv.y + 0.3 * uv.x + 0.2 * max(uv.x, 0.0) + 1.0 - mtHeight);
  col = mix(col, skyCol, isSky);
  col = mix(col, skyCol, 0.5 * smoothstep(-0.5, 0.1, uv.y + 0.3 * uv.x + 0.2 * max(uv.x, 0.0) + 1.0 - mtHeightSm));

  vec2 fuv = fract(0.1 * uv);
  vec2 uvv = 20.0 * fuv * (1.0 - fuv) * (0.5 - fuv);
  uvv = vec2(1.0, -1.0) * uvv.yx;
  vec2 uv2 = uv + uvv * cos(0.1 * iTime);

  float silver = fbm8(30.0 * uv - 0.06 * iTime) + 30.0 * (uv.y + 0.8);
  silver = smoothstep(0.0, 1.0, silver) * smoothstep(2.0, 1.0, silver) * 1.0 / (1.0 + 500.0 * q2 * q2) * isSky;
  col += silver * vec3(0.95, 0.66, 0.36) * 58.0;

  float lowClouds = fbm8(5.0 * uv + 0.1 * iTime);
  float midClouds = fbm8(3.0 * uv + vec2(0.06, -0.03) * iTime);
  float hiClouds = fbm8(uv2 + vec2(0.1, 0.01) * iTime) - 0.5;
  float hiClouds2 = fbm8(uv + 10.0 + vec2(0.062, -0.03) * iTime) - 0.5;
  col = mix(col, cloudCol3, 0.24 * smoothstep(0.0, 1.0, -uv.y + 3.0 * hiClouds));
  col = mix(col, cloudCol3, 0.24 * smoothstep(0.0, 1.0, -uv.y + 3.0 * hiClouds2));

  float sunCore = 1.0 / (1.0 + 2200.0 * (q * q + q2 * q2));
  float sunHalo = 1.0 / (1.0 + 8.0 * sqrt(q * q + 0.3 * q2 * q2));
  float skyMask = smoothstep(0.0, 1.0, isSky);
  col = mix(col, vec3(1.0, 0.82, 0.52) * 120.0, sunCore * skyMask);
  col += vec3(1.0, 0.70, 0.36) * 4.2 * sunHalo * skyMask;
  col = mix(col, 0.74 * cloudCol, 0.40 * smoothstep(0.0, 1.0, -2.0 * (uv.y + 0.5) + midClouds));
  col = mix(col, 0.56 * cloudCol, 0.56 * smoothstep(0.0, 1.0, -3.0 * (uv.y + 0.8) + lowClouds));

  float sunDist = length(uv - sunPos);
  float sunDisc = 1.0 - smoothstep(0.082, 0.090, sunDist);
  sunDisc *= smoothstep(0.02, 0.25, sunriseT);
  float rim = smoothstep(0.095, 0.089, sunDist) - smoothstep(0.089, 0.082, sunDist);
  col = mix(col, vec3(1.0, 0.93, 0.74) * 1.45, sunDisc * skyMask);
  col += vec3(1.0, 0.82, 0.54) * 0.55 * rim * skyMask;

  col = mix(col, col * pow(col / (col.r + col.g + col.b + 0.001), vec3(dot(uv, uv) * 0.3)), 0.2);
  col *= mix(0.72, 1.85, sunriseT);
  col = pow(col, vec3(2.2));
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(col, vec3(1.0 / 2.2));
  col += vec3(1.0, 0.84, 0.58) * 0.12 * sunHalo * skyMask * sunriseT;
  col = min(col, vec3(1.62));
  col += 0.03 * (hash12(fragCoord) - 0.5) * sqrt(iResolution.y / 400.0);
  col = mix(vec3(0.0), col, clamp(u_brightness, 0.0, 1.0));
  fragColor = vec4(col, 1.0);
}
`;

  const SHADERS = {
    warmSunrise: FRAG_WARM_SUNRISE,
  };

  function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(sh) || "compile failed";
      gl.deleteShader(sh);
      throw new Error(msg);
    }
    return sh;
  }

  function createProgram(gl, vertSrc, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const msg = gl.getProgramInfoLog(prog) || "link failed";
      gl.deleteProgram(prog);
      throw new Error(msg);
    }
    return prog;
  }

  function initSunriseSky(canvas, getBrightness, initialShaderId) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      return {
        start: function () {},
        stop: function () {},
        forceBlack: function () {},
        setShader: function () {
          return false;
        },
        ok: false,
      };
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    let currentProgram = null;
    let currentLoc = null;
    let currentShaderId = "warmSunrise";
    let rafId = 0;
    let running = false;
    let forceBlackUntilNextFrame = false;

    function useShader(shaderId) {
      const src = SHADERS[shaderId];
      if (!src) return false;
      try {
        const nextProgram = createProgram(gl, VERT, src);
        if (currentProgram) {
          gl.deleteProgram(currentProgram);
        }
        currentProgram = nextProgram;
        currentLoc = {
          resolution: gl.getUniformLocation(currentProgram, "u_resolution"),
          time: gl.getUniformLocation(currentProgram, "u_time"),
          brightness: gl.getUniformLocation(currentProgram, "u_brightness"),
        };
        currentShaderId = shaderId;
        return true;
      } catch {
        return false;
      }
    }

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function frame(nowMs) {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      resize();
      let b = forceBlackUntilNextFrame ? 0 : getBrightness();
      forceBlackUntilNextFrame = false;
      b = Math.min(1, Math.max(0, b));
      if (b < 1e-5) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      gl.useProgram(currentProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(currentLoc.resolution, canvas.width, canvas.height);
      gl.uniform1f(currentLoc.time, nowMs * 0.001);
      gl.uniform1f(currentLoc.brightness, b);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (!useShader(initialShaderId || "warmSunrise")) {
      useShader("warmSunrise");
    }

    return {
      ok: true,
      start: function () {
        if (running) return;
        running = true;
        rafId = requestAnimationFrame(frame);
      },
      stop: function () {
        running = false;
        cancelAnimationFrame(rafId);
      },
      forceBlack: function () {
        forceBlackUntilNextFrame = true;
        resize();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      setShader: function (shaderId) {
        const prev = currentShaderId;
        if (useShader(shaderId)) return true;
        useShader(prev || "warmSunrise");
        return false;
      },
    };
  }

  global.initSunriseSky = initSunriseSky;
})(typeof window !== "undefined" ? window : globalThis);

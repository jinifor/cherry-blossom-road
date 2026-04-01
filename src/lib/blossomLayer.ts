import maplibregl from "maplibre-gl";

type BlossomLayerOptions = {
  id?: string;
  opacity?: number;
  petalCount?: number;
};

const FLOAT_SIZE = 4;
const STRIDE = 9 * FLOAT_SIZE;

const vertexShaderSource = `
precision highp float;

attribute vec2 a_seed;
attribute float a_size;
attribute float a_speed;
attribute float a_sway;
attribute float a_phase;
attribute float a_spin;
attribute float a_tone;
attribute float a_drift;

uniform float u_time;
uniform float u_pixel_ratio;
uniform float u_opacity;

varying float v_tone;
varying float v_alpha;
varying float v_rotation;

void main() {
  float fall = fract(a_seed.y + u_time * a_speed);
  float sway = sin((u_time * (0.7 + a_speed * 1.2)) + a_phase) * a_sway;
  float drift = u_time * (0.006 + a_speed * 0.008) * a_drift + sway + sin((u_time * 0.45) + a_phase * 1.7) * 0.015 * a_drift;

  float x = fract(a_seed.x + drift);
  float y = fall;

  vec2 clip = vec2(x * 2.0 - 1.0, 1.0 - y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);

  float shimmer = 0.92 + sin(u_time * 1.8 + a_phase) * 0.08;
  gl_PointSize = a_size * u_pixel_ratio * shimmer;

  float fadeIn = smoothstep(0.0, 0.08, y);
  float fadeOut = 1.0 - smoothstep(0.84, 1.0, y);
  v_alpha = fadeIn * fadeOut * u_opacity;
  v_tone = a_tone;
  v_rotation = u_time * (0.45 + a_spin * 1.2) + a_phase;
}
`;

const fragmentShaderSource = `
precision highp float;

varying float v_tone;
varying float v_alpha;
varying float v_rotation;

mat2 rotate2d(float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c);
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  vec2 p = rotate2d(v_rotation) * uv;
  p.y += 0.05;

  float body = 1.0 - smoothstep(0.74, 0.98, length(vec2(p.x * 0.92, p.y * 1.2)));
  float taper = 1.0 - smoothstep(0.18, 0.72, p.y + abs(p.x) * 0.72);
  float petal = body * taper;

  if (petal < 0.02) {
    discard;
  }

  vec3 colorA = vec3(1.0, 0.85, 0.91);
  vec3 colorB = vec3(0.99, 0.71, 0.82);
  vec3 veinColor = vec3(0.92, 0.49, 0.66);
  vec3 highlightColor = vec3(1.0, 0.95, 0.98);

  vec3 base = mix(colorA, colorB, v_tone);
  float highlight = smoothstep(0.75, -0.1, p.y) * (1.0 - smoothstep(0.08, 0.62, abs(p.x)));
  vec3 color = mix(base, highlightColor, highlight * 0.28);

  float vein = smoothstep(0.08, 0.0, abs(p.x)) * smoothstep(0.82, -0.3, p.y);
  color = mix(color, veinColor, vein * 0.2);

  float alpha = petal * v_alpha;
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

export function createBlossomLayer(options: BlossomLayerOptions = {}): maplibregl.CustomLayerInterface {
  const particleCount = options.petalCount ?? getParticleCount();
  const opacity = options.opacity ?? 0.8;

  let map: maplibregl.Map | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let startTime = 0;

  let aSeedLocation = -1;
  let aSizeLocation = -1;
  let aSpeedLocation = -1;
  let aSwayLocation = -1;
  let aPhaseLocation = -1;
  let aSpinLocation = -1;
  let aToneLocation = -1;
  let aDriftLocation = -1;

  let uTimeLocation: WebGLUniformLocation | null = null;
  let uPixelRatioLocation: WebGLUniformLocation | null = null;
  let uOpacityLocation: WebGLUniformLocation | null = null;

  return {
    id: options.id ?? "blossom-petals",
    type: "custom",
    renderingMode: "2d",
    onAdd(nextMap, gl) {
      map = nextMap;
      startTime = performance.now();

      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      program = linkProgram(gl, vertexShader, fragmentShader);

      aSeedLocation = gl.getAttribLocation(program, "a_seed");
      aSizeLocation = gl.getAttribLocation(program, "a_size");
      aSpeedLocation = gl.getAttribLocation(program, "a_speed");
      aSwayLocation = gl.getAttribLocation(program, "a_sway");
      aPhaseLocation = gl.getAttribLocation(program, "a_phase");
      aSpinLocation = gl.getAttribLocation(program, "a_spin");
      aToneLocation = gl.getAttribLocation(program, "a_tone");
      aDriftLocation = gl.getAttribLocation(program, "a_drift");

      uTimeLocation = gl.getUniformLocation(program, "u_time");
      uPixelRatioLocation = gl.getUniformLocation(program, "u_pixel_ratio");
      uOpacityLocation = gl.getUniformLocation(program, "u_opacity");

      buffer = gl.createBuffer();
      if (!buffer) {
        throw new Error("벚꽃 파티클 버퍼를 만들지 못했습니다.");
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, buildParticleBuffer(particleCount), gl.STATIC_DRAW);
    },
    render(gl) {
      if (!map || !program || !buffer) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

      enableAttribute(gl, aSeedLocation, 2, STRIDE, 0);
      enableAttribute(gl, aSizeLocation, 1, STRIDE, 2 * FLOAT_SIZE);
      enableAttribute(gl, aSpeedLocation, 1, STRIDE, 3 * FLOAT_SIZE);
      enableAttribute(gl, aSwayLocation, 1, STRIDE, 4 * FLOAT_SIZE);
      enableAttribute(gl, aPhaseLocation, 1, STRIDE, 5 * FLOAT_SIZE);
      enableAttribute(gl, aSpinLocation, 1, STRIDE, 6 * FLOAT_SIZE);
      enableAttribute(gl, aToneLocation, 1, STRIDE, 7 * FLOAT_SIZE);
      enableAttribute(gl, aDriftLocation, 1, STRIDE, 8 * FLOAT_SIZE);

      gl.uniform1f(uTimeLocation, (performance.now() - startTime) / 1000);
      gl.uniform1f(uPixelRatioLocation, Math.min(window.devicePixelRatio || 1, 2));
      gl.uniform1f(uOpacityLocation, opacity);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.drawArrays(gl.POINTS, 0, particleCount);

      map.triggerRepaint();
    },
    onRemove(_, gl) {
      if (buffer) {
        gl.deleteBuffer(buffer);
        buffer = null;
      }
      if (program) {
        gl.deleteProgram(program);
        program = null;
      }
    },
  };
}

function buildParticleBuffer(particleCount: number) {
  const data = new Float32Array(particleCount * 9);

  for (let index = 0; index < particleCount; index += 1) {
    const offset = index * 9;
    data[offset] = Math.random();
    data[offset + 1] = Math.random();
    data[offset + 2] = randomBetween(9, 18);
    data[offset + 3] = randomBetween(0.024, 0.058);
    data[offset + 4] = randomBetween(0.01, 0.03);
    data[offset + 5] = randomBetween(0, Math.PI * 2);
    data[offset + 6] = randomBetween(0.28, 0.82);
    data[offset + 7] = randomBetween(0.0, 1.0);
    data[offset + 8] = randomSignedBetween(0.45, 1.0);
  }

  return data;
}

function enableAttribute(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
) {
  if (location < 0) return;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("벚꽃 셰이더를 만들지 못했습니다.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`벚꽃 셰이더 컴파일 실패: ${message}`);
  }

  return shader;
}

function linkProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
) {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("벚꽃 셰이더 프로그램을 만들지 못했습니다.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`벚꽃 셰이더 링크 실패: ${message}`);
  }

  return program;
}

function getParticleCount() {
  if (typeof window === "undefined") return 54;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 18;
  if (window.matchMedia("(max-width: 760px)").matches) return 34;
  return 54;
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomSignedBetween(min: number, max: number) {
  const value = randomBetween(min, max);
  return Math.random() > 0.5 ? value : -value;
}

import { Effect } from "@babylonjs/core/Materials/effect.js";

/**
 * Hand-written, unlit shaders. Lighting is baked into vertex colours, so the
 * whole static world is one mesh, one material and one draw call, which keeps
 * integrated GPUs comfortable.
 */

const FOG = /* glsl */ `
uniform vec3 fogColor;
uniform float fogDensity;
vec3 applyFog(vec3 color, float dist) {
  float f = 1.0 - exp(-pow(dist * fogDensity, 2.0));
  return mix(color, fogColor, clamp(f, 0.0, 1.0));
}`;

Effect.ShadersStore["worldVertexShader"] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 color;
uniform mat4 worldViewProjection;
uniform vec3 cameraPos;
varying vec4 vColor;
varying float vDist;
varying float vHeight;
void main() {
  gl_Position = worldViewProjection * vec4(position, 1.0);
  vColor = color;
  vDist = distance(position, cameraPos);
  vHeight = position.y;
}`;

Effect.ShadersStore["worldFragmentShader"] = /* glsl */ `
precision highp float;
varying vec4 vColor;
varying float vDist;
varying float vHeight;
${FOG}
void main() {
  vec3 c = vColor.rgb;
  // Slightly darken surfaces near the waterline so islands sit in the sea.
  c *= mix(0.78, 1.0, smoothstep(-2.0, 3.0, vHeight));
  gl_FragColor = vec4(applyFog(c, vDist), 1.0);
}`;

Effect.ShadersStore["oceanVertexShader"] = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
varying vec3 vWorld;
varying float vWave;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  float w = sin(wp.x * 0.045 + time * 0.9) * 0.5 + sin(wp.z * 0.06 - time * 1.1) * 0.5
          + sin((wp.x + wp.z) * 0.12 + time * 1.7) * 0.25;
  wp.y += w * 0.18;
  vWave = w;
  vWorld = wp.xyz;
  gl_Position = viewProjection * wp;
}`;

Effect.ShadersStore["oceanFragmentShader"] = /* glsl */ `
precision highp float;
uniform vec3 cameraPos;
uniform vec3 sunDir;
uniform float rimZ;
uniform float time;
/** Island outlines (x, z, radius, wobble seed), matching the terrain's hex outlines. */
uniform vec4 isles[ISLE_COUNT];
/** 1 in the overworld (coasts, harbour), 0 in dungeon arenas. */
uniform float coasts;
varying vec3 vWorld;
varying float vWave;
${FOG}

float wobble(float a, float seed) {
  return 1.0 + 0.07 * sin(a * 3.0 + seed) + 0.05 * sin(a * 5.0 + seed * 2.3) + 0.03 * sin(a * 9.0 + seed * 4.1);
}

/** Metres from the nearest coast (negative inside land). */
float coastDistance(vec2 p) {
  float d = 1e4;
  for (int i = 0; i < ISLE_COUNT; i++) {
    vec2 q = p - isles[i].xy;
    float r = isles[i].z * wobble(atan(q.y, q.x), isles[i].w);
    d = min(d, length(q) - r);
  }
  // First Harbour: a rounded square island with the dock shelf on its south side.
  vec2 h = abs(p) / vec2(118.0, 102.0);
  float f = pow(pow(h.x, 2.4) + pow(h.y, 2.4), 1.0 / 2.4);
  float hw = pow(wobble(atan(p.y, p.x), 0.7), 1.0 / 2.4);
  d = min(d, (f - hw) * 108.0);
  float shelfHalf = 86.0 - 28.0 * pow(clamp((p.y - 86.0) / 40.0, 0.0, 1.0), 2.0);
  vec2 s = vec2(abs(p.x) - shelfHalf, max(86.0 - p.y, p.y - 126.0));
  d = min(d, length(max(s, 0.0)) + min(max(s.x, s.y), 0.0));
  return d;
}

void main() {
  if (vWorld.z < rimZ) discard;
  vec3 deep = vec3(0.08, 0.33, 0.52);
  vec3 mid = vec3(0.16, 0.52, 0.66);
  vec3 reef = vec3(0.28, 0.74, 0.74);
  vec3 bright = vec3(0.62, 0.86, 0.92);
  float dist = distance(vWorld, cameraPos);
  // Broad bands of colour that brighten toward the rim.
  float toRim = clamp(1.0 - (vWorld.z - rimZ) / 900.0, 0.0, 1.0);
  float band = floor((vWave * 0.5 + 0.5) * 3.0) / 3.0;
  vec3 c = mix(deep, mid, band * 0.6);

  // Turquoise shallows and rolling surf around the islands.
  float foam = 0.0;
  if (coasts > 0.5) {
    float d = coastDistance(vWorld.xz);
    float shallow = smoothstep(34.0, 2.0, d);
    c = mix(c, reef, shallow * 0.75);
    float n = sin(vWorld.x * 0.21 + vWorld.z * 0.17) * 0.5 + sin(vWorld.x * 0.07 - vWorld.z * 0.11 + time * 0.3) * 0.5;
    float roll = sin(d * 0.9 - time * 1.8 + n * 2.0) * 0.5 + 0.5;
    foam = smoothstep(7.0, 0.5, d) * (0.45 + 0.55 * step(0.62, roll));
    foam = max(foam, smoothstep(2.2, 0.0, d));
  }
  c = mix(c, bright, toRim * toRim * 0.7);

  // Small ripples catch the sun; the sky shows at grazing angles.
  vec3 v = normalize(cameraPos - vWorld);
  vec2 rp = vWorld.xz;
  vec2 slope = vec2(
    cos(rp.x * 0.9 + time * 2.1) * 0.05 + cos((rp.x + rp.y) * 0.53 - time * 1.4) * 0.05 + cos(rp.x * 0.045 + time * 0.9) * 0.012,
    cos(rp.y * 0.8 - time * 1.9) * 0.05 + cos((rp.x - rp.y) * 0.61 + time * 1.2) * 0.05 + cos(rp.y * 0.06 - time * 1.1) * 0.015);
  // Fine ripples fade out with distance (they'd only shimmer as moiré out there).
  slope *= smoothstep(520.0, 60.0, dist);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  float fresnel = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  c = mix(c, vec3(0.70, 0.84, 0.95), fresnel * 0.45);
  float glint = pow(max(dot(reflect(-v, n), normalize(sunDir)), 0.0), 220.0);
  c += vec3(1.0, 0.95, 0.85) * glint * 1.6 * smoothstep(1400.0, 200.0, dist);

  // Foam on crests, around the islands and at the very edge.
  foam = max(foam, step(1.05, vWave) * 0.35);
  foam = max(foam, smoothstep(rimZ + 25.0, rimZ, vWorld.z) * 0.8);
  c = mix(c, vec3(0.96, 0.98, 1.0), foam * 0.9);
  gl_FragColor = vec4(applyFog(c, dist), 1.0);
}`;

Effect.ShadersStore["waterfallVertexShader"] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vWorld;
varying vec2 vUV;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vWorld = wp.xyz;
  vUV = uv;
  gl_Position = viewProjection * wp;
}`;

Effect.ShadersStore["waterfallFragmentShader"] = /* glsl */ `
precision highp float;
uniform vec3 cameraPos;
uniform float time;
varying vec3 vWorld;
varying vec2 vUV;
${FOG}
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  // Vertical streaks that scroll downward.
  float col = floor(vWorld.x * 0.35);
  float speed = 18.0 + hash(col) * 14.0;
  float s = fract((vWorld.y + time * speed) * 0.02 + hash(col + 7.0));
  float streak = smoothstep(0.0, 0.25, s) * (1.0 - smoothstep(0.55, 1.0, s));
  vec3 c = mix(vec3(0.55, 0.80, 0.92), vec3(0.97, 0.99, 1.0), streak * 0.8);
  // Fades into mist as it falls.
  float alpha = mix(0.92, 0.0, smoothstep(-20.0, -260.0, vWorld.y));
  gl_FragColor = vec4(applyFog(c, distance(vWorld, cameraPos) * 0.6), alpha);
}`;

Effect.ShadersStore["skyVertexShader"] = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore["skyFragmentShader"] = /* glsl */ `
precision highp float;
uniform vec3 fogColor;
uniform vec3 sunDir;
varying vec3 vDir;
void main() {
  vec3 zenith = vec3(0.32, 0.58, 0.86);
  float h = clamp(vDir.y, -1.0, 1.0);
  vec3 c = mix(fogColor, zenith, smoothstep(0.0, 0.55, h));
  // Below the horizon, a darker band of distant sea.
  c = mix(c, vec3(0.30, 0.52, 0.66), smoothstep(0.0, -0.25, h));
  float sun = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
  c += vec3(1.0, 0.92, 0.7) * (pow(sun, 400.0) * 1.5 + pow(sun, 12.0) * 0.18);
  gl_FragColor = vec4(c, 1.0);
}`;

export const FOG_COLOR = [0.78, 0.88, 0.95] as const;

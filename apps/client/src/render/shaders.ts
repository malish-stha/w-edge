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
uniform float rimZ;
uniform float time;
varying vec3 vWorld;
varying float vWave;
${FOG}
void main() {
  if (vWorld.z < rimZ) discard;
  vec3 deep = vec3(0.10, 0.36, 0.55);
  vec3 shallow = vec3(0.20, 0.58, 0.70);
  vec3 bright = vec3(0.62, 0.86, 0.92);
  // Broad bands of colour that brighten toward the rim.
  float toRim = clamp(1.0 - (vWorld.z - rimZ) / 900.0, 0.0, 1.0);
  float band = floor((vWave * 0.5 + 0.5) * 3.0) / 3.0;
  vec3 c = mix(deep, shallow, band * 0.6);
  c = mix(c, bright, toRim * toRim * 0.7);
  // Foam on crests and at the very edge.
  float foam = step(1.05, vWave) * 0.35 + smoothstep(rimZ + 25.0, rimZ, vWorld.z) * 0.8;
  c = mix(c, vec3(0.95), foam);
  gl_FragColor = vec4(applyFog(c, distance(vWorld, cameraPos)), 1.0);
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

import { FULL_VS } from '../engine/shaders.js';

export const DEFAULT_CANVAS_FRAME = Object.freeze({ enabled: false, style: 'solid', color: '#202838', color2: '#516a96', padding: 0.08, radius: 0.04 });
export function normalizeCanvasFrame(p) {
  const fraction = (n, max) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  const color = (s) => typeof s === 'string' && /^#[\da-f]{6}$/i.test(s);
  if (!p || typeof p.enabled !== 'boolean' || !['solid', 'gradient'].includes(p.style)
    || !color(p.color) || !color(p.color2) || !fraction(p.padding, 0.2) || !fraction(p.radius, 0.1)) return null;
  const { enabled, style, color: c, color2, padding, radius } = p;
  return { enabled, style, color: c, color2, padding, radius };
}

/** Uniformly fit the whole composition. Padding and corners use output short-side units. */
export function canvasFrameRect(width, height, frame) {
  const short = Math.min(width, height), padding = frame?.enabled ? frame.padding * short : 0;
  const scale = Math.min((width - 2 * padding) / width, (height - 2 * padding) / height);
  return { x: (width - width * scale) / 2, y: (height - height * scale) / 2, width: width * scale, height: height * scale, scale,
    radius: frame?.enabled ? Math.min(frame.radius * short, width * scale / 2, height * scale / 2) : 0 };
}

const FRAME_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec4 u_frame;
uniform float u_radius;
uniform vec3 u_color, u_color2;
uniform bool u_gradient;
out vec4 outColor;
void main() {
  vec2 pixel = v_uv * u_res;
  vec2 local = pixel - u_frame.xy;
  vec2 halfSize = u_frame.zw * 0.5;
  vec2 q = abs(local - halfSize) - halfSize + u_radius;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
  float alpha = 1.0 - smoothstep(-0.5, 0.5, distance);
  // Bottom-left to top-right, in the output's aspect ratio.
  float blend = u_gradient ? dot(pixel, u_res) / dot(u_res, u_res) : 0.0;
  vec3 background = mix(u_color, u_color2, blend);
  vec3 scene = texture(u_tex, clamp(local / u_frame.zw, 0.0, 1.0)).rgb;
  outColor = vec4(mix(background, scene, alpha), 1.0);
}`;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Final shared preview/export pass, after every layer, transition and global effect. */
export function presentCanvasFrame(comp, texture, frame) {
  if (!frame?.enabled) { comp._copy(texture); return; }
  const rect = canvasFrameRect(comp.width, comp.height, frame);
  const p = comp._use(comp._program('canvas-frame', FULL_VS, FRAME_FS));
  comp._set(p, 'u_res', comp.width, comp.height);
  comp._set(p, 'u_frame', [rect.x, rect.y, rect.width, rect.height]);
  comp._set(p, 'u_radius', rect.radius);
  comp._set(p, 'u_color', rgb(frame.color));
  comp._set(p, 'u_color2', rgb(frame.color2));
  comp._set(p, 'u_gradient', frame.style === 'gradient');
  comp._seti(p, 'u_tex', 0);
  comp._bindTex(0, texture);
  comp._fullPass(p);
}

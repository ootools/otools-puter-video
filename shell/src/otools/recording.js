/** Recording extension v1. Source times are seconds; editor times are microseconds. */
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const color = (v) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const prepared = new WeakMap();
export function recordingSamples(p) {
  let cached = prepared.get(p.pointer);
  if (cached) return cached;
  const points = [], clicks = [];
  let buttons = 0;
  for (const s of p.pointer) {
    const prev = points[points.length - 1];
    const decay = prev ? Math.exp(-(s.t - prev.t) / 0.22) : 0;
    points.push({ ...s, sx: prev ? prev.x + (prev.sx - prev.x) * decay : s.x, sy: prev ? prev.y + (prev.sy - prev.y) * decay : s.y });
    if ((s.buttons & ~buttons) !== 0 && s.visible !== false) clicks.push(s);
    buttons = s.buttons;
  }
  cached = { points, clicks };
  prepared.set(p.pointer, cached);
  return cached;
}
export function recordingPointer(points, t) {
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].t <= t) low = mid + 1; else high = mid; }
  const s = points[Math.max(0, low - 1)];
  if (!s) return { x: 0.5, y: 0.5, rawX: 0.5, rawY: 0.5, visible: false };
  const decay = Math.exp(-Math.max(0, t - s.t) / 0.22);
  return { x: s.x + (s.sx - s.x) * decay, y: s.y + (s.sy - s.y) * decay, rawX: s.x, rawY: s.y, visible: s.visible !== false };
}
export function recordingViewport(p, t) {
  const z = p.zooms.find((z) => t >= z.start && t <= z.end);
  if (!z) return { x: 0, y: 0, width: 1, height: 1, scale: 1 };
  const ramp = Math.min(0.35, (z.end - z.start) / 2);
  const amount = clamp(Math.min((t - z.start) / ramp, (z.end - t) / ramp));
  const scale = 1 + (z.scale - 1) * amount * amount * (3 - 2 * amount);
  const width = 1 / scale;
  const pointer = recordingPointer(recordingSamples(p).points, t);
  return { x: clamp((z.follow ? pointer.x : z.x) - width / 2, 0, 1 - width), y: clamp((z.follow ? pointer.y : z.y) - width / 2, 0, 1 - width), width, height: width, scale };
}

/** Keep only validated, owned data: malformed extensions never break ordinary media. */
export function normalizeRecording(value) {
  if (!value || value.version !== 1 || !['screen', 'camera'].includes(value.role)) return null;
  const p = value.data;
  if (!p || p.version !== 1 || !finite(p.width, 16, 7680) || !Number.isInteger(p.width)
    || !finite(p.height, 16, 7680) || !Number.isInteger(p.height) || !finite(p.fps, 1, 60)
    || !finite(p.duration, 0.01, 21600) || !Array.isArray(p.pointer) || p.pointer.length > 2_000_000
    || !Array.isArray(p.zooms) || p.zooms.length > 10000) return null;
  let last = -1;
  for (const s of p.pointer) {
    if (!s || !finite(s.t, 0, p.duration) || s.t < last || !finite(s.x, 0, 1) || !finite(s.y, 0, 1)
      || !finite(s.buttons, 0, 7) || !Number.isInteger(s.buttons) || (s.visible !== undefined && typeof s.visible !== 'boolean')) return null;
    last = s.t;
  }
  last = 0;
  const ids = new Set();
  for (const z of p.zooms) {
    if (!z || typeof z.id !== 'string' || !z.id || ids.has(z.id) || !finite(z.start, last, p.duration)
      || !finite(z.end, z.start + 0.01, p.duration) || !finite(z.scale, 1, 6) || !finite(z.x, 0, 1)
      || !finite(z.y, 0, 1) || typeof z.follow !== 'boolean') return null;
    last = z.end;
    ids.add(z.id);
  }
  const b = p.background, c = p.camera;
  if (!b || !['solid', 'gradient'].includes(b.style) || !color(b.color) || !color(b.color2)
    || !finite(b.padding, 0, 0.2) || !finite(b.radius, 0, 0.1) || !c || typeof c.enabled !== 'boolean'
    || !finite(c.x, 0, 1) || !finite(c.y, 0, 1) || !finite(c.size, 0.05, 0.5) || !finite(c.roundness, 0, 1)
    || typeof p.showPointer !== 'boolean' || typeof p.clickEffects !== 'boolean') return null;
  return { version: 1, role: value.role, data: {
    version: 1, width: p.width, height: p.height, fps: p.fps, duration: p.duration,
    pointer: p.pointer.map(({ t, x, y, buttons, visible }) => ({ t, x, y, buttons, ...(visible !== undefined ? { visible } : {}) })),
    zooms: p.zooms.map(({ id, start, end, scale, follow, x, y }) => ({ id, start, end, scale, follow, x, y })),
    background: { style: b.style, color: b.color, color2: b.color2, padding: b.padding, radius: b.radius },
    camera: { enabled: c.enabled, x: c.x, y: c.y, size: c.size, roundness: c.roundness },
    showPointer: p.showPointer, clickEffects: p.clickEffects,
  } };
}

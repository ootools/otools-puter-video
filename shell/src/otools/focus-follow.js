/** Generic video focus paths. Source times are seconds; editor times are microseconds. */
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

export function defaultFocusFollow(clip, asset = {}) {
  return {
    version: 1, enabled: false,
    sourceDuration: Math.max(0.01, (asset.duration || clip.in + clip.duration * (clip.speed || 1)) / 1e6),
    sourceWidth: asset.width || 1920, sourceHeight: asset.height || 1080,
    smoothing: 0.22, points: [], segments: [], showPointer: false, clickEffects: false,
  };
}

/** Keep only validated, owned data: malformed effects never break ordinary media. */
export function normalizeFocusFollow(p) {
  if (!p || p.version !== 1 || typeof p.enabled !== 'boolean'
    || !finite(p.sourceWidth, 1, 65536) || !Number.isInteger(p.sourceWidth)
    || !finite(p.sourceHeight, 1, 65536) || !Number.isInteger(p.sourceHeight)
    || !finite(p.sourceDuration, 0.01, Number.MAX_SAFE_INTEGER / 1e6) || !finite(p.smoothing ?? 0.22, 0, 2)
    || !Array.isArray(p.points) || p.points.length > 2_000_000
    || !Array.isArray(p.segments) || p.segments.length > 10000
    || typeof p.showPointer !== 'boolean' || typeof p.clickEffects !== 'boolean') return null;
  let last = -1;
  for (const s of p.points) {
    if (!s || !finite(s.t, 0, p.sourceDuration) || s.t < last || !finite(s.x, 0, 1) || !finite(s.y, 0, 1)
      || (s.buttons !== undefined && (!finite(s.buttons, 0, 7) || !Number.isInteger(s.buttons)))
      || (s.visible !== undefined && typeof s.visible !== 'boolean')) return null;
    last = s.t;
  }
  last = 0;
  const ids = new Set();
  for (const z of p.segments) {
    if (!z || typeof z.id !== 'string' || !z.id || ids.has(z.id) || !finite(z.start, last, p.sourceDuration)
      || !finite(z.end, z.start + 0.01, p.sourceDuration) || !finite(z.scale, 1, 6)
      || !finite(z.x, 0, 1) || !finite(z.y, 0, 1) || typeof z.follow !== 'boolean') return null;
    last = z.end;
    ids.add(z.id);
  }
  return {
    version: 1, enabled: p.enabled, sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight,
    sourceDuration: p.sourceDuration, smoothing: p.smoothing ?? 0.22,
    points: p.points.map(({ t, x, y, buttons, visible }) => ({ t, x, y, ...(buttons !== undefined ? { buttons } : {}), ...(visible !== undefined ? { visible } : {}) })),
    segments: p.segments.map(({ id, start, end, scale, follow, x, y }) => ({ id, start, end, scale, follow, x, y })),
    showPointer: p.showPointer, clickEffects: p.clickEffects,
  };
}

// Analytic low-pass response to a linear focal path: independent of playback rate,
// frame rate and seek order. A zero response time means exact linear interpolation.
function positionAt(s, next, t, smoothing) {
  const dt = Math.max(0, t - s.t), span = next ? next.t - s.t : 0;
  const vx = span > 0 ? (next.x - s.x) / span : 0, vy = span > 0 ? (next.y - s.y) / span : 0;
  const rawX = s.x + vx * dt, rawY = s.y + vy * dt;
  if (!smoothing) return { x: rawX, y: rawY, rawX, rawY };
  const decay = Math.exp(-dt / smoothing);
  return { x: rawX - vx * smoothing + (s.sx - s.x + vx * smoothing) * decay,
    y: rawY - vy * smoothing + (s.sy - s.y + vy * smoothing) * decay, rawX, rawY };
}
const prepared = new WeakMap();
export function focusSamples(p) {
  const smoothing = p.smoothing ?? 0.22;
  let cached = prepared.get(p.points);
  if (cached?.smoothing === smoothing) return cached;
  const points = [], clicks = [];
  let buttons = 0;
  for (const s of p.points) {
    const prev = points[points.length - 1];
    const smooth = prev ? positionAt(prev, s, s.t, smoothing) : s;
    points.push({ ...s, sx: smooth.x, sy: smooth.y });
    if (((s.buttons || 0) & ~buttons) !== 0 && s.visible !== false) clicks.push(s);
    buttons = s.buttons || 0;
  }
  cached = { points, clicks, smoothing };
  prepared.set(p.points, cached);
  return cached;
}
export function focalPoint(p, t) {
  const { points, smoothing } = focusSamples(p);
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].t <= t) low = mid + 1; else high = mid; }
  const s = points[Math.max(0, low - 1)];
  if (!s) return { x: 0.5, y: 0.5, rawX: 0.5, rawY: 0.5, visible: false };
  return { ...positionAt(s, points[low], t, smoothing), visible: t >= s.t && s.visible !== false };
}
export function focusViewport(p, t) {
  const z = p.enabled && p.segments.find((z) => t >= z.start && t <= z.end);
  if (!z) return { x: 0, y: 0, width: 1, height: 1, scale: 1 };
  const ramp = Math.min(0.35, (z.end - z.start) / 2);
  const amount = clamp(Math.min((t - z.start) / ramp, (z.end - t) / ramp));
  const scale = 1 + (z.scale - 1) * amount * amount * (3 - 2 * amount);
  const width = 1 / scale;
  const point = z.follow && p.points.length ? focalPoint(p, t) : z;
  return { x: clamp(point.x - width / 2, 0, 1 - width), y: clamp(point.y - width / 2, 0, 1 - width), width, height: width, scale };
}

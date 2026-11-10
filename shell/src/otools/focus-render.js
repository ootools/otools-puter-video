import { focalPoint, focusSamples, focusViewport } from './focus-follow.js';

/** Rasterize the current source frame, preserving its aspect and native clip geometry. */
export function drawFocusFrame(ctx, source, p, time, sw = p.sourceWidth, sh = p.sourceHeight) {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  const cache = focusSamples(p), viewport = focusViewport(p, time);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.drawImage(source, viewport.x * sw, viewport.y * sh, viewport.width * sw, viewport.height * sh, 0, 0, width, height);
  const xy = (x, y) => ({ x: (x - viewport.x) * viewport.scale * width, y: (y - viewport.y) * viewport.scale * height });
  if (p.clickEffects) {
    let low = 0, high = cache.clicks.length;
    while (low < high) { const mid = (low + high) >>> 1; if (cache.clicks[mid].t < time - 0.5) low = mid + 1; else high = mid; }
    for (let i = low; i < cache.clicks.length && cache.clicks[i].t <= time; i++) {
      const point = cache.clicks[i], age = (time - point.t) / 0.5, position = xy(point.x, point.y);
      ctx.beginPath();
      ctx.arc(position.x, position.y, (12 + 30 * age) * width / p.sourceWidth, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(51,184,255,${1 - age})`; ctx.lineWidth = 4 * width / p.sourceWidth;
      ctx.stroke();
    }
  }
  const pointer = focalPoint(p, time);
  if (p.showPointer && pointer.visible) {
    const position = xy(pointer.rawX, pointer.rawY), size = Math.max(12, Math.min(p.sourceWidth, p.sourceHeight) * 0.02) * width / p.sourceWidth;
    ctx.beginPath();
    ctx.moveTo(position.x, position.y);
    ctx.lineTo(position.x, position.y + size);
    ctx.lineTo(position.x + size * 0.38, position.y + size * 0.7);
    ctx.lineTo(position.x + size * 0.74, position.y + size * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2 * width / p.sourceWidth;
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// One reusable pair per compositor; GPU version changes even for edits at a paused time.
const buffers = new WeakMap();
export function focusSource(comp, layer, info) {
  const p = layer.clip?.focusFollow;
  if (!info?.source || layer.kind !== 'media' || layer.clip?.type !== 'video' || !p?.enabled || p.version !== 1) return info;
  let pair = buffers.get(comp);
  if (!pair) { pair = []; buffers.set(comp, pair); }
  const revision = pair.revision = (pair.revision || 0) + 1;
  const scale = Math.min(comp.width / comp.projW, comp.height / comp.projH);
  const width = Math.max(2, Math.round(p.sourceWidth * scale)), height = Math.max(2, Math.round(p.sourceHeight * scale));
  const compose = (input, slot) => {
    if (!input?.source) return input;
    let canvas = pair[slot];
    if (!canvas) canvas = pair[slot] = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Focus effects need a 2D canvas.');
    drawFocusFrame(ctx, input.source, p, layer.sourceTime / 1e6, input.width || p.sourceWidth, input.height || p.sourceHeight);
    return { ...input, key: `focus:${layer.clip.id}:${slot}`, source: canvas, width, height, dynamic: true, version: `${input.version}:${layer.sourceTime}:${revision}` };
  };
  const result = compose(info, 0);
  if (info.between) result.between = { ...info.between, next: compose(info.between.next, 1) };
  return result;
}

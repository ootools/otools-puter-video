import { recordingPointer, recordingSamples, recordingViewport } from './recording.js';

/** Rasterize only the current source frame. No intermediate video or baked timeline. */
export function drawRecordingScreen(ctx, source, p, time, sw = p.width, sh = p.height) {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  const cache = recordingSamples(p);
  const viewport = recordingViewport(p, time);
  const padding = p.background.padding * Math.min(width, height);
  const frame = { x: padding, y: padding, width: width - padding * 2, height: height - padding * 2 };
  ctx.clearRect(0, 0, width, height);
  if (p.background.style === 'gradient') {
    const gradient = ctx.createLinearGradient(0, height, width, 0);
    gradient.addColorStop(0, p.background.color);
    gradient.addColorStop(1, p.background.color2);
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = p.background.color;
  ctx.fillRect(0, 0, width, height);
  const fit = Math.min(frame.width / sw, frame.height / sh);
  const content = { x: frame.x + (frame.width - sw * fit) / 2, y: frame.y + (frame.height - sh * fit) / 2, width: sw * fit, height: sh * fit };
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(content.x, content.y, content.width, content.height, p.background.radius * Math.min(width, height));
  ctx.clip();
  ctx.drawImage(source, viewport.x * sw, viewport.y * sh, viewport.width * sw, viewport.height * sh, content.x, content.y, content.width, content.height);
  const xy = (x, y) => ({ x: content.x + (x - viewport.x) * viewport.scale * content.width, y: content.y + (y - viewport.y) * viewport.scale * content.height });
  if (p.clickEffects) {
    let low = 0, high = cache.clicks.length;
    while (low < high) { const mid = (low + high) >>> 1; if (cache.clicks[mid].t < time - 0.5) low = mid + 1; else high = mid; }
    for (let i = low; i < cache.clicks.length && cache.clicks[i].t <= time; i++) {
      const point = cache.clicks[i];
      const age = (time - point.t) / 0.5, position = xy(point.x, point.y);
      ctx.beginPath();
      ctx.arc(position.x, position.y, (12 + 30 * age) * width / p.width, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(51,184,255,${1 - age})`;
      ctx.lineWidth = 4 * width / p.width;
      ctx.stroke();
    }
  }
  const pointer = recordingPointer(cache.points, time);
  if (p.showPointer && pointer.visible) {
    const position = xy(pointer.rawX, pointer.rawY), size = Math.max(12, Math.min(p.width, p.height) * 0.02) * width / p.width;
    ctx.beginPath();
    ctx.moveTo(position.x, position.y);
    ctx.lineTo(position.x, position.y + size);
    ctx.lineTo(position.x + size * 0.38, position.y + size * 0.7);
    ctx.lineTo(position.x + size * 0.74, position.y + size * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2 * width / p.width;
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// One reusable pair per compositor, so timeline edits do not accumulate full-size canvases.
const buffers = new WeakMap();
export function recordingSource(comp, layer, info) {
  const recording = layer.clip?.otoolsRecording;
  if (!info?.source || layer.kind !== 'media' || recording?.role !== 'screen' || recording.version !== 1) return info;
  let pair = buffers.get(comp);
  if (!pair) { pair = []; buffers.set(comp, pair); }
  // The slow-motion GPU cache also keys on version, even for dynamic uploads.
  // A fresh composition can change while paused (inspector/undo), at the same source time.
  const revision = pair.revision = (pair.revision || 0) + 1;
  const p = recording.data;
  const scale = Math.min(comp.width / comp.projW, comp.height / comp.projH);
  const width = Math.max(2, Math.round(p.width * scale)), height = Math.max(2, Math.round(p.height * scale));
  const compose = (input, slot) => {
    if (!input?.source) return input;
    let canvas = pair[slot];
    if (!canvas) canvas = pair[slot] = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Recording effects need a 2D canvas.');
    drawRecordingScreen(ctx, input.source, p, layer.sourceTime / 1e6, input.width || p.width, input.height || p.height);
    return { ...input, key: `recording:${layer.clip.id}:${slot}`, source: canvas, width, height, dynamic: true, version: `${input.version}:${layer.sourceTime}:${revision}` };
  };
  const result = compose(info, 0);
  if (info.between) result.between = { ...info.between, next: compose(info.between.next, 1) };
  return result;
}

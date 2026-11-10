import { describe, expect, it, vi } from 'vitest';
import { Compositor } from '../src/engine/compositor.js';
import { makeClip, createProject, normalizeClip, normalizeProject } from '../src/model/project.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { clipLayer } from '../src/engine/scene.js';
import { splitClip } from '../src/model/timeline.js';

const frame = () => ({ enabled: true, style: 'gradient', color: '#123456', color2: '#abcdef', padding: 0.08, radius: 0.04 });
const focus = () => ({ version: 1, enabled: true, sourceWidth: 1920, sourceHeight: 1080, sourceDuration: 10, smoothing: 0.22,
  points: [{ t: 0, x: 0.2, y: 0.3, buttons: 0 }, { t: 2, x: 0.8, y: 0.7, buttons: 1 }],
  segments: [{ id: 'z1', start: 1, end: 4, scale: 2, follow: false, x: 0.5, y: 0.5 }], showPointer: true, clickEffects: true });
function project() {
  const p = createProject();
  p.assets.a = { id: 'a', kind: 'video', name: 'video.mp4', hash: 'hash', ext: 'mp4', size: 1, duration: 10e6, width: 1920, height: 1080, hasAudio: true };
  p.settings.canvasFrame = frame();
  p.tracks[0].clips = [makeClip('video', { id: 'clip', assetId: 'a', duration: 10e6, focusFollow: focus() })];
  return p;
}
function context(canvas) {
  const ctx = { canvas };
  for (const method of ['clearRect', 'save', 'restore', 'beginPath', 'clip', 'drawImage', 'arc', 'stroke', 'moveTo', 'lineTo', 'closePath', 'fill']) ctx[method] = vi.fn();
  return ctx;
}

describe('generic project effects persistence', () => {
  it('saves and reopens global framing and focus paths with independent transforms and masks', async () => {
    const p = project(), c = p.tracks[0].clips[0];
    c.transform.x = 0.3;
    c.crop = { l: 0.1, t: 0, r: 0, b: 0 };
    const library = new Library(memoryBackend());
    await library.saveProject(normalizeProject(p));
    const saved = await library.openProject(p.id);
    expect(saved.settings.canvasFrame).toEqual(frame());
    expect(saved.tracks[0].clips[0].focusFollow).toEqual(focus());
    expect(saved.tracks[0].clips[0].transform.x).toBe(0.3);
    expect(saved.tracks[0].clips[0].crop.l).toBe(0.1);
  });
  it('retains focus controls for 8K and long imported videos', () => {
    const c = project().tracks[0].clips[0];
    c.focusFollow.sourceWidth = 8192; c.focusFollow.sourceHeight = 8192; c.focusFollow.sourceDuration = 86400;
    expect(normalizeClip(c).focusFollow).toMatchObject({ sourceWidth: 8192, sourceHeight: 8192, sourceDuration: 86400 });
  });
  it.each([
    (p) => { p.version = 2; }, (p) => { p.sourceDuration = Infinity; },
    (p) => { p.points[0].t = -1; }, (p) => { p.points[0].x = Infinity; },
    (p) => { p.segments[0].end = 0.9; }, (p) => { p.smoothing = -1; },
  ])('discards invalid focus data without losing playable media', (mutate) => {
    const c = project().tracks[0].clips[0]; mutate(c.focusFollow);
    const saved = normalizeClip(c);
    expect(saved.focusFollow).toBeUndefined(); expect(saved.assetId).toBe('a');
  });
  it('discards invalid frame data without discarding native canvas settings', () => {
    const p = project(); p.settings.canvasFrame.padding = 1;
    const saved = normalizeProject(p);
    expect(saved.settings.canvasFrame).toBeUndefined();
    expect(saved.settings.background).toEqual(p.settings.background);
  });
});

describe('shared source-time focus rendering', () => {
  it('crops the source before ordinary layer transforms for both live and decoded sources', () => {
    const contexts = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () { const ctx = context(this); contexts.push(ctx); return ctx; });
    try {
      const p = project(), c = p.tracks[0].clips[0];
      c.in = 1e6; c.start = 3e6; c.speed = 2; c.duration = 4e6;
      const right = splitClip(p, c.id, 3.5e6);
      const layer = clipLayer(p, right, 3.5e6, 0);
      expect(layer.sourceTime).toBe(2e6);
      expect(layer.clip.focusFollow.segments[0].start).toBe(1);
      for (const dynamic of [true, false]) {
        const info = { key: 'video', source: {}, width: 1920, height: 1080, dynamic, version: 1 };
        let uploaded;
        const comp = { width: 1920, height: 1080, projW: 1920, projH: 1080, resolve: () => info, _texture: (value) => { uploaded = value; return null; } };
        Compositor.prototype._drawLayer.call(comp, layer, 99);
        expect(uploaded.source).not.toBe(info.source);
        expect(contexts.at(-1).drawImage.mock.calls[0].slice(1)).toEqual([480, 270, 960, 540, 0, 0, 1920, 1080]);
        const version = uploaded.version;
        layer.clip.focusFollow.segments[0].x = 1;
        Compositor.prototype._drawLayer.call(comp, layer, 99);
        expect(uploaded.version).not.toBe(version);
        expect(contexts.at(-1).drawImage.mock.calls[0][1]).toBe(960);
        layer.clip.focusFollow.segments[0].x = 0.5;
      }
    } finally { spy.mockRestore(); }
  });
  it('never draws a pointer or click ring without a focal path', () => {
    const contexts = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () { const ctx = context(this); contexts.push(ctx); return ctx; });
    try {
      const p = project(), c = p.tracks[0].clips[0]; c.focusFollow.points = []; c.focusFollow.segments[0].follow = true;
      const layer = clipLayer(p, c, 2e6, 0);
      const comp = { width: 1920, height: 1080, projW: 1920, projH: 1080, resolve: () => ({ source: {}, width: 1920, height: 1080 }), _texture: () => null };
      Compositor.prototype._drawLayer.call(comp, layer, 2);
      expect(contexts).toHaveLength(1);
      expect(contexts[0].moveTo).not.toHaveBeenCalled(); expect(contexts[0].arc).not.toHaveBeenCalled();
      expect(contexts[0].drawImage.mock.calls[0].slice(1, 5)).toEqual([480, 270, 960, 540]);
    } finally { spy.mockRestore(); }
  });
  it('bypasses disabled and ordinary clips without source modification', () => {
    const p = project(), c = p.tracks[0].clips[0]; c.focusFollow.enabled = false;
    const info = { source: {} }, upload = vi.fn();
    const comp = { resolve: () => info, _texture: upload };
    Compositor.prototype._drawLayer.call(comp, clipLayer(p, c, 2e6, 0), 2);
    expect(upload).toHaveBeenLastCalledWith(info);
    delete c.focusFollow;
    Compositor.prototype._drawLayer.call(comp, clipLayer(p, c, 2e6, 0), 2);
    expect(upload).toHaveBeenLastCalledWith(info);
  });
});

describe('global canvas frame render stage', () => {
  it('frames the final composition after video, camera, text and grading, including same-frame edits', () => {
    const calls = [], uniforms = {};
    const comp = {
      frame: 0, width: 1920, height: 1080,
      gl: { bindVertexArray() {}, disable() {}, enable() {}, blendFunc() {} },
      _background() {}, _target: (name) => ({ tex: name, w: 1920, h: 1080 }), _into() {}, _gcTextures() {},
      _drawVisual: (layer) => calls.push(layer.clip.id), _program: (key) => key, _use: (p) => p,
      _setGrade() {}, _set: (_p, key, value, ...rest) => { uniforms[key] = rest.length ? [value, ...rest] : value; }, _seti() {},
      _bindTex: (_unit, tex) => calls.push(tex), _fullPass: (program) => calls.push(program), _copy: () => calls.push('copy'),
    };
    const settings = { canvasFrame: frame() };
    const layers = [{ kind: 'media', clip: { id: 'video' } }, { kind: 'media', clip: { id: 'camera' } }, { kind: 'text', clip: { id: 'title' } }, { kind: 'adjust' }];
    Compositor.prototype.render.call(comp, layers, { settings });
    expect(calls.slice(-2)).toEqual(['acc1', 'canvas-frame']);
    expect(calls.indexOf('canvas-frame')).toBeGreaterThan(calls.indexOf('title'));
    [153.6, 86.4, 1612.8, 907.2].forEach((n, i) => expect(uniforms.u_frame[i]).toBeCloseTo(n));
    expect(uniforms.u_radius).toBeCloseTo(43.2);
    settings.canvasFrame.padding = 0.1;
    Compositor.prototype.render.call(comp, [], { settings });
    expect(uniforms.u_frame[2]).toBe(1536);
    settings.canvasFrame.enabled = false;
    Compositor.prototype.render.call(comp, [], { settings });
    expect(calls.at(-1)).toBe('copy');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Compositor } from '../src/engine/compositor.js';
import { recordingSource, drawRecordingScreen } from '../src/otools/recording-render.js';
import { makeClip, createProject, normalizeClip, normalizeProject } from '../src/model/project.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import * as recording from '../src/otools/recording.js';
import { clipLayer } from '../src/engine/scene.js';
import { splitClip } from '../src/model/timeline.js';

export function recordingData() {
  return {
    version: 1, width: 1920, height: 1080, fps: 30, duration: 10,
    pointer: [{ t: 0, x: 0.2, y: 0.3, buttons: 0 }, { t: 2, x: 0.8, y: 0.7, buttons: 1 }, { t: 2.1, x: 0.8, y: 0.7, buttons: 0, visible: false }],
    zooms: [{ id: 'z1', start: 1, end: 4, scale: 2, follow: true, x: 0.5, y: 0.5 }],
    background: { style: 'gradient', color: '#123456', color2: '#abcdef', padding: 0.08, radius: 0.04 },
    camera: { enabled: true, x: 0.7, y: 0.6, size: 0.2, roundness: 1 },
    showPointer: true, clickEffects: true,
  };
}

export function recordingProject() {
  const p = createProject({ name: 'Recording' });
  p.assets.screen = { id: 'screen', kind: 'video', name: 'screen.mp4', hash: 'hash', ext: 'mp4', size: 1, duration: 10e6, width: 1920, height: 1080, hasAudio: true };
  p.tracks[0].clips = [makeClip('video', { id: 'screen-clip', assetId: 'screen', duration: 10e6, otoolsRecording: { version: 1, role: 'screen', data: recordingData() } })];
  return p;
}

describe('recording source time and geometry', () => {
  it('uses smoothstep ramps and clamps the source viewport at the edges', () => {
    const p = recordingData();
    p.zooms[0].follow = false;
    p.zooms[0].x = 1;
    p.zooms[0].y = 0;
    expect(recording.recordingViewport(p, 0)).toEqual({ x: 0, y: 0, width: 1, height: 1, scale: 1 });
    const ramp = recording.recordingViewport(p, 1.175);
    expect(ramp.scale).toBeCloseTo(1.5);
    expect(ramp.x).toBeCloseTo(1 / 3);
    expect(ramp.y).toBe(0);
    expect(recording.recordingViewport(p, 2)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5, scale: 2 });
    expect(recording.recordingViewport(p, 4).scale).toBe(1);
  });

  it('smooths following with the same 220ms exponential response as the recorder', () => {
    const p = recordingData();
    const atClick = recording.recordingViewport(p, 2);
    expect(atClick.x).toBe(0);
    const later = recording.recordingViewport(p, 2.22);
    expect(later.x).toBeCloseTo(0.8 - 0.6 / Math.E - 0.25);
  });

  it('keeps effects on source time after trim, split and speed changes', () => {
    const p = recordingProject();
    const c = p.tracks[0].clips[0];
    c.in = 1e6; c.start = 3e6; c.speed = 2; c.duration = 4e6;
    let layer = clipLayer(p, c, 3.5e6, 0);
    expect(layer.sourceTime).toBe(2e6);
    expect(recording.recordingViewport(layer.clip.otoolsRecording.data, layer.sourceTime / 1e6).scale).toBe(2);
    const right = splitClip(p, c.id, 3.5e6);
    layer = clipLayer(p, right, 3.5e6, 0);
    expect(layer.sourceTime).toBe(2e6);
    expect(layer.clip.otoolsRecording.data.zooms[0].start).toBe(1);
    expect(recording.recordingViewport(layer.clip.otoolsRecording.data, layer.sourceTime / 1e6).scale).toBe(2);
  });
});

describe('shared preview/export compositor', () => {
  it('keeps pointer geometry proportional between reduced previews and final export', () => {
    const render = (scale) => {
      const ctx = { canvas: { width: 1920 * scale, height: 1080 * scale } };
      for (const name of ['clearRect','fillRect','save','restore','beginPath','roundRect','clip','drawImage','arc','stroke','moveTo','lineTo','closePath','fill']) ctx[name] = vi.fn();
      ctx.createLinearGradient = () => ({ addColorStop() {} });
      drawRecordingScreen(ctx, {}, recordingData(), 0);
      const start = ctx.moveTo.mock.calls[0], tip = ctx.lineTo.mock.calls[0];
      return { size: (tip[1] - start[1]) / scale, stroke: ctx.lineWidth / scale };
    };
    const full = render(1), preview = render(0.25);
    expect(preview.size).toBeCloseTo(full.size);
    expect(preview.stroke).toBeCloseTo(full.stroke);
  });
  it('composes a fixed rounded frame, source crop and clicks before uploading in live and decoded paths', () => {
    const contexts = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () {
      const ctx = { canvas: this };
      for (const method of ['clearRect', 'fillRect', 'save', 'restore', 'beginPath', 'roundRect', 'clip', 'drawImage', 'arc', 'stroke', 'moveTo', 'lineTo', 'closePath', 'fill']) ctx[method] = vi.fn();
      ctx.createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
      contexts.push(ctx);
      return ctx;
    };
    try {
      const p = recordingProject();
      p.tracks[0].clips[0].otoolsRecording.data.zooms[0].follow = false;
      const layer = clipLayer(p, p.tracks[0].clips[0], 2e6, 0);
      for (const dynamic of [true, false]) {
        const info = { key: 'screen', source: { videoWidth: 1920, videoHeight: 1080 }, width: 1920, height: 1080, dynamic, version: 1 };
        let uploaded;
        const comp = { width: 1920, height: 1080, projW: 1920, projH: 1080, resolve: () => info, _texture: (value) => { uploaded = value; return null; } };
        Compositor.prototype._drawLayer.call(comp, layer, 9); // scene time deliberately differs
        expect(uploaded.source).not.toBe(info.source);
        expect(uploaded.width).toBe(1920);
        expect(uploaded.dynamic).toBe(true);
        const ctx = contexts.at(-1);
        const rounded = ctx.roundRect.mock.calls[0];
        expect(rounded[0]).toBeCloseTo(153.6);
        expect(rounded[1]).toBeCloseTo(86.4);
        expect(rounded[2]).toBeCloseTo(1612.8);
        expect(rounded[3]).toBeCloseTo(907.2);
        expect(rounded[4]).toBeCloseTo(43.2);
        expect(ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([480, 270, 960, 540]);
        expect(ctx.arc.mock.calls).toHaveLength(1);
        expect(ctx.moveTo.mock.calls).toHaveLength(1);
        expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 1080, 1920, 0);
        const before = recordingSource(comp, layer, info);
        layer.clip.otoolsRecording.data.background.color = '#ff0000';
        const after = recordingSource(comp, layer, info);
        expect(after.version).not.toBe(before.version); // interpolation cache must see same-time edits
      }
    } finally { HTMLCanvasElement.prototype.getContext = original; }
  });

  it('does not compose camera or ordinary video twice', () => {
    const p = recordingProject();
    p.tracks[0].clips[0].otoolsRecording.role = 'camera';
    const layer = clipLayer(p, p.tracks[0].clips[0], 2e6, 0);
    const info = { key: 'camera', source: {}, width: 640, height: 480 };
    let uploaded;
    const comp = { resolve: () => info, _texture: (value) => { uploaded = value; return null; } };
    Compositor.prototype._drawLayer.call(comp, layer, 2);
    expect(uploaded).toBe(info);
    delete layer.clip.otoolsRecording;
    Compositor.prototype._drawLayer.call(comp, layer, 2);
    expect(uploaded).toBe(info);
  });
});

describe('editable recording project metadata', () => {
  it('survives normalization, native library save and reopen without changing the source timeline', async () => {
    const p = recordingProject();
    const normalized = normalizeProject(p);
    const library = new Library(memoryBackend());
    await library.saveProject(normalized);
    const saved = await library.openProject(p.id);
    expect(saved.tracks[0].clips[0].otoolsRecording).toEqual(p.tracks[0].clips[0].otoolsRecording);
    expect(saved.assets.screen.duration).toBe(10e6);
    expect(saved.tracks[0].clips[0].otoolsRecording.data.pointer[1].t).toBe(2);
  });

  it('retains camera metadata and independent native placement', () => {
    const c = recordingProject().tracks[0].clips[0];
    c.otoolsRecording.role = 'camera';
    c.transform.x = 0.3;
    const saved = normalizeClip(c);
    expect(saved.otoolsRecording.role).toBe('camera');
    expect(saved.transform.x).toBe(0.3);
  });

  it.each([
    (m) => { m.version = 2; },
    (m) => { m.role = 'other'; },
    (m) => { m.data.pointer[1].t = -1; },
    (m) => { m.data.pointer[1].x = Infinity; },
    (m) => { m.data.zooms[0].end = 0.9; },
    (m) => { m.data.background.padding = 1; },
  ])('rejects invalid recording metadata while retaining playable media', (breakMetadata) => {
    const c = recordingProject().tracks[0].clips[0];
    breakMetadata(c.otoolsRecording);
    const saved = normalizeClip(c);
    expect(saved.otoolsRecording).toBeUndefined();
    expect(saved.assetId).toBe('screen');
  });
});

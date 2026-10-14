import { describe, it, expect } from 'vitest';
import { propLabel, animatableProps, moveKey, setEase, deleteKey, curveRange, createKeyframePanel } from '../src/ui/timeline/keyframe-panel.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain, s } from './helpers.js';

const keyed = () => {
  const c = clip('video', 0, 4);
  c.keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: s(2), v: 0.5, ease: 'linear' }], 'adjust.exposure': [{ t: s(1), v: 20, ease: 'linear' }] };
  return c;
};

describe('keyframe panel helpers', () => {
  it('names properties', () => {
    expect(propLabel('x')).toBe('Position X');
    expect(propLabel('adjust.exposure')).toBe('Exposure');
    expect(propLabel('mask0.feather')).toBe('Mask 1 feather');
    expect(propLabel('style.colorR')).toBe('Text color (red)');
  });

  it('lists what a clip can animate', () => {
    expect(animatableProps(clip('audio', 0, 1))).toEqual(['volume']);
    const v = animatableProps(clip('video', 0, 1));
    expect(v).toContain('scale');
    expect(v).toContain('volume');
    expect(v).toContain('adjust.exposure');
    expect(animatableProps(clip('text', 0, 1))).not.toContain('volume');
  });

  it('moves, eases and deletes keys of one property only', () => {
    const c = keyed();
    expect(moveKey(c, 'x', s(2), s(3))).toBe(true);
    expect(c.keyframes.x[1].t).toBe(s(3));
    expect(c.keyframes['adjust.exposure'][0].t).toBe(s(1));
    expect(moveKey(c, 'x', s(3), s(9))).toBe(true);
    expect(c.keyframes.x[1].t).toBe(s(4));
    expect(setEase(c, 'x', 0, 'easeOut')).toBe(true);
    expect(c.keyframes.x[0].ease).toBe('easeOut');
    expect(deleteKey(c, 'adjust.exposure', s(1))).toBe(true);
    expect(c.keyframes['adjust.exposure']).toBeUndefined();
    expect(deleteKey(c, 'x', s(7))).toBe(false);
  });

  it('pads the curve range, and gives flat curves room', () => {
    const c = keyed();
    const r = curveRange(c, 'x');
    expect(r.lo).toBeLessThan(0);
    expect(r.hi).toBeGreaterThan(0.5);
    const flat = curveRange(c, 'adjust.exposure');
    expect(flat.hi - flat.lo).toBe(2);
  });
});

describe('keyframe panel view', () => {
  it('shows a lane per keyed property and adds a key from the property menu', () => {
    const p = fixture();
    const [v] = onMain(p, keyed());
    const store = new EditorStore(p);
    const ctx = { store, player: { playing: false } };
    ctx.actions = createActions(ctx);
    const tl = { el: document.createElement('div'), geometry: () => ({ pps: 100, pad: 16, scrollLeft: 0, headerW: 92, timeToX: (t) => 16 + (t / 1e6) * 100 }), render() {} };
    const panel = createKeyframePanel(ctx, tl);
    document.body.append(panel.el);
    panel.setOpen(true);
    store.select(v.id);
    const lanes = [...panel.el.querySelectorAll('.kf-lane')].map((l) => l.dataset.prop);
    expect(lanes).toEqual(['x', 'adjust.exposure']);
    expect(panel.el.querySelectorAll('.kf-lane[data-prop="x"] .kf-key').length).toBe(2);
    // Add a scale key at the playhead.
    store.seek(s(1.5));
    panel.el.querySelector('.kf-panel-head .btn').click();
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Scale')).click();
    expect(store.project.tracks[0].clips[0].keyframes.scale).toHaveLength(1);
    expect([...panel.el.querySelectorAll('.kf-lane')].map((l) => l.dataset.prop)).toContain('scale');
    panel.dispose();
    panel.el.remove();
  });
});

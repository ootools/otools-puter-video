import { describe, it, expect } from 'vitest';
import { sliceProject, exportSpan } from '../src/model/slice.js';
import { addClip, mainTrack, projectDuration } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';

const FREE = { ripple: false, linkOverlays: false };

describe('sliceProject', () => {
  it('keeps and trims what lies in the range, shifted to 0', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4), clip('video', 4, 4), clip('video', 8, 4));
    const t = clip('text', 3, 2);
    addClip(p, t, FREE);
    p.markers.push({ id: 'm', time: s(5), color: '#ffffff', label: '' }, { id: 'n', time: s(11), color: '#ffffff', label: '' });
    const out = sliceProject(p, s(2), s(9));
    const main = mainTrack(out);
    expect(main.clips.map((c) => [c.start / 1e6, c.duration / 1e6, c.in / 1e6])).toEqual([[0, 2, 2], [2, 4, 0], [6, 1, 0]]);
    expect(out.tracks.find((x) => x.kind === 'text').clips[0].start).toBe(s(1));
    expect(out.markers.map((m) => m.time)).toEqual([s(3)]);
    expect(projectDuration(out)).toBe(s(7));
    // The original is untouched.
    expect(mainTrack(p).clips[0].duration).toBe(s(4));
  });

  it('keeps keyframed motion continuous across the cut', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4));
    v.keyframes = { x: [{ t: 0, v: 0, ease: 'linear' }, { t: s(4), v: 1, ease: 'linear' }] };
    const out = sliceProject(p, s(1), s(3));
    const k = mainTrack(out).clips[0].keyframes.x;
    expect(k[0]).toMatchObject({ t: 0, v: 0.25 });
    expect(k.at(-1)).toMatchObject({ t: s(2), v: 0.75 });
  });

  it('limits to chosen clips and the look layers over them', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    const fx = clip('effect', 5, 2);
    const fx2 = clip('effect', 0, 1);
    addClip(p, fx, FREE);
    addClip(p, fx2, FREE);
    const out = sliceProject(p, b.start, s(8), { keep: new Set([b.id]) });
    expect(out.tracks.flatMap((t) => t.clips).map((c) => c.type).sort()).toEqual(['effect', 'video']);
    void a;
  });

  it('drops a transition whose partner is cut away', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    a.transition = { id: 'mix', duration: s(1) };
    expect(mainTrack(sliceProject(p, 0, s(4))).clips[0].transition).toBeNull();
    expect(mainTrack(sliceProject(p, 0, s(8))).clips[0].transition).toEqual({ id: 'mix', duration: s(1) });
  });
});

describe('exportSpan', () => {
  it('covers the whole timeline, the range or the selection', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 4), clip('video', 4, 4));
    expect(exportSpan(p, 'all')).toEqual({ start: 0, end: s(8) });
    p.range = { in: s(1), out: s(20) };
    expect(exportSpan(p, 'range')).toEqual({ start: s(1), end: s(8) });
    expect(exportSpan(p, 'selection', [b.id])).toEqual({ start: s(4), end: s(8) });
    expect(exportSpan(p, 'selection', [])).toEqual({ start: 0, end: s(8) });
    void a;
  });
});

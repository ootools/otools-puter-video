// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, makeClip, normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createTimeline } from '../src/ui/timeline/timeline.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { focusViewport } from '../src/otools/focus-follow.js';
import { installDomTranslation, disposeDomTranslation, translateAll } from '../src/otools/dom-i18n.js';
import { setPreference } from '../src/otools/i18n.js';

const cleanups = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  disposeDomTranslation(); setPreference('en-US');
  document.body.replaceChildren();
});
const segment = (id, start, end, scale = 2) => ({ id, start, end, scale, follow: false, x: 0.5, y: 0.5 });
function setup({ enabled = true, locked = false, segments = [segment('a', 1, 3), segment('b', 4, 6, 3), segment('c', 8, 11)] } = {}) {
  const p = createProject();
  p.assets.a = { id: 'a', kind: 'video', duration: 12e6, width: 1920, height: 1080 };
  p.tracks[0].locked = locked; p.tracks[0].size = 'small';
  p.tracks[0].clips.push(makeClip('video', { id: 'video', assetId: 'a', start: 3e6, in: 2e6, speed: 2, duration: 4e6,
    focusFollow: { version: 1, enabled, sourceDuration: 12, sourceWidth: 1920, sourceHeight: 1080, smoothing: 0.22,
      points: [], showPointer: false, clickEffects: false, segments } }));
  const store = new EditorStore(p);
  const ctx = { store, player: { playing: false, pause() {}, setPreview() {} },
    media: { on: () => () => {}, thumb: () => null, peaksNow: () => null, peaks() {} },
    commands: { keyFor: () => '', run() {} }, assets: { show() {} } };
  ctx.actions = createActions(ctx);
  const tl = createTimeline(ctx);
  store.select('video'); ctx.inspector = createInspector(ctx); store.clearSelection();
  document.body.append(tl.el, ctx.inspector.el); tl.mounted();
  cleanups.push(() => { tl.dispose(); ctx.inspector.dispose(); });
  const content = tl.el.querySelector('.tl-content');
  const contentAt = (left) => { content.getBoundingClientRect = () => ({ left, top: 0, width: 5000, height: 400 }); };
  contentAt(0);
  const clip = () => store.project.tracks[0].clips[0];
  const node = () => tl.el.querySelector('.tl-clip[data-id="video"]');
  const strip = () => node().querySelector('.focus-strip');
  const bar = (id) => strip()?.querySelector(`[data-focus-segment="${id}"]`);
  const handle = (id, edge) => bar(id)?.querySelector(`[data-focus-edge="${edge}"]`);
  const x = (source) => tl.geometry().timeToX(3e6 + (source - 2) / 2 * 1e6);
  const pointer = (target, type, clientX) => {
    expect(target, `target for ${type}`).toBeTruthy();
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 60, pointerId: 1, pointerType: 'mouse', button: 0 }));
  };
  const drag = (id, edge, from, to) => {
    pointer(handle(id, edge), 'pointerdown', x(from));
    pointer(strip(), 'pointermove', x(to));
    pointer(strip(), 'pointerup', x(to)); tl.render();
  };
  return { store, ctx, tl, clip, node, strip, bar, handle, x, pointer, drag, contentAt };
}

describe('focus timeline', () => {
  it('shows existing disabled segments without selection, clipped and mapped through source in and speed', () => {
    const { tl, strip, bar, node } = setup({ enabled: false });
    expect(strip()).toBeTruthy();
    expect(strip().hidden).toBe(false);
    expect(bar('a').style.left).toBe('0px');
    expect(parseFloat(bar('a').style.width)).toBeCloseTo(tl.pps / 2);
    expect(parseFloat(bar('b').style.left)).toBeCloseTo(tl.pps);
    expect(parseFloat(bar('b').style.width)).toBeCloseTo(tl.pps);
    expect(parseFloat(bar('c').style.width)).toBeCloseTo(tl.pps);
    expect(bar('b').textContent).toContain('3×');
    expect(bar('b').querySelector('[data-focus-edge="start"]').getAttribute('aria-label')).toBe('Zoom start');
    expect(bar('b').querySelector('[data-focus-edge="end"]').getAttribute('aria-label')).toBe('Zoom end');
    expect(node().querySelectorAll('.clip-trim')).toHaveLength(2);
    tl.zoomBy(2);
    expect(parseFloat(bar('b').style.left)).toBeCloseTo(tl.pps);
  });

  it('selects the clip and the matching inspector segment even from another inspector tab', () => {
    const { store, ctx, tl, bar, clip } = setup({ enabled: false });
    store.select('video'); ctx.inspector.showTab('speed'); store.clearSelection();
    bar('b')?.querySelector('.focus-segment-select').click();
    expect(store.selectedIds).toEqual(['video']);
    const select = ctx.inspector.el.querySelector('select[aria-label="Zoom segment"]');
    expect(select).toBeTruthy(); expect(select.value).toBe('b');
    expect(select.closest('[hidden]')).toBeNull();
    const field = [...ctx.inspector.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === 'Zoom multiplier');
    const input = field.querySelector('.num-input'); input.value = '4'; input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip().focusFollow.segments[1].scale).toBe(4);
    tl.render(); expect(bar('b').textContent).toContain('4×');
    select.value = 'c'; select.dispatchEvent(new Event('change', { bubbles: true })); tl.render();
    expect(bar('c').querySelector('.focus-segment-select').getAttribute('aria-pressed')).toBe('true');
  });

  it('commits one undo step per handle drag and persists the same data consumed by rendering', () => {
    const { store, tl, clip, strip, handle, pointer, x, bar } = setup();
    const steps = store.history.undoStack.length;
    pointer(handle('b', 'start'), 'pointerdown', x(4));
    pointer(strip(), 'pointermove', x(4.5)); tl.render();
    pointer(strip(), 'pointermove', x(5));
    pointer(strip(), 'pointerup', x(5)); tl.render();
    expect(clip().focusFollow.segments[1].start).toBe(5);
    expect(clip()).toMatchObject({ start: 3e6, in: 2e6, duration: 4e6, speed: 2 });
    expect(store.history.undoStack.length).toBe(steps + 1);
    expect(focusViewport(clip().focusFollow, 4.5).scale).toBe(1);
    const saved = normalizeProject(store.projectForSave());
    expect(saved.tracks[0].clips[0].focusFollow.segments[1].start).toBe(5);
    store.undo(); tl.render(); expect(clip().focusFollow.segments[1].start).toBe(4);
    expect(parseFloat(bar('b').style.left)).toBeCloseTo(tl.pps);
    store.redo(); tl.render(); expect(clip().focusFollow.segments[1].start).toBe(5);
    expect(parseFloat(bar('b').style.left)).toBeCloseTo(1.5 * tl.pps);
  });

  it('clamps both handles to neighbors, minimum duration and the visible clip source bounds', () => {
    const { drag, clip, store } = setup();
    drag('b', 'start', 4, -10); expect(clip().focusFollow.segments[1].start).toBe(3);
    drag('b', 'end', 6, 20); expect(clip().focusFollow.segments[1].end).toBe(8);
    drag('b', 'start', 3, 20); expect(clip().focusFollow.segments[1].start).toBeCloseTo(7.99);
    drag('b', 'end', 8, -10); expect(clip().focusFollow.segments[1].end).toBeCloseTo(8);
    drag('a', 'start', 2, -10); expect(clip().focusFollow.segments[0].start).toBe(2);
    drag('c', 'end', 10, 20); expect(clip().focusFollow.segments[2].end).toBe(10);
    expect(normalizeProject(store.projectForSave()).tracks[0].clips[0].focusFollow).toBeTruthy();
  });

  it('uses content coordinates after scrolling and cancels a preview without history', () => {
    const { store, clip, strip, handle, pointer, x, contentAt, tl } = setup();
    pointer(handle('b', 'end'), 'pointerdown', x(6));
    pointer(strip(), 'pointermove', x(7));
    pointer(strip(), 'pointercancel', x(7));
    expect(clip().focusFollow.segments[1].end).toBe(6);
    expect(store.history.undoStack).toHaveLength(0);
    pointer(handle('b', 'end'), 'pointerdown', x(6));
    contentAt(-tl.pps / 2);
    pointer(strip(), 'pointermove', x(6)); pointer(strip(), 'pointerup', x(6));
    expect(clip().focusFollow.segments[1].end).toBe(7);
  });

  it('leaves locked clips unchanged and does not start ordinary trim or split interactions', () => {
    const { store, tl, clip, handle, strip, pointer, x } = setup({ locked: true });
    expect(strip()).toBeTruthy(); expect(handle('b', 'start').getAttribute('aria-disabled')).toBe('true');
    tl.setTool('split');
    pointer(handle('b', 'start'), 'pointerdown', x(4));
    pointer(strip(), 'pointermove', x(5)); pointer(strip(), 'pointerup', x(5));
    expect(clip().focusFollow.segments[1].start).toBe(4);
    expect(store.project.tracks[0].clips).toHaveLength(1); expect(store.history.undoStack).toHaveLength(0);
  });

  it('preserves ordinary clip trimming outside the strip', () => {
    const { store, tl, clip, node, pointer, x } = setup();
    store.setToggle('snap', false);
    pointer(node().querySelector('.clip-trim.r'), 'pointerdown', x(10));
    const tracks = tl.el.querySelector('.tl-tracks');
    pointer(tracks, 'pointermove', x(8)); pointer(tracks, 'pointerup', x(8));
    expect(clip().duration).toBe(3e6);
    expect(clip().focusFollow.segments[2].end).toBe(11);
  });

  it('translates the strip descriptions and explains clip-wide smoothing', () => {
    const { bar, ctx } = setup();
    bar('b')?.querySelector('.focus-segment-select').click();
    setPreference('zh-CN'); installDomTranslation(); translateAll();
    expect(bar('b')).toBeTruthy();
    expect(bar('b').querySelector('[data-focus-edge="start"]').getAttribute('aria-label')).toBe('缩放开始');
    expect(bar('b').querySelector('.focus-segment-select').title).toBe('缩放片段 2：4.00–6.00 秒 · 3×');
    expect(ctx.inspector.el.textContent).toContain('平滑时间应用于整个视频片段的焦点路径');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, makeClip, normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createClipView } from '../src/ui/inspector/common.js';
import { basicTab } from '../src/ui/inspector/video.js';
import { projectSettingsFields } from '../src/ui/project-settings.js';
import { createPlayerView } from '../src/ui/player-view.js';
import { Compositor } from '../src/engine/compositor.js';

let el;
afterEach(() => el?.remove());
function setup({ project = false } = {}) {
  const p = createProject();
  p.assets.a = { id: 'a', kind: 'video', duration: 10e6, width: 1920, height: 1080 };
  p.tracks[0].clips.push(makeClip('video', { id: 'video', assetId: 'a', duration: 10e6 }));
  const store = new EditorStore(p);
  const ctx = { store }; ctx.actions = createActions(ctx);
  const view = createClipView(ctx, 'video');
  el = project ? projectSettingsFields(ctx) : basicTab(view); document.body.append(el);
  return { store, view, data: () => view.clip.focusFollow };
}
function number(label, value) {
  const field = [...el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
  expect(field, `field ${label}`).toBeTruthy();
  const input = field.querySelector('.num-input');
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function button(name) {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name);
  expect(found, `button ${name}`).toBeTruthy();
  return found;
}
function toggle(label) {
  const field = [...el.querySelectorAll('.field')].find((f) => f.textContent.includes(label));
  const input = field?.querySelector('[role="switch"], input[type="checkbox"]');
  expect(input, `switch ${label}`).toBeTruthy();
  input.click();
}

describe('framed preview editing', () => {
  it('keeps selection handles and drag distances aligned with the inset composition', () => {
    const { store } = setup();
    el.remove();
    store.project.settings.canvasFrame = { enabled: true, padding: 0.1, radius: 0.04, style: 'solid', color: '#000000', color2: '#ffffff' };
    const comp = { projW: 1920, projH: 1080 };
    const player = { canvas: document.createElement('canvas'), supported: true, time: 0, playing: false,
      layout: () => ({ cssW: 960, cssH: 540 }), on: () => () => {}, pause() {},
      boxFor: (layer) => Compositor.prototype.layerBox.call(comp, layer, { width: 1920, height: 1080 }) };
    const ctx = { store, player }; ctx.actions = createActions(ctx);
    const view = createPlayerView(ctx); el = view.el; document.body.append(el);
    try {
      el.querySelector('.player-stage').getBoundingClientRect = () => ({ width: 1000, height: 600 });
      store.select('video'); view.relayout();
      const overlay = el.querySelector('.player-overlay');
      expect(parseFloat(overlay.style.width)).toBeCloseTo(768);
      expect(parseFloat(el.querySelector('.tf-box').style.width)).toBeCloseTo(768);
      overlay.getBoundingClientRect = () => ({ left: 96, top: 54, width: 768, height: 432 });
      const pointer = (type, x) => overlay.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 270, button: 0, altKey: true, bubbles: true }));
      pointer('pointerdown', 480); pointer('pointermove', 556.8); pointer('pointerup', 556.8);
      expect(store.selected.clip.transform.x).toBeCloseTo(0.1);
      store.update('Frame off', (p) => { p.settings.canvasFrame.enabled = false; });
      expect(parseFloat(overlay.style.width)).toBeCloseTo(960);
    } finally { view.dispose(); }
  });
});

describe('focus controls for any imported video', () => {
  it('enables an ordinary video with a manual center and no invented pointer path', () => {
    const { data } = setup();
    expect(data()).toBeUndefined();
    toggle('Enable focus and zoom');
    expect(data()).toMatchObject({ version: 1, enabled: true, sourceDuration: 10, sourceWidth: 1920, sourceHeight: 1080, points: [], showPointer: false });
    button('Add zoom segment').click();
    expect(data().segments[0]).toMatchObject({ start: 0, end: 2, scale: 2, follow: false, x: 0.5, y: 0.5 });
    expect(el.textContent).toContain('Transform');
  });

  it('edits source-time zooms with undo and save normalization', () => {
    const { store, view, data } = setup();
    toggle('Enable focus and zoom');
    store.seek(1e6);
    button('Add zoom segment').click(); view.scope.update();
    number('Zoom start', 1.5); number('Zoom end', 4); number('Zoom multiplier', 3);
    number('Zoom center X', 75); number('Zoom center Y', 25);
    expect(data().segments[0]).toMatchObject({ start: 1.5, end: 4, scale: 3, x: 0.75, y: 0.25 });
    store.undo(); view.scope.update();
    expect(data().segments[0].y).toBe(0.5);
    expect(normalizeProject(store.project).tracks[0].clips[0].focusFollow.segments[0].scale).toBe(3);
    button('Remove zoom segment').click();
    expect(data().segments).toHaveLength(0);
  });

  it('authors an animated focal path at original source times after trim and speed changes', () => {
    const { store, view, data } = setup();
    store.update('Trim and speed', (p) => { const c = p.tracks[0].clips[0]; c.in = 2e6; c.start = 3e6; c.speed = 2; c.duration = 4e6; });
    toggle('Enable focus and zoom');
    store.seek(4e6);
    button('Add focal point').click(); view.scope.update();
    number('Focal point X', 75); number('Focal point Y', 25);
    expect(data().points).toEqual([{ t: 4, x: 0.75, y: 0.25 }]);
    store.seek(5e6);
    button('Add focal point').click(); view.scope.update();
    number('Focal point time', 7); number('Focal point X', 25); number('Focus smoothing', 0.5);
    expect(data().points[1]).toEqual({ t: 7, x: 0.25, y: 0.5 });
    expect(data().smoothing).toBe(0.5);
    button('Add zoom segment').click(); view.scope.update();
    toggle('Follow focal path');
    expect(data().segments[0].follow).toBe(true);
    const saved = normalizeProject(store.project).tracks[0].clips[0].focusFollow;
    expect(saved.points).toEqual(data().points);
    button('Remove focal point').click();
    expect(data().points).toHaveLength(1);
  });

  it('makes one global canvas frame available in ordinary project settings', () => {
    const { store } = setup({ project: true });
    toggle('Outer canvas frame');
    number('Canvas padding', 12); number('Canvas corner radius', 6);
    expect(store.project.settings.canvasFrame).toMatchObject({ enabled: true, padding: 0.12, radius: 0.06 });
    expect(normalizeProject(store.project).settings.canvasFrame).toMatchObject({ enabled: true, padding: 0.12, radius: 0.06 });
    store.undo();
    expect(store.project.settings.canvasFrame.radius).toBe(0.04);
    expect([...el.querySelectorAll('.field-label')].filter((f) => f.textContent === 'Canvas background')).toHaveLength(1);
  });
});

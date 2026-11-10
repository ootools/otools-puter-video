// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, makeClip, normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createClipView } from '../src/ui/inspector/common.js';
import { basicTab } from '../src/ui/inspector/video.js';

let el;
afterEach(() => el?.remove());
function setup() {
  const p = createProject();
  p.assets.a = { id: 'a', kind: 'video', duration: 10e6, width: 1920, height: 1080 };
  p.tracks[0].clips.push(makeClip('video', { id: 'screen', assetId: 'a', duration: 10e6, otoolsRecording: { version: 1, role: 'screen', data: {
    version: 1, width: 1920, height: 1080, fps: 30, duration: 10, pointer: [],
    zooms: [{ id: 'z1', start: 1, end: 3, scale: 2, follow: true, x: 0.5, y: 0.5 }],
    background: { style: 'gradient', color: '#112233', color2: '#445566', padding: 0.1, radius: 0.05 },
    camera: { enabled: false, x: 0.7, y: 0.7, size: 0.2, roundness: 1 }, showPointer: true, clickEffects: true,
  } } }));
  const store = new EditorStore(p);
  const ctx = { store }; ctx.actions = createActions(ctx);
  const view = createClipView(ctx, 'screen');
  el = basicTab(view); document.body.append(el);
  return { store, view, data: () => view.clip.otoolsRecording.data };
}
function number(label, value) {
  const field = [...el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);
  expect(field, `recording field ${label}`).toBeTruthy();
  const input = field.querySelector('.num-input');
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('recording inspector', () => {
  it('edits original zoom timing/scale/fixed target and appearance with undo and save normalization', () => {
    const { store, view, data } = setup();
    number('Zoom start', 1.5);
    number('Zoom end', 4);
    number('Zoom multiplier', 3);
    number('Zoom center X', 75);
    number('Zoom center Y', 25);
    number('Recording padding', 12);
    number('Recording corner radius', 6);
    expect(data().zooms[0]).toMatchObject({ start: 1.5, end: 4, scale: 3, x: 0.75, y: 0.25 });
    expect(data().background).toMatchObject({ padding: 0.12, radius: 0.06 });
    store.undo(); view.scope.update();
    expect(data().background.radius).toBe(0.05);
    expect(normalizeProject(store.project).tracks[0].clips[0].otoolsRecording.data.zooms[0].scale).toBe(3);
  });

  it('adds and removes zoom segments and keeps normal transform controls', () => {
    const { store, view, data } = setup();
    store.seek(5e6);
    const button = (name) => [...el.querySelectorAll('button')].find((b) => b.textContent === name);
    expect(button('Add recording zoom')).toBeTruthy();
    button('Add recording zoom').click(); view.scope.update();
    expect(data().zooms.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 1, end: 3 }, { start: 5, end: 7 }]);
    button('Remove recording zoom').click(); view.scope.update();
    expect(data().zooms).toHaveLength(1);
    expect(el.textContent).toContain('Transform');
  });
});

import { h } from '../lib/dom.js';
import { colorField, selectField, sliderField, switchField } from '../ui/controls.js';
import { DEFAULT_CANVAS_FRAME } from './canvas-frame.js';

/** Part of the existing project canvas settings, shared by inspector and dialog. */
export function canvasFrameFields(ctx) {
  const { store } = ctx;
  const value = () => store.project.settings.canvasFrame || DEFAULT_CANVAS_FRAME;
  const edit = (label, key, v, final = true) => {
    store.update(label, (p) => { p.settings.canvasFrame = { ...DEFAULT_CANVAS_FRAME, ...p.settings.canvasFrame, [key]: v }; }, { structural: false, coalesce: `canvas-frame-${key}` });
    if (final) store.seal();
  };
  const body = h('div');
  const enabled = switchField({ label: 'Outer canvas frame', checked: value().enabled, onChange: (v) => {
    edit('Outer canvas frame', 'enabled', v); body.hidden = !v;
  } });
  body.hidden = !value().enabled;
  const style = selectField({ label: 'Frame fill', value: value().style, options: [{ value: 'solid', label: 'Color' }, { value: 'gradient', label: 'Gradient' }], onChange: (v) => edit('Frame fill', 'style', v) });
  body.append(h('p.asset-hint', 'The outer frame surrounds the whole composition, including overlays and titles. Canvas background fills empty space inside it.'), style.el);
  for (const [key, label] of [['color', 'Frame color'], ['color2', 'Frame gradient color']]) {
    body.append(colorField({ label, value: value()[key], onInput: (v, final) => edit(label, key, v, final) }).el);
  }
  for (const [key, label, max] of [['padding', 'Canvas padding', 20], ['radius', 'Canvas corner radius', 10]]) {
    body.append(sliderField({ label, min: 0, max, step: 0.1, unit: '%', value: value()[key] * 100,
      onInput: (v, final) => edit(label, key, v / 100, final) }).el);
  }
  return h('div.canvas-frame-settings', enabled.el, body);
}

import { h } from '../lib/dom.js';
import { sourceTimeAt } from '../model/timeline.js';
import { slider, toggle, color, row, propSection, note } from '../ui/inspector/common.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Recording controls edit the original source timeline; native camera controls stay native. */
export function recordingSection(view) {
  if (view.clip?.otoolsRecording?.role !== 'screen') return null;
  const data = (c = view.clip) => c.otoolsRecording.data;
  let selected = data().zooms[0]?.id;
  const zoom = (c = view.clip) => data(c).zooms.find((z) => z.id === selected);
  const edit = (label, fn, final = true) => view.edit(label, (c) => fn(data(c)), { key: `recording-${label}`, final });
  const fields = [];
  const numeric = (label, min, max, step, get, set, unit = '') => {
    const f = slider(view, { label, min, max, step, unit, get: (c) => get(data(c)), set: (v, final) => edit(label, (p) => set(p, v), final) });
    return f.el;
  };
  const boolean = (label, get, set) => toggle(view, { label, get: (c) => get(data(c)), set: (v) => edit(label, (p) => set(p, v)) }).el;
  fields.push(note('Zoom times refer to the original recording, including after trimming or changing speed.'));
  fields.push(boolean('Show recording pointer', (p) => p.showPointer, (p, v) => { p.showPointer = v; }));
  fields.push(boolean('Recording click effects', (p) => p.clickEffects, (p, v) => { p.clickEffects = v; }));
  fields.push(boolean('Recording gradient', (p) => p.background.style === 'gradient', (p, v) => { p.background.style = v ? 'gradient' : 'solid'; }));
  for (const [key, label] of [['color', 'Recording background color'], ['color2', 'Recording gradient color']]) {
    fields.push(color(view, { label, get: (c) => data(c).background[key], set: (v, final) => edit(label, (p) => { p.background[key] = v; }, final) }).el);
  }
  fields.push(numeric('Recording padding', 0, 20, 0.1, (p) => p.background.padding * 100, (p, v) => { p.background.padding = v / 100; }, '%'));
  fields.push(numeric('Recording corner radius', 0, 10, 0.1, (p) => p.background.radius * 100, (p, v) => { p.background.radius = v / 100; }, '%'));

  const select = h('select.input', { 'aria-label': 'Recording zoom segment' });
  select.addEventListener('change', () => { selected = select.value; view.scope.update(); });
  fields.push(row('Recording zoom segment', select));
  const controls = h('div');
  const zoomNumber = (label, key, min, max, step, unit = '', factor = 1) => {
    const field = slider(view, {
      label, min, max, step, unit,
      get: (c) => (zoom(c)?.[key] ?? min / factor) * factor,
      set: (v, final) => edit(label, (p) => {
        const i = p.zooms.findIndex((z) => z.id === selected), z = p.zooms[i];
        if (!z) return;
        if (key === 'start') z.start = clamp(v, p.zooms[i - 1]?.end ?? 0, z.end - 0.01);
        else if (key === 'end') z.end = clamp(v, z.start + 0.01, p.zooms[i + 1]?.start ?? p.duration);
        else z[key] = clamp(v, min, max) / factor;
      }, final),
    });
    controls.append(field.el);
  };
  zoomNumber('Zoom start', 'start', 0, data().duration, 0.01, 's');
  zoomNumber('Zoom end', 'end', 0, data().duration, 0.01, 's');
  zoomNumber('Zoom multiplier', 'scale', 1, 6, 0.1, '×');
  controls.append(toggle(view, { label: 'Follow recording pointer', get: (c) => zoom(c)?.follow ?? false, set: (v) => edit('Follow recording pointer', (p) => { const z = p.zooms.find((z) => z.id === selected); if (z) z.follow = v; }) }).el);
  zoomNumber('Zoom center X', 'x', 0, 100, 0.1, '%', 100);
  zoomNumber('Zoom center Y', 'y', 0, 100, 0.1, '%', 100);
  fields.push(controls);
  const add = h('button.btn.small', { type: 'button' }, 'Add recording zoom');
  const remove = h('button.btn.small', { type: 'button' }, 'Remove recording zoom');
  add.addEventListener('click', () => {
    const position = sourceTimeAt(view.clip, view.store.time) / 1e6;
    edit('Add recording zoom', (p) => {
      const start = clamp(position, 0, p.duration - 0.01);
      const end = Math.min(start + 2, p.zooms.find((z) => z.start > start)?.start ?? p.duration);
      if (p.zooms.some((z) => start >= z.start && start < z.end) || end < start + 0.01) return;
      selected = crypto.randomUUID();
      p.zooms.push({ id: selected, start, end, scale: 2, follow: true, x: 0.5, y: 0.5 });
      p.zooms.sort((a, b) => a.start - b.start);
    });
    view.scope.update();
  });
  remove.addEventListener('click', () => {
    edit('Remove recording zoom', (p) => { p.zooms = p.zooms.filter((z) => z.id !== selected); selected = p.zooms[0]?.id; });
    view.scope.update();
  });
  fields.push(h('div.section-actions', add, remove));
  let signature;
  const sync = () => {
    const p = data();
    if (!p.zooms.some((z) => z.id === selected)) selected = p.zooms[0]?.id;
    const next = p.zooms.map((z) => `${z.id}:${z.start}:${z.end}`).join('|');
    if (next !== signature) {
      signature = next;
      select.replaceChildren(...p.zooms.map((z, i) => h('option', { value: z.id }, `${i + 1} · ${z.start.toFixed(2)}–${z.end.toFixed(2)} s`)));
    }
    select.value = selected || '';
    select.disabled = !p.zooms.length;
    controls.hidden = !p.zooms.length;
    remove.disabled = !p.zooms.length;
  };
  view.bind(sync);
  sync();
  return propSection('Screen recording', fields);
}

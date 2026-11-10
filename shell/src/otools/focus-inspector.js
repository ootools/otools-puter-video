import { h } from '../lib/dom.js';
import { sourceTimeAt } from '../model/timeline.js';
import { slider, toggle, row, propSection, note } from '../ui/inspector/common.js';
import { defaultFocusFollow } from './focus-follow.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Available on every video, including imports with no authored path. */
export function focusSection(view) {
  if (view.clip?.type !== 'video') return null;
  const defaults = () => defaultFocusFollow(view.clip, view.project.assets[view.clip.assetId]);
  const data = (c = view.clip) => c.focusFollow || defaults();
  let selected = data().segments[0]?.id, selectedPoint = 0;
  const zoom = (c = view.clip) => data(c).segments.find((z) => z.id === selected);
  const point = (c = view.clip) => data(c).points[selectedPoint];
  const edit = (label, fn, final = true) => {
    view.edit(label, (c) => { c.focusFollow ||= defaults(); fn(c.focusFollow); }, { key: `focus-${label}`, final });
    view.scope.update();
  };
  const boolean = (label, get, set) => toggle(view, { label, get: (c) => get(data(c)), set: (v) => edit(label, (p) => set(p, v)) }).el;
  const fields = [boolean('Enable focus and zoom', (p) => p.enabled, (p, v) => { p.enabled = v; })];
  const body = h('div');
  body.append(note('Focus and zoom times refer to the original video, including after trimming or changing speed.'));
  body.append(boolean('Show path pointer', (p) => p.showPointer, (p, v) => { p.showPointer = v; }));
  body.append(boolean('Click effects', (p) => p.clickEffects, (p, v) => { p.clickEffects = v; }));
  body.append(slider(view, { label: 'Focus smoothing', min: 0, max: 2, step: 0.01, unit: 's', get: (c) => data(c).smoothing ?? 0.22, set: (v, final) => edit('Focus smoothing', (p) => { p.smoothing = v; }, final) }).el);

  const select = h('select.input', { 'aria-label': 'Zoom segment' });
  select.addEventListener('change', () => { selected = select.value; view.scope.update(); });
  body.append(row('Zoom segment', select));
  const controls = h('div');
  const zoomNumber = (label, key, min, max, step, unit = '', factor = 1) => {
    controls.append(slider(view, {
      label, min, max, step, unit,
      get: (c) => (zoom(c)?.[key] ?? min / factor) * factor,
      set: (v, final) => edit(label, (p) => {
        const i = p.segments.findIndex((z) => z.id === selected), z = p.segments[i];
        if (!z) return;
        if (key === 'start') z.start = clamp(v, p.segments[i - 1]?.end ?? 0, z.end - 0.01);
        else if (key === 'end') z.end = clamp(v, z.start + 0.01, p.segments[i + 1]?.start ?? p.sourceDuration);
        else z[key] = clamp(v, min, max) / factor;
      }, final),
    }).el);
  };
  zoomNumber('Zoom start', 'start', 0, data().sourceDuration, 0.01, 's');
  zoomNumber('Zoom end', 'end', 0, data().sourceDuration, 0.01, 's');
  zoomNumber('Zoom multiplier', 'scale', 1, 6, 0.1, '×');
  controls.append(toggle(view, { label: 'Follow focal path', get: (c) => zoom(c)?.follow ?? false, set: (v) => edit('Follow focal path', (p) => { const z = p.segments.find((z) => z.id === selected); if (z) z.follow = v; }) }).el);
  zoomNumber('Zoom center X', 'x', 0, 100, 0.1, '%', 100);
  zoomNumber('Zoom center Y', 'y', 0, 100, 0.1, '%', 100);
  body.append(controls);
  const add = h('button.btn.small', { type: 'button' }, 'Add zoom segment');
  const remove = h('button.btn.small', { type: 'button' }, 'Remove zoom segment');
  add.addEventListener('click', () => {
    const position = sourceTimeAt(view.clip, view.store.time) / 1e6;
    edit('Add zoom segment', (p) => {
      const start = clamp(position, 0, p.sourceDuration - 0.01);
      const end = Math.min(start + 2, p.segments.find((z) => z.start > start)?.start ?? p.sourceDuration);
      if (p.segments.some((z) => start >= z.start && start < z.end) || end < start + 0.01) return;
      selected = crypto.randomUUID();
      p.segments.push({ id: selected, start, end, scale: 2, follow: false, x: 0.5, y: 0.5 });
      p.segments.sort((a, b) => a.start - b.start);
    });
  });
  remove.addEventListener('click', () => edit('Remove zoom segment', (p) => { p.segments = p.segments.filter((z) => z.id !== selected); selected = p.segments[0]?.id; }));
  body.append(h('div.section-actions', add, remove));

  body.append(note('Add focal points at source times to animate the focus. Enable Follow focal path on a zoom segment to use them.'));
  const pointSelect = h('select.input', { 'aria-label': 'Focal point' });
  pointSelect.addEventListener('change', () => { selectedPoint = Number(pointSelect.value); view.scope.update(); });
  body.append(row('Focal point', pointSelect));
  const pointControls = h('div');
  for (const [label, key, max, factor] of [['Focal point time', 't', data().sourceDuration, 1], ['Focal point X', 'x', 100, 100], ['Focal point Y', 'y', 100, 100]]) {
    pointControls.append(slider(view, { label, min: 0, max, step: 0.01, unit: key === 't' ? 's' : '%',
      get: (c) => (point(c)?.[key] ?? 0) * factor,
      set: (v, final) => edit(label, (p) => {
        const s = p.points[selectedPoint];
        if (!s) return;
        s[key] = clamp(v, 0, max) / factor;
        p.points.sort((a, b) => a.t - b.t);
        selectedPoint = p.points.indexOf(s);
        p.points = [...p.points]; // invalidate the prepared path even for coalesced edits
      }, final),
    }).el);
  }
  const addPoint = h('button.btn.small', { type: 'button' }, 'Add focal point');
  const removePoint = h('button.btn.small', { type: 'button' }, 'Remove focal point');
  addPoint.addEventListener('click', () => edit('Add focal point', (p) => {
    const t = clamp(sourceTimeAt(view.clip, view.store.time) / 1e6, 0, p.sourceDuration);
    const existing = p.points.findIndex((s) => s.t === t);
    if (existing >= 0) { selectedPoint = existing; return; }
    const s = { t, x: 0.5, y: 0.5 };
    p.points = [...p.points, s].sort((a, b) => a.t - b.t);
    selectedPoint = p.points.indexOf(s);
  }));
  removePoint.addEventListener('click', () => edit('Remove focal point', (p) => {
    p.points = p.points.filter((_, i) => i !== selectedPoint);
    selectedPoint = Math.max(0, selectedPoint - 1);
  }));
  body.append(pointControls, h('div.section-actions', addPoint, removePoint));
  fields.push(body);

  let signature, pointSignature;
  const sync = () => {
    const p = data();
    body.hidden = !p.enabled;
    if (!p.segments.some((z) => z.id === selected)) selected = p.segments[0]?.id;
    const next = p.segments.map((z) => `${z.id}:${z.start}:${z.end}`).join('|');
    if (next !== signature) {
      signature = next;
      select.replaceChildren(...p.segments.map((z, i) => h('option', { value: z.id }, `${i + 1} · ${z.start.toFixed(2)}–${z.end.toFixed(2)} s`)));
    }
    select.value = selected || '';
    select.disabled = controls.hidden = remove.disabled = !p.segments.length;
    selectedPoint = clamp(selectedPoint, 0, Math.max(0, p.points.length - 1));
    // Large imported paths stay editable without mounting millions of option nodes.
    const first = Math.max(0, selectedPoint - 50), last = Math.min(p.points.length, first + 101);
    const ps = `${first}:${last}:${p.points.slice(first, last).map((s) => s.t).join(',')}`;
    if (ps !== pointSignature) {
      pointSignature = ps;
      pointSelect.replaceChildren(...p.points.slice(first, last).map((s, i) => h('option', { value: String(first + i) }, `${first + i + 1} · ${s.t.toFixed(2)} s`)));
    }
    pointSelect.value = String(selectedPoint);
    pointSelect.disabled = pointControls.hidden = removePoint.disabled = !p.points.length;
  };
  view.bind(sync);
  sync();
  return propSection('Focus and zoom', fields);
}

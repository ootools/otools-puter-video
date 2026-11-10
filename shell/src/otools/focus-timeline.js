import { h } from '../lib/dom.js';
import { findClip, sourceTimeAt } from '../model/timeline.js';
import { localAtSource } from '../model/speed-curve.js';
import { selectedFocusSegment, selectFocusSegment, setFocusSegmentEdge } from './focus-follow.js';
import './focus-timeline.css';

/** Clip-local display only. The project keeps its existing source-second segments. */
export function createFocusTimeline(ctx, { projectTime, pixelsPerSecond }) {
  const { store, actions } = ctx;
  const states = new WeakMap();
  let active = null;
  const bounds = (clip) => ({ start: clip.in / 1e6,
    end: Math.min(clip.focusFollow.sourceDuration, sourceTimeAt(clip, clip.start + clip.duration) / 1e6) });
  const choose = (clipId, id) => {
    selectFocusSegment(store, clipId, id);
    store.select(clipId);
    ctx.inspector?.showVideoSub('basic');
  };
  const stop = (event) => event.stopPropagation();
  function finish(commit) {
    const drag = active;
    if (!drag) return;
    active = null;
    drag.state.strip.releasePointerCapture?.(drag.pointerId);
    const found = findClip(store.project, drag.clipId);
    // A concurrent undo, trim, lock, or deletion invalidates the preview.
    if (commit && drag.moved && found && !found.track.locked && store.revision === drag.revision) {
      actions.editClip(drag.clipId, drag.edge === 'start' ? 'Zoom start' : 'Zoom end', (clip) =>
        setFocusSegmentEdge(clip.focusFollow, drag.id, drag.edge, drag.value, bounds(clip)));
      store.seal();
    }
    if (found) paint(drag.state, found.clip, found.track);
  }
  function paint(state, clip, track) {
    const p = clip.focusFollow, window = bounds(clip), keep = new Set();
    state.strip.hidden = !p.segments.length;
    state.strip.classList.toggle('focus-off', !p.enabled);
    for (const [index, original] of p.segments.entries()) {
      const z = active?.state === state && active.id === original.id
        ? { ...original, [active.edge]: active.value } : original;
      if (z.end <= window.start || z.start >= window.end) continue;
      keep.add(z.id);
      let bar = state.bars.get(z.id);
      if (!bar) {
        const select = h('button.focus-segment-select', { type: 'button' });
        const start = h('button.focus-edge.focus-start', { type: 'button', 'data-focus-edge': 'start', 'aria-label': 'Zoom start', title: 'Zoom start' }, '│');
        const end = h('button.focus-edge.focus-end', { type: 'button', 'data-focus-edge': 'end', 'aria-label': 'Zoom end', title: 'Zoom end' }, '│');
        const node = h('div.focus-segment', { 'data-focus-segment': z.id }, select, start, end);
        bar = { node, select, start, end }; state.bars.set(z.id, bar); state.strip.append(node);
      }
      const left = localAtSource(clip, Math.max(z.start, window.start) * 1e6 - clip.in) / 1e6 * pixelsPerSecond();
      const right = localAtSource(clip, Math.min(z.end, window.end) * 1e6 - clip.in) / 1e6 * pixelsPerSecond();
      Object.assign(bar.node.style, { left: `${left}px`, width: `${Math.max(0, right - left)}px` });
      // Tiny segments retain their exact position; their two handles split the width.
      bar.node.style.setProperty('--focus-handle', `${Math.min(7, (right - left) / 2)}px`);
      bar.select.textContent = `${z.scale}×`;
      const label = `Zoom segment ${index + 1}: ${z.start.toFixed(2)}–${z.end.toFixed(2)} s · ${z.scale}×`;
      bar.select.title = label; bar.select.setAttribute('aria-label', label);
      bar.select.setAttribute('aria-pressed', String(store.selection.has(clip.id) && selectedFocusSegment(store, clip) === z.id));
      for (const edge of ['start', 'end']) {
        bar[edge].setAttribute('aria-disabled', String(Boolean(track.locked || clip.freeze)));
        bar[edge].classList.toggle('clipped', edge === 'start' ? z.start < window.start : z.end > window.end);
      }
    }
    for (const [id, bar] of state.bars) if (!keep.has(id)) { bar.node.remove(); state.bars.delete(id); }
  }
  function mount(node, clipId) {
    const strip = h('div.focus-strip', { role: 'group', 'aria-label': 'Focus and zoom' });
    const state = { strip, bars: new Map() }; node.append(strip); states.set(node, state);
    // Own this lane's pointer/key gestures before the timeline's trim, split and move handlers.
    for (const event of ['mousedown', 'dblclick', 'contextmenu', 'pointerover', 'pointerout']) strip.addEventListener(event, stop);
    strip.addEventListener('click', (event) => {
      stop(event);
      const id = event.target.closest('[data-focus-segment]')?.dataset.focusSegment;
      if (id) choose(clipId, id);
    });
    strip.addEventListener('pointerdown', (event) => {
      stop(event);
      if (event.button !== 0 || active) return;
      event.preventDefault();
      const id = event.target.closest('[data-focus-segment]')?.dataset.focusSegment;
      if (!id) return;
      choose(clipId, id);
      const found = findClip(store.project, clipId);
      const edge = event.target.closest('[data-focus-edge]')?.dataset.focusEdge;
      if (!edge || !found || found.track.locked || found.clip.freeze) return;
      const z = found.clip.focusFollow.segments.find((s) => s.id === id);
      active = { state, clipId, id, edge, pointerId: event.pointerId, revision: store.revision,
        value: z[edge], from: projectTime(event), x: event.clientX, moved: false };
      strip.setPointerCapture(event.pointerId);
    });
    strip.addEventListener('pointermove', (event) => {
      stop(event);
      const drag = active;
      if (!drag || drag.state !== state || drag.pointerId !== event.pointerId) return;
      const found = findClip(store.project, clipId);
      if (!found || found.track.locked || store.revision !== drag.revision) { finish(false); return; }
      const time = projectTime(event);
      if (!drag.moved && Math.abs(event.clientX - drag.x) < 2 && Math.abs(time - drag.from) * pixelsPerSecond() / 1e6 < 2) return;
      drag.moved = true; ctx.player.pause();
      const clip = found.clip, p = clip.focusFollow;
      // Preview copies only the segments, never the potentially large focal path.
      const preview = { ...p, segments: p.segments.map((z) => ({ ...z })) };
      setFocusSegmentEdge(preview, drag.id, drag.edge, sourceTimeAt(clip, time) / 1e6, bounds(clip));
      drag.value = preview.segments.find((z) => z.id === drag.id)[drag.edge];
      paint(state, clip, found.track);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) strip.addEventListener(type, (event) => {
      stop(event);
      if (active?.state === state && active.pointerId === event.pointerId) finish(type === 'pointerup');
    });
    strip.addEventListener('keydown', (event) => {
      stop(event);
      if (event.key === 'Escape') { event.preventDefault(); finish(false); return; }
      const edge = event.target.closest('[data-focus-edge]')?.dataset.focusEdge;
      if (!edge || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const id = event.target.closest('[data-focus-segment]').dataset.focusSegment;
      choose(clipId, id);
      actions.editClip(clipId, edge === 'start' ? 'Zoom start' : 'Zoom end', (clip) => {
        if (clip.freeze) return false;
        const z = clip.focusFollow.segments.find((s) => s.id === id);
        const local = localAtSource(clip, z[edge] * 1e6 - clip.in);
        const time = clip.start + local + (event.key === 'ArrowRight' ? 1 : -1) * 1e6 / store.fps;
        return setFocusSegmentEdge(clip.focusFollow, id, edge, sourceTimeAt(clip, time) / 1e6, bounds(clip));
      });
      store.seal();
    });
    return state;
  }
  return {
    render(node, clip, track) {
      let state = states.get(node);
      const visible = clip.type === 'video' && clip.focusFollow?.segments?.length > 0;
      node.classList.toggle('has-focus-strip', visible);
      if (!visible) { if (state) state.strip.hidden = true; return; }
      state ||= mount(node, clip.id);
      if (active?.state === state && (!node.isConnected || store.revision !== active.revision || track.locked)) finish(false);
      paint(state, clip, track);
    },
    dispose() { finish(false); },
  };
}

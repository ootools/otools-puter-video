/**
 * 编辑器 / 时间线级 MCP 工具：AI 真正「剪片」用的那一层。
 * ------------------------------------------------------------------
 * 全部工具都跑在**当前打开的编辑器**上（`requireEditor()`），调用的是应用自己的
 * action 层（`ctx.actions`）和 store，因此：
 *
 *   - 每一步都是**可撤销的**（store.update 记 undo 栈），跟人手动操作没有区别；
 *   - 界面会跟着变（面板、播放器、时间线都订阅 store 事件）；
 *   - 不需要重新实现一遍剪辑逻辑，也不会与上游行为漂移。
 *
 * 单位：对外一律秒，内部转微秒（`mcp-context.js` 的 `micros/seconds`）。
 *
 * 刻意的取舍：
 *   - **不提供删除工程**（那是「移入回收站」，时机该由用户定）；删除**片段**可以，
 *     因为它在 undo 栈里，一步就能撤回。
 *   - 工具名保持动宾结构（`add_clip` / `update_clip` / `apply_transition`），
 *     让 AI 不用猜参数顺序。
 */

import { ANIMATIONS, BLEND_MODES, EFFECTS, FILTERS, TRANSITIONS, STICKER_CATEGORIES } from '../model/catalog.js';
import { TEXT_EFFECTS, TEXT_PRESETS } from '../model/text-presets.js';
import { TEXT_STYLE_EXTRAS, normTextExtras } from '../model/text-style.js';
import { KEYFRAME_PROPS, setKey, removeKey, keyIndexAt, isEase } from '../model/keyframes.js';
import { US } from '../lib/time.js';
import {
  MIN_CLIP,
  deleteClips,
  findClip,
  findTrack,
  splitClip,
  addClip,
  insertTrackNear,
  deleteTrack,
  moveTrack,
  toggleSolo,
  renameTrack,
  groupClips,
  ungroupClips,
  detachAudio as detachAudioClip,
  setDisabled,
  setRangeIn,
  setRangeOut,
  clearRange,
  removeRange,
  rangeFromClips,
} from '../model/timeline.js';
import * as TL from '../model/timelines.js';
import { findMatches, replaceAll, replaceOne } from '../model/find-replace.js';
import { makeClip, DEFAULT_TEXT_STYLE, MARKER_COLORS } from '../model/project.js';
import { uid } from '../lib/ids.js';
import { STICKERS } from '../engine/stickers.js';
import { CAPTION_STYLES } from '../model/caption-styles.js';
import { normalizeGrade } from '../model/color.js';
import { TEMPLATES, TEMPLATES_BY_ID, TEMPLATE_CATEGORIES } from '../model/templates.js';
import { SPEED_RAMPS, findRamp } from '../model/speed-ramps.js';
import { CURVE_PRESETS } from '../model/speed-curve.js';
import { ATTRIBUTE_GROUPS } from '../ui/organize-actions.js';
import { insertTemplate } from '../ui/template-insert.js';
import { applyLut, autoAdjust } from '../ui/color-tools.js';
import {
  requireEditor,
  requireLibrary,
  text,
  seconds,
  micros,
  optionalMicros,
  optionalNumber,
  requiredId,
} from './mcp-context.js';

/* ------------------------------------------------------------ 文本样式 */

const CORE_TEXT_KEYS = new Set([
  'font', 'size', 'color', 'bold', 'italic', 'underline', 'align',
  'letterSpacing', 'lineHeight', 'strokeColor', 'strokeWidth', 'bgColor',
  'bgOpacity', 'bgRadius', 'shadowColor', 'shadowOpacity', 'shadowBlur',
  'shadowDistance', 'shadowAngle',
]);
const TEXT_ALIGNS = ['left', 'center', 'right'];
const hexColor = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);
const clampN = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/**
 * Merge a style patch into a clip's style, validating every key against the
 * known core fields and the text-style extras (normTextExtras). Unknown keys
 * are dropped rather than written, so AI-supplied styles can never corrupt a
 * clip. The renderer reads clip.style directly, so no further wiring is needed.
 */
function mergeTextStyle(clip, patch) {
  const s = clip.style || (clip.style = {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (!CORE_TEXT_KEYS.has(k)) continue;
    if (k === 'font') {
      if (typeof v === 'string' && v) s.font = String(v).slice(0, 40);
    } else if (k === 'size') {
      s.size = clampN(v, 4, 2000, 64);
    } else if (k === 'align') {
      if (TEXT_ALIGNS.includes(v)) s.align = v;
    } else if (k === 'bold' || k === 'italic' || k === 'underline') {
      s[k] = Boolean(v);
    } else if (k === 'letterSpacing' || k === 'lineHeight') {
      s[k] = clampN(v, -50, 50, k === 'letterSpacing' ? 0 : 1.2);
    } else if (k === 'strokeWidth') {
      s[k] = clampN(v, 0, 40, 0);
    } else if (k === 'color' || k === 'strokeColor' || k === 'bgColor' || k === 'shadowColor') {
      s[k] = hexColor(v, k === 'color' ? '#ffffff' : '#000000');
    } else if (k === 'bgOpacity' || k === 'shadowOpacity') {
      s[k] = clampN(v, 0, 1, 0);
    } else if (k === 'bgRadius' || k === 'shadowBlur' || k === 'shadowDistance' || k === 'shadowAngle') {
      s[k] = clampN(v, 0, 200, k === 'bgRadius' ? 8 : 0);
    }
  }
  const extras = {};
  for (const k of Object.keys(TEXT_STYLE_EXTRAS)) if (k in (patch || {})) extras[k] = patch[k];
  if (Object.keys(extras).length) Object.assign(s, normTextExtras(extras));
  return s;
}

/** Find an animation id in any category. */
function findAnimation(animId) {
  for (const list of Object.values(ANIMATIONS)) {
    const hit = (list || []).find((item) => item.id === animId);
    if (hit) return hit;
  }
  return null;
}

/** Set animIn / animOut / animLoop on a clip (mirrors actions.applyAnimation). */
function setClipAnimation(clip, kind, animId, duration) {
  const key = kind === 'in' ? 'animIn' : kind === 'out' ? 'animOut' : 'animLoop';
  const def = kind === 'loop' ? 2 * US : US; // upstream defaultLength.animation() ≈ 1s
  if (!animId) {
    clip[key] = null;
  } else {
    clip[key] = { id: animId, duration: Math.min(duration ?? clip[key]?.duration ?? def, clip.duration) };
    if (kind === 'loop') {
      clip.animIn = null;
      clip.animOut = null;
    } else {
      clip.animLoop = null;
    }
  }
}

/* ------------------------------------------------------------ 摘要 */

function clipSummary(clip) {
  const out = {
    id: clip.id,
    type: clip.type,
    name: clip.name || '',
    startSeconds: seconds(clip.start),
    durationSeconds: seconds(clip.duration),
  };
  if (clip.assetId) out.assetId = clip.assetId;
  if (clip.type === 'video' || clip.type === 'audio' || clip.type === 'image') {
    out.inSeconds = seconds(clip.in);
    out.speed = clip.speed ?? 1;
  }
  if (typeof clip.volume === 'number') out.volume = clip.volume;
  if (typeof clip.opacity === 'number') out.opacity = clip.opacity;
  if (clip.muted) out.muted = true;
  if (clip.text != null) out.text = clip.text;
  if (clip.filter) out.filter = typeof clip.filter === 'string' ? clip.filter : clip.filter.id;
  if (clip.effect) out.effect = clip.effect;
  if (clip.transition) {
    out.transition = {
      id: clip.transition.id,
      durationSeconds: seconds(clip.transition.duration),
    };
  }
  const keyed = Object.keys(clip.keyframes || {});
  if (keyed.length) out.keyframes = keyed;
  return out;
}

function trackSummary(track) {
  return {
    id: track.id,
    kind: track.kind,
    main: Boolean(track.main),
    locked: Boolean(track.locked),
    hidden: Boolean(track.hidden),
    muted: Boolean(track.muted),
    clips: track.clips.map(clipSummary),
  };
}

/* ------------------------------------------------------------ 工具实现 */

async function runGetEditorState() {
  const ctx = requireEditor();
  const project = ctx.store.project;

  return text({
    projectId: project.id,
    name: project.name,
    settings: { ...project.settings },
    fps: ctx.store.fps,
    durationSeconds: seconds(ctx.store.duration),
    playheadSeconds: seconds(ctx.store.time),
    range: project.range
      ? { inSeconds: seconds(project.range.in), outSeconds: seconds(project.range.out) }
      : null,
    selection: ctx.store.selectedIds,
    canUndo: ctx.store.history.canUndo(),
    canRedo: ctx.store.history.canRedo(),
    dirty: ctx.store.dirty,
    compoundDepth: ctx.store.nest.length,
    timelines: (ctx.timelines?.list() || []).map((t) => ({
      id: t.id,
      name: t.name,
      active: t.id === project.timelineId,
    })),
    tracks: project.tracks.map(trackSummary),
    assets: Object.values(project.assets || {}).map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationSeconds: seconds(asset.duration),
      width: asset.width,
      height: asset.height,
    })),
    markers: (project.markers || []).map((marker) => ({
      id: marker.id,
      timeSeconds: seconds(marker.time),
      color: marker.color,
      label: marker.label || '',
    })),
  });
}

async function runListCatalog() {
  const animations = {};
  for (const [kind, list] of Object.entries(ANIMATIONS)) {
    animations[kind] = (list || []).map((item) => ({
      id: item.id,
      label: item.label,
      category: item.cat,
    }));
  }

  return text({
    effects: EFFECTS.map((item) => ({ id: item.id, label: item.label, category: item.cat })),
    filters: FILTERS.map((item) => ({ id: item.id, label: item.label, category: item.cat })),
    transitions: TRANSITIONS.map((item) => ({
      id: item.id,
      label: item.label,
      category: item.cat,
    })),
    animations,
    textLooks: [
      ...TEXT_PRESETS.map((item) => ({ id: item.id, label: item.label, kind: 'preset' })),
      ...TEXT_EFFECTS.map((item) => ({ id: item.id, label: item.label, kind: 'effect' })),
    ],
    blendModes: BLEND_MODES.map((item) => item.id),
    audioFxKeys: ['normalize', 'denoise', 'enhance', 'separate', 'pan', 'channel', 'voice'],
    sfx: 'listed by list_sfx; add with add_sfx',
    music: 'listed by list_music; add with add_music',
    stickers: STICKERS.map((item) => ({ id: item.id, label: item.label, category: item.cat })),
    stickerCategories: STICKER_CATEGORIES.map((item) => ({ id: item.id, label: item.label })),
    captionStyles: CAPTION_STYLES.map((item) => ({ id: item.id, label: item.label })),
    trackKinds: ['video', 'audio', 'text', 'graphic', 'adjust'],
    templates: TEMPLATES.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      ratio: item.ratio,
      description: item.description,
    })),
    templateCategories: TEMPLATE_CATEGORIES.map((item) =>
      typeof item === 'string' ? { id: item, label: item } : { id: item.id, label: item.label },
    ),
    attributeGroups: ATTRIBUTE_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      keys: group.keys,
      types: group.types,
    })),
    speedRamps: SPEED_RAMPS.map((item) => ({ id: item.id, label: item.label, hint: item.hint })),
    curvePresets: CURVE_PRESETS.map((item) => ({
      id: item.id,
      label: item.label,
      points: item.points.map((p) => ({ t: p.t, v: p.v })),
    })),
    luts: 'user-imported .cube files, listed by list_luts and attached by apply_lut',
  });
}

async function runListCommands() {
  const ctx = requireEditor();
  return text({
    commands: ctx.commands.list.map((command) => ({
      id: command.id,
      label: command.label,
      group: command.group,
      enabled: command.enabled ? Boolean(command.enabled()) : true,
    })),
  });
}

async function runCommand(args) {
  const ctx = requireEditor();
  const id = requiredId(args.id, 'command id');
  if (!ctx.commands.run(id)) {
    throw new Error(`Command ${id} is unknown or currently disabled. See list_commands.`);
  }
  return text({ id, ran: true });
}

async function runSetPlayhead(args) {
  const ctx = requireEditor();
  const time = micros(args.seconds, 'playhead time');
  ctx.store.seek(time);
  return text({ playheadSeconds: seconds(ctx.store.time), durationSeconds: seconds(ctx.store.duration) });
}

async function runAddClip(args) {
  const ctx = requireEditor();
  const assetId = requiredId(args.assetId, 'asset id');
  const asset = ctx.store.project.assets?.[assetId];
  if (!asset) {
    throw new Error(
      `Unknown asset ${assetId}. Call import_media first, or read the asset ids from get_editor_state.`,
    );
  }

  const clip = ctx.actions.addAsset(asset, {
    start: optionalMicros(args.startSeconds, 'start'),
    trackId: args.trackId ? String(args.trackId) : undefined,
    main: args.main === undefined ? undefined : Boolean(args.main),
  });
  if (!clip) throw new Error('The clip could not be added. Is the target track locked?');

  const duration = optionalMicros(args.durationSeconds, 'duration');
  if (duration !== undefined) {
    ctx.actions.editClip(clip.id, 'MCP: set clip duration', (c) => {
      c.duration = Math.max(MIN_CLIP, duration);
    });
  }

  const saved = findClip(ctx.store.project, clip.id)?.clip || clip;
  return text({ clip: clipSummary(saved) });
}

async function runAddText(args) {
  const ctx = requireEditor();
  const content = String(args.text == null ? '' : args.text).trim();
  if (!content) throw new Error('Text is required.');

  const clip = ctx.actions.addText(args.lookId ? String(args.lookId) : 'plain', {
    text: content,
    start: optionalMicros(args.startSeconds, 'start'),
    duration: optionalMicros(args.durationSeconds, 'duration'),
    trackId: args.trackId ? String(args.trackId) : undefined,
    y: args.y !== undefined ? Number(args.y) : undefined,
  });
  if (!clip) throw new Error('The text clip could not be added.');

  // Apply a custom style override on top of the chosen look.
  if (args.style && typeof args.style === 'object') {
    ctx.actions.editClip(clip.id, 'MCP: text style', (c) => mergeTextStyle(c, args.style));
  }

  const saved = findClip(ctx.store.project, clip.id)?.clip || clip;
  return text({ clip: clipSummary(saved) });
}

async function runUpdateClip(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (found.track.locked) throw new Error('That clip is on a locked track; unlock it first.');

  const speed = optionalNumber(patch.speed, 'speed');

  ctx.actions.editClip(clipId, 'MCP: update clip', (clip) => {
    if (patch.startSeconds != null) clip.start = Math.max(0, micros(patch.startSeconds, 'start'));
    if (patch.durationSeconds != null) {
      clip.duration = Math.max(MIN_CLIP, micros(patch.durationSeconds, 'duration'));
    }
    if (patch.inSeconds != null) clip.in = Math.max(0, micros(patch.inSeconds, 'source in point'));
    if (patch.volume != null) {
      clip.volume = Math.min(4, Math.max(0, Number(patch.volume) || 0));
    }
    if (patch.opacity != null) {
      clip.opacity = Math.min(1, Math.max(0, Number(patch.opacity) || 0));
    }
    if (patch.fadeInSeconds != null) {
      clip.fadeIn = Math.max(0, micros(patch.fadeInSeconds, 'fade in'));
    }
    if (patch.fadeOutSeconds != null) {
      clip.fadeOut = Math.max(0, micros(patch.fadeOutSeconds, 'fade out'));
    }
    if (patch.muted != null) clip.muted = Boolean(patch.muted);
    if (patch.name != null) clip.name = String(patch.name);
    if (patch.blend != null) clip.blend = String(patch.blend);
    if (patch.text != null && clip.type === 'text') clip.text = String(patch.text);
    if (patch.transform && clip.transform) {
      for (const key of ['x', 'y', 'scale', 'rotation']) {
        const value = optionalNumber(patch.transform[key], `transform.${key}`);
        if (value !== undefined) clip.transform[key] = value;
      }
    }
  });

  if (speed !== undefined) ctx.actions.setSpeed(clipId, speed);

  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clip: saved ? clipSummary(saved) : { id: clipId } });
}

/* ------------------------------------------------------------ 文本精细样式 */

async function runUpdateTextStyle(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (found.clip.type !== 'text') throw new Error('Text styling only applies to text clips.');
  if (found.track.locked) throw new Error('That clip is on a locked track; unlock it first.');
  if (!args.style || typeof args.style !== 'object') {
    throw new Error('Pass a style object (font, size, color, align, bold, strokeColor, shadowColor, bgColor, …).');
  }

  ctx.actions.editClip(clipId, 'MCP: text style', (clip) => mergeTextStyle(clip, args.style));
  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clipId, style: saved?.style || null });
}

/* ------------------------------------------------------------ 文本查找/替换 */

async function runFindReplaceText(args) {
  const ctx = requireEditor();
  const find = String(args.find == null ? '' : args.find);
  if (!find) throw new Error('find is required.');
  const opts = {
    matchCase: Boolean(args.matchCase),
    wholeWord: Boolean(args.wholeWord),
    captionsOnly: Boolean(args.captionsOnly),
  };
  const hasReplace = args.replace !== undefined && args.replace !== null;

  // 没有 replace：只查找，返回匹配（不改动）。
  if (!hasReplace) {
    const matches = findMatches(ctx.store.project, find, opts);
    return text({
      count: matches.length,
      matches: matches.map((m) => ({
        clipId: m.clipId,
        atSeconds: seconds(m.at),
        index: m.index,
        length: m.length,
        locked: m.locked,
      })),
    });
  }

  const replacement = String(args.replace);
  // 只替换第一处（未锁定的）。
  if (args.all === false) {
    const first = findMatches(ctx.store.project, find, opts).find((m) => !m.locked);
    if (!first) return text({ replaced: 0 });
    const ok = ctx.store.update('MCP: replace text', (p) => {
      const found = findClip(p, first.clipId);
      return found ? replaceOne(found.clip, first, replacement) : false;
    }, { structural: false });
    return text({ replaced: ok ? 1 : 0 });
  }

  let n = 0;
  ctx.store.update('MCP: replace all text', (p) => {
    n = replaceAll(p, find, replacement, opts);
    return n > 0;
  }, { structural: false });
  return text({ replaced: n });
}

/* ------------------------------------------------------------ 动画预设 */

async function runApplyAnimation(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const kind = String(args.kind || 'in');
  if (!['in', 'out', 'loop'].includes(kind)) {
    throw new Error(`kind must be 'in', 'out' or 'loop' (got ${kind}).`);
  }
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (!('animIn' in found.clip)) {
    throw new Error('Animations apply to video, image, text or graphic clips only.');
  }
  if (args.animationId) {
    if (!findAnimation(String(args.animationId))) {
      throw new Error(`Unknown animation ${args.animationId}. See list_catalog.`);
    }
  }

  const duration = optionalMicros(args.durationSeconds, 'animation duration');
  ctx.actions.editClip(clipId, 'MCP: animation', (clip) => setClipAnimation(clip, kind, args.animationId || null, duration));
  const saved = findClip(ctx.store.project, clipId)?.clip;
  const key = kind === 'in' ? 'animIn' : kind === 'out' ? 'animOut' : 'animLoop';
  return text({ clipId, [key]: saved?.[key] ?? null });
}

/* ------------------------------------------------------------ 关键帧精控 */

async function runSetKeyframe(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const prop = String(args.prop || '');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (!KEYFRAME_PROPS.includes(prop) && !prop.startsWith('adjust.')) {
    throw new Error(`prop must be one of ${KEYFRAME_PROPS.join(', ')} or 'adjust.<key>'.`);
  }
  const value = Number(args.value);
  if (!Number.isFinite(value)) throw new Error('value must be a number.');
  const ease = String(args.ease || 'linear');

  const local = micros(args.timeSeconds, 'keyframe time') - found.clip.start;
  if (local < 0 || local > found.clip.duration) {
    throw new Error('timeSeconds must fall inside the clip (0..duration).');
  }

  ctx.actions.editClip(clipId, 'MCP: set keyframe', (clip) => {
    clip.keyframes ||= {};
    setKey(clip.keyframes, prop, local, value, ease, Math.round(US / Math.max(1, ctx.store.fps) / 2));
  });
  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clipId, prop, timeSeconds: seconds(local + found.clip.start), value, ease });
}

async function runRemoveKeyframe(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const prop = String(args.prop || '');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (!KEYFRAME_PROPS.includes(prop) && !prop.startsWith('adjust.')) {
    throw new Error(`prop must be one of ${KEYFRAME_PROPS.join(', ')} or 'adjust.<key>'.`);
  }

  const local = micros(args.timeSeconds, 'keyframe time') - found.clip.start;
  const before = found.clip.keyframes?.[prop]?.length || 0;
  ctx.actions.editClip(clipId, 'MCP: remove keyframe', (clip) => {
    if (clip.keyframes) removeKey(clip.keyframes, prop, local, Math.round(US / Math.max(1, ctx.store.fps) / 2));
  });
  const saved = findClip(ctx.store.project, clipId)?.clip;
  const after = saved?.keyframes?.[prop]?.length || 0;
  return text({ clipId, prop, removed: before - after });
}

async function runSetKeyframeEase(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const prop = String(args.prop || '');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (!KEYFRAME_PROPS.includes(prop) && !prop.startsWith('adjust.')) {
    throw new Error(`prop must be one of ${KEYFRAME_PROPS.join(', ')} or 'adjust.<key>'.`);
  }
  const easeName = String(args.ease || '');
  if (!isEase(easeName)) {
    throw new Error(
      `Unknown ease '${easeName}'. Use one of linear, easeIn, easeOut, easeInOut, smooth, overshoot, anticipate, elastic, bounce, hold, or a cubic(x1,y1,x2,y2) curve.`,
    );
  }
  const local = micros(args.timeSeconds, 'keyframe time') - found.clip.start;
  const tolerance = Math.round(US / Math.max(1, ctx.store.fps) / 2);
  const existing = found.clip.keyframes?.[prop];
  const index = existing ? keyIndexAt(found.clip.keyframes, prop, local, tolerance) : -1;
  if (index < 0) {
    throw new Error(`No keyframe for '${prop}' near that time. Set one first with set_keyframe.`);
  }
  ctx.actions.editClip(clipId, 'MCP: set keyframe ease', (clip) => {
    const i = keyIndexAt(clip.keyframes, prop, local, tolerance);
    if (i >= 0) clip.keyframes[prop][i].ease = easeName;
  });
  return text({ clipId, prop, timeSeconds: seconds(local + found.clip.start), ease: easeName });
}

/* ------------------------------------------------------------ 标记 */

async function runAddMarker(args) {
  const ctx = requireEditor();
  const time = micros(args.seconds, 'marker time');
  const color = /^#[0-9a-f]{6}$/i.test(String(args.color || '')) ? String(args.color) : MARKER_COLORS[0];
  const marker = {
    id: uid('m'),
    time: Math.round(time),
    color,
    label: String(args.label || '').slice(0, 200),
  };
  ctx.store.update('MCP: add marker', (p) => {
    p.markers.push(marker);
    p.markers.sort((a, b) => a.time - b.time);
  }, { structural: false });
  return text({
    marker: { id: marker.id, timeSeconds: seconds(marker.time), color: marker.color, label: marker.label },
  });
}

async function runRemoveMarker(args) {
  const ctx = requireEditor();
  const id = requiredId(args.markerId, 'marker id');
  let removed = 0;
  ctx.store.update('MCP: remove marker', (p) => {
    const before = p.markers.length;
    p.markers = p.markers.filter((m) => m.id !== id);
    removed = before - p.markers.length;
  }, { structural: false });
  return text({ markerId: id, removed });
}

async function runClearMarkers(args) {
  const ctx = requireEditor();
  const count = ctx.store.project.markers.length;
  ctx.store.update('MCP: clear markers', (p) => {
    p.markers = [];
  }, { structural: false });
  return text({ cleared: count });
}

/* ------------------------------------------------------------ 贴纸 / 图形 */

async function runAddSticker(args) {
  const ctx = requireEditor();
  const stickerId = requiredId(args.stickerId, 'sticker id');
  const clip = ctx.actions.addSticker(stickerId, {
    start: optionalMicros(args.startSeconds, 'start'),
    duration: optionalMicros(args.durationSeconds, 'duration'),
    trackId: args.trackId ? String(args.trackId) : undefined,
    color: typeof args.color === 'string' && args.color ? args.color : undefined,
  });
  if (!clip) throw new Error('The sticker could not be added. Is the target track locked?');
  const saved = findClip(ctx.store.project, clip.id)?.clip || clip;
  return text({ clip: clipSummary(saved) });
}

/* ------------------------------------------------------------ 手动字幕 / 标题 */

const CAPTION_Y = { top: -0.82, middle: 0, bottom: 0.85 };

async function runAddCaption(args) {
  const ctx = requireEditor();
  const content = String(args.text == null ? '' : args.text).trim();
  if (!content) throw new Error('Caption text is required.');

  const preset = TEXT_PRESETS.find((p) => p.id === args.preset) || TEXT_PRESETS[0];
  const clip = makeClip('text', {
    start: optionalMicros(args.startSeconds, 'start') ?? ctx.store.time,
    duration: optionalMicros(args.durationSeconds, 'duration') ?? 2 * US,
    text: content,
    style: { ...DEFAULT_TEXT_STYLE, ...(preset?.style || {}) },
    preset: preset?.id,
    caption: true,
  });
  clip.transform.y = CAPTION_Y[args.position] ?? CAPTION_Y.bottom;

  let placed;
  ctx.store.update('MCP: add caption', (p) => {
    placed = addClip(p, clip, { trackId: args.trackId ? String(args.trackId) : undefined });
  }, { structural: false });
  if (!placed) throw new Error('The caption could not be placed on a track.');
  const saved = findClip(ctx.store.project, clip.id)?.clip || clip;
  return text({ clip: clipSummary(saved) });
}

/* ------------------------------------------------------------ 轨道增删与排序 */

async function runAddTrack(args) {
  const ctx = requireEditor();
  const kind = String(args.kind || 'video');
  if (!['video', 'audio', 'text', 'graphic', 'adjust'].includes(kind)) {
    throw new Error('kind must be one of video|audio|text|graphic|adjust.');
  }
  const nearId = args.nearTrackId ? String(args.nearTrackId) : ctx.store.project.tracks[0]?.id;
  const track = ctx.store.update('MCP: add track', (p) => insertTrackNear(p, nearId, kind, Boolean(args.below)), { keepEmptyTracks: true });
  if (!track) throw new Error('The track could not be added.');
  return text({ trackId: track.id, kind });
}

async function runDeleteTrack(args) {
  const ctx = requireEditor();
  const id = requiredId(args.trackId, 'track id');
  const t = findTrack(ctx.store.project, id);
  if (!t) throw new Error(`Unknown track ${id}. Read the ids from get_editor_state.`);
  const clipCount = t.clips.length;
  ctx.store.update(t.main ? 'MCP: clear track' : 'MCP: delete track', (p) => deleteTrack(p, id));
  return text({ trackId: id, clipsRemoved: clipCount, cleared: Boolean(t.main) });
}

async function runMoveTrack(args) {
  const ctx = requireEditor();
  const id = requiredId(args.trackId, 'track id');
  const dir = Number(args.direction) >= 0 ? 1 : -1;
  ctx.store.update('MCP: move track', (p) => moveTrack(p, id, dir), { structural: false });
  return text({ trackId: id, direction: dir });
}

async function runRenameTrack(args) {
  const ctx = requireEditor();
  const id = requiredId(args.trackId, 'track id');
  const name = String(args.name == null ? '' : args.name).trim();
  if (!name) throw new Error('A track name is required.');
  ctx.store.update('MCP: rename track', (p) => renameTrack(p, id, name), { structural: false });
  return text({ trackId: id, name });
}

async function runSetTrackSolo(args) {
  const ctx = requireEditor();
  const id = requiredId(args.trackId, 'track id');
  ctx.store.update('MCP: solo track', (p) => toggleSolo(p, id), { structural: false });
  return text({ trackId: id, solo: Boolean(findTrack(ctx.store.project, id)?.solo) });
}

/* ------------------------------------------------------------ 颜色分级 / LUT */

async function runAddAdjustment(args) {
  const ctx = requireEditor();
  const clip = ctx.actions.addAdjustment({
    name: typeof args.name === 'string' ? args.name : undefined,
    adjust: args.adjust && typeof args.adjust === 'object' ? args.adjust : undefined,
    grade: args.grade && typeof args.grade === 'object' ? args.grade : undefined,
    start: optionalMicros(args.startSeconds, 'start'),
    duration: optionalMicros(args.durationSeconds, 'duration'),
    trackId: args.trackId ? String(args.trackId) : undefined,
  });
  if (!clip) throw new Error('The color layer could not be added.');
  const saved = findClip(ctx.store.project, clip.id)?.clip || clip;
  return text({ clip: clipSummary(saved) });
}

async function runSetColorGrade(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, id);
  if (!found) throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  const grade = normalizeGrade(args.grade && typeof args.grade === 'object' ? args.grade : {});
  ctx.actions.editClip(id, 'MCP: color grade', (c) => {
    if (grade) c.grade = grade;
  });
  const saved = findClip(ctx.store.project, id)?.clip;
  return text({ clipId: id, grade: saved?.grade || null });
}

/* ------------------------------------------------- 模板 / 属性组 / 速度 / 调色 */

async function runInsertTemplate(args) {
  const ctx = requireEditor();
  const tpl = TEMPLATES_BY_ID.get(args.templateId);
  if (!tpl) throw new Error(`Unknown template ${args.templateId}. List them with list_catalog.`);
  const added = await insertTemplate(ctx, tpl, { onProgress: undefined });
  return text({
    templateId: tpl.id,
    template: tpl.name,
    insertedClips: added,
    count: added.length,
  });
}

async function runSetClipAttribute(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, id);
  if (!found) throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  const g = ATTRIBUTE_GROUPS.find((x) => x.id === args.group);
  if (!g) throw new Error(`Unknown attribute group ${args.group}. See list_catalog for groups.`);
  if (!g.types.includes(found.clip.type)) {
    throw new Error(`Group '${g.id}' does not apply to ${found.clip.type} clips (only ${g.types.join(', ')}).`);
  }
  const values = args.attributes && typeof args.attributes === 'object' ? args.attributes : {};
  const set = {};
  for (const [k, v] of Object.entries(values)) {
    if (!g.keys.includes(k)) continue; // 只接受本组声明的键，避免写坏片段
    set[k] = v;
  }
  if (!Object.keys(set).length) {
    throw new Error(`No valid attribute keys for group '${g.id}'. Allowed: ${g.keys.join(', ')}.`);
  }
  ctx.actions.editClip(id, `MCP: ${g.id} attributes`, (c) => {
    for (const [k, v] of Object.entries(set)) c[k] = structuredClone(v);
  });
  return text({ clipId: id, group: g.id, set: Object.keys(set) });
}

async function runSetSpeedRamp(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  if (!findClip(ctx.store.project, id)) {
    throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  }
  const rampId = args.rampId ? String(args.rampId) : null; // 空 => 移除速度斜坡
  if (rampId && !findRamp(rampId)) {
    throw new Error(`Unknown ramp ${rampId}. See list_catalog for speed ramps.`);
  }
  const accent = args.accent !== false;
  const ok = ctx.actions.applySpeedRamp(id, rampId, { accent });
  if (!ok) throw new Error('Speed ramp could not be applied to this clip.');
  return text({ clipId: id, rampId, accent, removed: !rampId });
}

async function runSetSpeedCurve(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  if (!findClip(ctx.store.project, id)) {
    throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  }
  const raw = Array.isArray(args.points) ? args.points : null;
  // 空数组 / 未传 => 移除自定义速度曲线，回到恒定速度。
  if (raw && raw.length < 2) {
    throw new Error('A speed curve needs at least two points (t and v), or omit points to remove it.');
  }
  let points = null;
  if (raw) {
    points = raw.map((p) => {
      const t = Number(p?.t);
      const v = Number(p?.v);
      if (!Number.isFinite(t) || !Number.isFinite(v)) throw new Error('Each point needs numeric t (0..1) and v (speed multiplier).');
      return { t, v };
    });
  }
  const ok = ctx.actions.setSpeedCurve(id, points, { label: 'MCP: speed curve', dropRamp: true });
  if (!ok) throw new Error('Speed curve could not be applied to this clip (only timed video/audio clips).');
  const saved = findClip(ctx.store.project, id)?.clip;
  return text({
    clipId: id,
    removed: !points,
    meanSpeed: saved?.speed ?? 1,
    points: saved?.speedCurve?.map((p) => ({ t: p.t, v: p.v })) || null,
  });
}

async function runListLuts() {
  const library = requireLibrary();
  const luts = await library.listLuts();
  return text({ luts: (luts || []).map((entry) => ({ id: entry.id, name: entry.name })) });
}

async function runApplyLut(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  if (!findClip(ctx.store.project, id)) {
    throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  }
  const library = requireLibrary();
  let entry = null;
  if (args.lutId) {
    const luts = await library.listLuts();
    entry = (luts || []).find((entry) => entry.id === args.lutId);
    if (!entry) throw new Error(`Unknown LUT ${args.lutId}. Use list_luts to see available LUTs.`);
  }
  applyLut(ctx, id, entry); // entry 为 null 时清除 LUT
  return text({ clipId: id, lutId: args.lutId || null, action: args.lutId ? 'applied' : 'cleared' });
}

async function runAutoColor(args) {
  const ctx = requireEditor();
  const id = requiredId(args.clipId, 'clip id');
  if (!findClip(ctx.store.project, id)) {
    throw new Error(`Unknown clip ${id}. Read the ids from get_editor_state.`);
  }
  const patch = autoAdjust(ctx, id);
  if (!patch) {
    throw new Error(
      'Auto adjust could not analyze this clip: the preview is unavailable, or the frame is still loading. Try again in a moment.',
    );
  }
  return text({ clipId: id, applied: patch });
}

async function runRemoveClip(args) {
  const ctx = requireEditor();
  const ids = (Array.isArray(args.clipIds) ? args.clipIds : [args.clipId])
    .map((value) => String(value == null ? '' : value).trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('Pass clipId or clipIds.');

  const missing = ids.filter((id) => !findClip(ctx.store.project, id));
  if (missing.length) throw new Error(`Unknown clip id(s): ${missing.join(', ')}`);

  const removed = ctx.store.update('MCP: remove clips', (project) => deleteClips(project, ids));
  return text({ removed, clipIds: ids });
}

async function runSplitClip(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  if (!findClip(ctx.store.project, clipId)) {
    throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  }

  const at = optionalMicros(args.atSeconds, 'split time') ?? ctx.store.time;
  const ok = ctx.store.update('MCP: split clip', (project) => splitClip(project, clipId, at));
  if (!ok) {
    throw new Error(
      'Cannot split there: the time must be inside the clip and at least one frame away from both edges.',
    );
  }

  return text({ splitClipId: clipId, atSeconds: seconds(at) });
}

/* ------------------------------------------------ 选中型剪辑（选择原语 + 常用编辑） */

/** 校验并归一回传的 clip id 列表。 */
function clipIdsOf(ctx, value) {
  const ids = (Array.isArray(value) ? value : [value])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('Pass one or more clip ids.');
  const missing = ids.filter((id) => !findClip(ctx.store.project, id));
  if (missing.length) throw new Error(`Unknown clip id(s): ${missing.join(', ')}`);
  return ids;
}

async function runSelectClips(args) {
  const ctx = requireEditor();
  const raw = args.clipIds ?? args.clipId;
  // 显式空数组 = 取消选中；未传/空 => 取消选中。
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    ctx.store.select([]);
    return text({ selected: ctx.store.selectedIds });
  }
  const ids = clipIdsOf(ctx, raw);
  ctx.store.select(ids);
  return text({ selected: ctx.store.selectedIds });
}

/**
 * 在给定 id 上临时设成选中，跑一个 selection-based action，再恢复原选中。
 * 这样专用工具不必依赖 UI 选中状态，也不会留下意外选中。
 */
function withSelection(ctx, ids, run) {
  const prev = ctx.store.selectedIds;
  ctx.store.select(ids);
  const result = run();
  const after = ctx.store.selectedIds;
  ctx.store.select(prev);
  return { result, after };
}

async function runDuplicateClips(args) {
  const ctx = requireEditor();
  const ids = clipIdsOf(ctx, args.clipIds ?? args.clipId);
  const { after } = withSelection(ctx, ids, () => ctx.actions.duplicate());
  if (!after.length) throw new Error('Nothing was duplicated (locked track or no room).');
  return text({ duplicated: after });
}

async function runFreezeFrame(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (found.clip.type !== 'video') throw new Error('Freeze frame only works on video clips.');
  const at = optionalMicros(args.atSeconds, 'freeze time') ?? ctx.store.time;
  if (at < found.clip.start || at > found.clip.start + found.clip.duration) {
    throw new Error('The freeze time must fall inside the clip (or set the playhead inside it).');
  }
  const { after } = withSelection(ctx, [clipId], () => {
    ctx.store.seek(at);
    ctx.actions.freeze();
  });
  if (!after.length) throw new Error('Could not freeze a frame there.');
  return text({ clipId, atSeconds: seconds(at), stillClipId: after[0] });
}

async function runDetachAudio(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (found.clip.type !== 'video') throw new Error('Detach audio only works on video clips.');
  let audio = null;
  const ok = ctx.store.update('MCP: detach audio', (p) => {
    audio = detachAudioClip(p, clipId);
    return Boolean(audio);
  }, { structural: false });
  if (!ok || !audio) throw new Error('This clip has no audio to extract.');
  return text({ clipId, audioClipId: audio.id, trackId: audio.trackId || null });
}

async function runToggleClip(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  const want = args.disabled === undefined ? !found.clip.disabled : Boolean(args.disabled);
  ctx.store.update(want ? 'MCP: disable clip' : 'MCP: enable clip', (p) => setDisabled(p, [clipId], want) > 0, { structural: false });
  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clipId, disabled: Boolean(saved?.disabled) });
}

async function runGroupClips(args) {
  const ctx = requireEditor();
  const ids = clipIdsOf(ctx, args.clipIds ?? args.clipId);
  if (ids.length < 2) throw new Error('Group needs two or more clip ids.');
  let groupId = null;
  ctx.store.update('MCP: group clips', (p) => {
    groupId = groupClips(p, ids);
    return Boolean(groupId);
  }, { structural: false });
  if (!groupId) throw new Error('Could not group those clips.');
  return text({ groupId, clipIds: ids });
}

async function runUngroupClips(args) {
  const ctx = requireEditor();
  const ids = clipIdsOf(ctx, args.clipIds ?? args.clipId);
  const ok = ctx.store.update('MCP: ungroup clips', (p) => ungroupClips(p, ids) > 0, { structural: false });
  if (!ok) throw new Error('None of those clips are in a group.');
  return text({ ungrouped: ids });
}

async function runMirrorClip(args) {
  const ctx = requireEditor();
  const clipId = requiredId(args.clipId, 'clip id');
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (!found.clip.transform) throw new Error('Mirror only works on clips with a transform (video, image, text, sticker).');
  ctx.actions.editClip(clipId, 'MCP: mirror', (clip) => {
    if (clip.transform) clip.transform.flipH = !clip.transform.flipH;
  });
  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clipId, flipH: Boolean(saved?.transform?.flipH) });
}

/* ------------------------------------------------ 入/出区间 */

async function runSetRange(args) {
  const ctx = requireEditor();
  if (args.inSeconds == null && args.outSeconds == null) {
    throw new Error('Pass inSeconds and/or outSeconds.');
  }
  const inAt = args.inSeconds != null ? micros(args.inSeconds, 'in point') : null;
  const outAt = args.outSeconds != null ? micros(args.outSeconds, 'out point') : null;
  ctx.store.update('MCP: set range', (p) => {
    if (inAt != null) setRangeIn(p, inAt);
    if (outAt != null) setRangeOut(p, outAt);
  }, { structural: false });
  const r = ctx.store.project.range;
  if (!r) throw new Error('The range could not be set (in must be before out).');
  return text({ inSeconds: seconds(r.in), outSeconds: seconds(r.out) });
}

async function runClearRange() {
  const ctx = requireEditor();
  if (!ctx.store.project.range) return text({ cleared: false });
  ctx.store.update('MCP: clear range', (p) => clearRange(p), { structural: false });
  return text({ cleared: true });
}

async function runCutRange(args) {
  const ctx = requireEditor();
  const r = ctx.store.project.range;
  if (!r) throw new Error('No in/out range is set. Use set_range first.');
  const ripple = args.ripple !== false;
  ctx.store.update(ripple ? 'MCP: cut range' : 'MCP: clear range', (p) => {
    removeRange(p, r.in, r.out, { close: ripple });
    if (ripple) delete p.range;
  });
  ctx.store.seek(r.in);
  return text({ inSeconds: seconds(r.in), outSeconds: seconds(r.out), ripple });
}

/* ------------------------------------------------ 时间线 */

function timelineSummary(t) {
  return { id: t.id, name: t.name, active: t.active };
}

async function runListTimelines() {
  const ctx = requireEditor();
  const project = ctx.store.project;
  const list = ctx.timelines?.list() || [];
  return text({
    timelines: list.map((t) => timelineSummary({ id: t.id, name: t.name, active: t.id === project.timelineId })),
    activeId: project.timelineId || null,
  });
}

async function runSwitchTimeline(args) {
  const ctx = requireEditor();
  const id = requiredId(args.timelineId, 'timeline id');
  const list = ctx.timelines?.list() || [];
  if (!list.some((t) => t.id === id)) throw new Error(`Unknown timeline ${id}. Use list_timelines.`);
  ctx.timelines.open(id);
  return text({ activeId: ctx.store.project.timelineId });
}

async function runAddTimeline(args) {
  const ctx = requireEditor();
  const id = ctx.timelines?.create({ name: args.name ? String(args.name) : undefined });
  if (!id) throw new Error('Could not create a timeline (the project may be at its limit).');
  return text({ timelineId: id, name: ctx.timelines.active()?.name || null });
}

async function runDuplicateTimeline(args) {
  const ctx = requireEditor();
  const src = args.timelineId ? String(args.timelineId) : undefined;
  const id = ctx.timelines?.duplicate(src);
  if (!id) throw new Error('Could not duplicate the timeline (the project may be at its limit).');
  return text({ timelineId: id });
}

async function runRenameTimeline(args) {
  const ctx = requireEditor();
  const id = requiredId(args.timelineId, 'timeline id');
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name is required.');
  const list = ctx.timelines?.list() || [];
  if (!list.some((t) => t.id === id)) throw new Error(`Unknown timeline ${id}. Use list_timelines.`);
  ctx.store.update('MCP: rename timeline', (p) => {
    TL.ensureTimelines(p);
    return TL.renameTimeline(p, id, name);
  }, { structural: false });
  return text({ timelineId: id, name });
}

async function runDeleteTimeline(args) {
  const ctx = requireEditor();
  const id = requiredId(args.timelineId, 'timeline id');
  const list = ctx.timelines?.list() || [];
  if (!list.some((t) => t.id === id)) throw new Error(`Unknown timeline ${id}. Use list_timelines.`);
  if (list.length < 2) throw new Error('A project must keep at least one timeline.');
  const wasActive = id === ctx.store.project.timelineId;
  ctx.store.update('MCP: delete timeline', (p) => TL.deleteTimeline(p, id));
  if (wasActive) {
    ctx.store.clearSelection();
    ctx.store.seek(0);
  }
  return text({ deleted: id, activeId: ctx.store.project.timelineId });
}

async function runApplyTransition(args) {
  const ctx = requireEditor();
  const transitionId = requiredId(args.transitionId, 'transition id');
  if (!TRANSITIONS.some((item) => item.id === transitionId)) {
    throw new Error(`Unknown transition ${transitionId}. See list_catalog.`);
  }

  const ok = ctx.actions.applyTransition(transitionId, {
    clipId: args.clipId ? String(args.clipId) : undefined,
    duration: optionalMicros(args.durationSeconds, 'transition duration'),
  });
  if (!ok) {
    throw new Error(
      'No transition was applied: the two clips must touch on the same track and be long enough.',
    );
  }

  return text({ transitionId, applied: true });
}

async function runApplyEffect(args) {
  const ctx = requireEditor();
  const effectId = requiredId(args.effectId, 'effect id');
  if (!EFFECTS.some((item) => item.id === effectId)) {
    throw new Error(`Unknown effect ${effectId}. See list_catalog.`);
  }

  const clip = ctx.actions.addEffect(effectId, {
    start: optionalMicros(args.startSeconds, 'start'),
    trackId: args.trackId ? String(args.trackId) : undefined,
  });
  if (!clip) throw new Error('The effect could not be added (is the target track locked?).');

  return text({ clip: clipSummary(clip) });
}

async function runApplyFilter(args) {
  const ctx = requireEditor();
  const filterId = requiredId(args.filterId, 'filter id');
  if (!FILTERS.some((item) => item.id === filterId)) {
    throw new Error(`Unknown filter ${filterId}. See list_catalog.`);
  }

  let target = null;
  if (args.clipId) {
    const clipId = String(args.clipId);
    target = findClip(ctx.store.project, clipId)?.clip || null;
    if (!target) throw new Error(`Unknown clip ${clipId}.`);
  }

  const clip = ctx.actions.addFilter(filterId, {
    toClip: target,
    asTrack: Boolean(args.asTrack),
    start: optionalMicros(args.startSeconds, 'start'),
  });

  return text({
    filterId,
    appliedTo: target ? target.id : clip?.id || null,
    asTrackClip: Boolean(clip),
  });
}

async function runUpdateTrack(args) {
  const ctx = requireEditor();
  const trackId = requiredId(args.trackId, 'track id');
  const patch = {};
  if (args.muted !== undefined) patch.muted = Boolean(args.muted);
  if (args.locked !== undefined) patch.locked = Boolean(args.locked);
  if (args.hidden !== undefined) patch.hidden = Boolean(args.hidden);
  if (!Object.keys(patch).length) {
    throw new Error('Pass at least one of muted, locked or hidden.');
  }

  const ok = ctx.store.update(
    'MCP: update track',
    (project) => {
      const track = project.tracks.find((item) => item.id === trackId);
      if (!track) return false;
      Object.assign(track, patch);
      return true;
    },
    { structural: false },
  );
  if (!ok) throw new Error(`Unknown track ${trackId}.`);

  return text({ trackId, ...patch });
}

async function runSetProjectSettings(args) {
  const ctx = requireEditor();
  const patch = {};
  for (const key of ['width', 'height', 'fps']) {
    const value = optionalNumber(args[key], key);
    if (value !== undefined) patch[key] = Math.round(value);
  }
  if (args.ratio !== undefined) patch.ratio = String(args.ratio);
  if (!Object.keys(patch).length) {
    throw new Error('Pass at least one of width, height, fps or ratio.');
  }

  ctx.actions.setProjectSettings(patch);
  return text({ settings: { ...ctx.store.project.settings } });
}

async function runSaveProject() {
  const ctx = requireEditor();
  await ctx.saver.save();
  return text({ saved: true, projectId: ctx.store.project.id, revision: ctx.store.revision });
}

/* ------------------------------------------------------------ 工具表 */

export function editorMcpTools() {
  return [
    {
      name: 'get_editor_state',
      title: 'Read the open timeline',
      description:
        'Snapshot of the project that is open in the editor: canvas size, fps, duration, playhead, selection, undo/redo availability, every track with its clips (start/duration in seconds, trim, speed, volume, text, transition, keyframed properties) and every imported asset id. Call this before editing, and again after a batch of edits to confirm the result.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runGetEditorState,
    },
    {
      name: 'list_catalog',
      title: 'List effects, filters, transitions and text looks',
      description:
        'Every id accepted by apply_effect, apply_filter, apply_transition and add_text (lookId), plus the animation ids and blend modes. Call it once instead of guessing ids.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListCatalog,
    },
    {
      name: 'list_commands',
      title: 'List editor commands',
      description:
        'The editor’s own command registry (playback, editing, timeline, markers, player, file) with ids, labels, groups and whether each is currently enabled. Use run_command to execute one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListCommands,
    },
    {
      name: 'run_command',
      title: 'Run an editor command',
      description:
        'Run one command by id from list_commands — for example play, undo, redo, split, duplicate, delete, selectAll, toEnd. Commands that are disabled for the current state are rejected with an explanation.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Command id from list_commands.' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runCommand,
    },
    {
      name: 'set_playhead',
      title: 'Move the playhead',
      description:
        'Move the playhead to a time in seconds. Several tools default to the playhead (add_clip start, split_clip time), so setting it first is often simpler than passing times everywhere.',
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'number', description: 'Time in seconds from the start.' } },
        required: ['seconds'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetPlayhead,
    },
    {
      name: 'add_clip',
      title: 'Add media to the timeline',
      description:
        'Place an imported asset on the timeline. Without startSeconds it lands at the playhead; visual assets go to the main track unless trackId is given. durationSeconds trims the clip (video and audio keep their source; images default to a few seconds). Returns the new clip id.',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'Asset id from get_editor_state or import_media.' },
          startSeconds: { type: 'number', description: 'Where the clip starts on the timeline.' },
          durationSeconds: { type: 'number', description: 'How long the clip is.' },
          trackId: { type: 'string', description: 'Target track id. Omit for the main track.' },
          main: { type: 'boolean', description: 'Force the main track (default true for visuals).' },
        },
        required: ['assetId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddClip,
    },
    {
      name: 'add_text',
      title: 'Add a text clip',
      description:
        'Add a text clip with an optional look (lookId from list_catalog). Without startSeconds it lands at the playhead. The text can be changed later with update_clip.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The words to show.' },
          lookId: { type: 'string', description: 'Text preset or text effect id. Defaults to plain.' },
          startSeconds: { type: 'number', description: 'Where the text starts.' },
          durationSeconds: { type: 'number', description: 'How long the text stays.' },
          trackId: { type: 'string', description: 'Target text track id.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddText,
    },
    {
      name: 'update_text_style',
      title: 'Change a text clip’s style',
      description:
        'Fine-tune a text clip: font, size, color, bold, italic, underline, align (left/center/right), letterSpacing, lineHeight, strokeColor, strokeWidth, bgColor, bgOpacity, bgRadius, shadowColor, shadowOpacity, shadowBlur, shadowDistance, shadowAngle, and the text-style extras (case, vAlign, fillType, grad1/2/3, glow*, extrude*, glitch*, arc, highlightColor, bubble*). Unknown keys are ignored. Use get_editor_state to read the current style.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Text clip id from get_editor_state.' },
          style: {
            type: 'object',
            description: 'Style patch. Hex colors like "#ff0000".',
            additionalProperties: true,
          },
        },
        required: ['clipId', 'style'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runUpdateTextStyle,
    },
    {
      name: 'find_replace_text',
      title: 'Find and replace text in text clips',
      description:
        'Search every text clip (captions and titles) on the open timeline, including inside compound clips. With no "replace", returns the matches; with "replace", replaces them (all by default, or just the first with all=false) in one undo step. Locked tracks are skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Text to find.' },
          replace: { type: 'string', description: 'Replacement text. Omit to only search.' },
          matchCase: { type: 'boolean', description: 'Match case (default false).' },
          wholeWord: { type: 'boolean', description: 'Match whole words only (default false).' },
          captionsOnly: { type: 'boolean', description: 'Search captions only (default false: captions and titles).' },
          all: { type: 'boolean', description: 'Replace every match (default true); false replaces just the first.' },
        },
        required: ['find'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runFindReplaceText,
    },
    {
      name: 'apply_animation',
      title: 'Apply an in/out/loop animation',
      description:
        'Add (or remove, with animationId null) an entrance/exit/loop animation on a video, image, text or graphic clip. Animation ids come from list_catalog (animations). durationSeconds caps the animation length.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Target clip id.' },
          kind: { type: 'string', enum: ['in', 'out', 'loop'], description: 'Animation role.' },
          animationId: { type: 'string', description: 'Animation id from list_catalog. Omit or null to clear.' },
          durationSeconds: { type: 'number', description: 'Animation length (clamped to clip length).' },
        },
        required: ['clipId', 'kind'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runApplyAnimation,
    },
    {
      name: 'set_keyframe',
      title: 'Set a keyframe on a clip',
      description:
        'Write a keyframe for prop at timeSeconds (clip-local, seconds). prop is one of x, y, scale, rotation, opacity, volume, or adjust.<key> (e.g. adjust.exposure). value is a number; ease is one of linear, easeIn, easeOut, easeInOut, smooth, overshoot, anticipate, elastic, bounce, hold, or a cubic(x1,y1,x2,y2) curve. Overwrites an existing key at the same time.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id.' },
          prop: { type: 'string', description: 'Keyframable property.' },
          timeSeconds: { type: 'number', description: 'Time within the clip, in seconds.' },
          value: { type: 'number', description: 'Value at that key.' },
          ease: { type: 'string', description: 'Easing for the segment leaving this key.' },
        },
        required: ['clipId', 'prop', 'timeSeconds', 'value'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetKeyframe,
    },
    {
      name: 'remove_keyframe',
      title: 'Remove a keyframe from a clip',
      description:
        'Delete the keyframe for prop nearest timeSeconds (within a frame). prop is one of x, y, scale, rotation, opacity, volume, or adjust.<key>.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id.' },
          prop: { type: 'string', description: 'Keyframable property.' },
          timeSeconds: { type: 'number', description: 'Time within the clip, in seconds.' },
        },
        required: ['clipId', 'prop', 'timeSeconds'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRemoveKeyframe,
    },
    {
      name: 'set_keyframe_ease',
      title: 'Change the easing of an existing keyframe',
      description:
        'Change how a keyframe eases into the next one (the key at timeSeconds must already exist — create it with set_keyframe). Accepts a named ease or a cubic(x1,y1,x2,y2) curve. Returns the updated ease.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          prop: {
            type: 'string',
            description: 'Animated property: x, y, scale, rotation, opacity, volume, or adjust.<key>.',
          },
          timeSeconds: { type: 'number', description: 'Timeline position (seconds) of the existing keyframe.' },
          ease: {
            type: 'string',
            description:
              'Ease name: linear, easeIn, easeOut, easeInOut, smooth, overshoot, anticipate, elastic, bounce, hold, or cubic(x1,y1,x2,y2).',
          },
        },
        required: ['clipId', 'prop', 'timeSeconds', 'ease'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetKeyframeEase,
    },
    {
      name: 'update_clip',
      title: 'Change a clip',
      description:
        'Patch one clip. Times are seconds; trim with inSeconds/durationSeconds, retime with speed, mix with volume/muted/fadeInSeconds/fadeOutSeconds, move or scale with transform {x,y,scale,rotation}, and set blend or text. Every change is one undoable step.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          patch: {
            type: 'object',
            properties: {
              startSeconds: { type: 'number' },
              durationSeconds: { type: 'number' },
              inSeconds: { type: 'number', description: 'Source in-point (trim from the start).' },
              speed: { type: 'number', description: '1 = normal, 2 = double speed, 0.5 = slow motion.' },
              volume: { type: 'number', description: '0 to 4.' },
              muted: { type: 'boolean' },
              opacity: { type: 'number', description: '0 to 1.' },
              fadeInSeconds: { type: 'number' },
              fadeOutSeconds: { type: 'number' },
              name: { type: 'string' },
              text: { type: 'string', description: 'Only for text clips.' },
              blend: { type: 'string', description: 'A blend mode id from list_catalog.' },
              transform: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  scale: { type: 'number' },
                  rotation: { type: 'number', description: 'Degrees.' },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        required: ['clipId', 'patch'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runUpdateClip,
    },
    {
      name: 'remove_clip',
      title: 'Remove clips',
      description:
        'Delete one or more clips from the timeline (undoable). Media stays in the library, so it can be added again.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'A single clip id.' },
          clipIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Several clip ids at once.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: runRemoveClip,
    },
    {
      name: 'split_clip',
      title: 'Split a clip',
      description:
        'Cut a clip in two at a time in seconds (default: the playhead). Both halves keep their media; useful before trimming, speed changes or transitions.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id to split.' },
          atSeconds: { type: 'number', description: 'Where to cut. Defaults to the playhead.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSplitClip,
    },
    {
      name: 'select_clips',
      title: 'Set the timeline selection',
      description:
        'Select one or more clips (or deselect with an empty list). Many editing actions and run_command targets act on the current selection, so call this first. Returns the resulting selection.',
      inputSchema: {
        type: 'object',
        properties: {
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip ids to select (from get_editor_state). Empty array deselects.' },
          clipId: { type: 'string', description: 'Single clip id (alternative to clipIds).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSelectClips,
    },
    {
      name: 'duplicate_clips',
      title: 'Duplicate clips',
      description: 'Duplicate one or more clips (copied in place, on the same track). Returns the ids of the new clips.',
      inputSchema: {
        type: 'object',
        properties: {
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip ids to duplicate.' },
          clipId: { type: 'string', description: 'Single clip id (alternative to clipIds).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runDuplicateClips,
    },
    {
      name: 'freeze_frame',
      title: 'Freeze a frame of a video clip',
      description:
        'Insert a still frame at atSeconds (or the current playhead) of a video clip, as its own still clip. Returns the new still clip id.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Video clip id from get_editor_state.' },
          atSeconds: { type: 'number', description: 'Timeline position to freeze (seconds). Defaults to the playhead, which must be inside the clip.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runFreezeFrame,
    },
    {
      name: 'detach_audio',
      title: 'Detach the audio of a video clip',
      description: 'Move the audio of a video clip onto its own audio clip (and track). Returns the new audio clip id.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Video clip id from get_editor_state.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runDetachAudio,
    },
    {
      name: 'toggle_clip',
      title: 'Enable or disable (hide) a clip',
      description: 'Disable (mute and hide) or enable a clip without deleting it. Pass disabled to force a state; omit to toggle.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          disabled: { type: 'boolean', description: 'true to hide, false to show; omit to toggle.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runToggleClip,
    },
    {
      name: 'group_clips',
      title: 'Group clips',
      description: 'Group two or more clips so they move and edit as one. Returns the group id.',
      inputSchema: {
        type: 'object',
        properties: {
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Two or more clip ids to group.' },
        },
        required: ['clipIds'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runGroupClips,
    },
    {
      name: 'ungroup_clips',
      title: 'Ungroup clips',
      description: 'Break one or more grouped clips back into individual clips.',
      inputSchema: {
        type: 'object',
        properties: {
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip ids that belong to a group.' },
          clipId: { type: 'string', description: 'Single clip id (alternative to clipIds).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runUngroupClips,
    },
    {
      name: 'mirror_clip',
      title: 'Mirror (flip) a clip horizontally',
      description: 'Flip a clip left-right. Works on any clip with a transform (video, image, text, sticker). Returns the new flip state.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runMirrorClip,
    },
    {
      name: 'apply_transition',
      title: 'Add a transition between two clips',
      description:
        'Put a transition at the cut after a clip (clipId), or at the cut nearest the playhead when clipId is omitted. The two clips must touch on the same track.',
      inputSchema: {
        type: 'object',
        properties: {
          transitionId: { type: 'string', description: 'Transition id from list_catalog.' },
          clipId: { type: 'string', description: 'The clip before the cut.' },
          durationSeconds: { type: 'number', description: 'Transition length.' },
        },
        required: ['transitionId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runApplyTransition,
    },
    {
      name: 'apply_effect',
      title: 'Add an effect clip',
      description:
        'Add an effect (blur, shake, pulse zoom, …) as its own clip on an effect track at the given time. Effect ids come from list_catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          effectId: { type: 'string', description: 'Effect id from list_catalog.' },
          startSeconds: { type: 'number', description: 'Where the effect starts. Defaults to the playhead.' },
          trackId: { type: 'string', description: 'Target effect track id.' },
        },
        required: ['effectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runApplyEffect,
    },
    {
      name: 'apply_filter',
      title: 'Apply a color filter',
      description:
        'Apply a color filter to a visual clip (clipId), or as a filter clip on its own track when asTrack is true. Filter ids come from list_catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          filterId: { type: 'string', description: 'Filter id from list_catalog.' },
          clipId: { type: 'string', description: 'The visual clip to grade.' },
          asTrack: { type: 'boolean', description: 'Add a filter clip instead of grading a clip.' },
          startSeconds: { type: 'number', description: 'Start of the filter clip.' },
        },
        required: ['filterId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runApplyFilter,
    },
    {
      name: 'update_track',
      title: 'Mute, lock or hide a track',
      description:
        'Set track flags explicitly (not toggles): muted silences audio, hidden hides the track in the picture, locked blocks edits to its clips.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track id from get_editor_state.' },
          muted: { type: 'boolean' },
          locked: { type: 'boolean' },
          hidden: { type: 'boolean' },
        },
        required: ['trackId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runUpdateTrack,
    },
    {
      name: 'set_project_settings',
      title: 'Change canvas size, fps or ratio',
      description:
        'Update the project settings (width, height, fps, ratio). Existing clips are kept; the picture is re-fitted on the next render.',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
          fps: { type: 'number' },
          ratio: { type: 'string', description: 'A ratio id, for example "9:16".' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetProjectSettings,
    },
    {
      name: 'list_timelines',
      title: 'List the project timelines',
      description: 'List every timeline in the project (id, name, whether it is the open one).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListTimelines,
    },
    {
      name: 'switch_timeline',
      title: 'Open a timeline',
      description: 'Switch to another timeline by id (see list_timelines).',
      inputSchema: {
        type: 'object',
        properties: { timelineId: { type: 'string', description: 'Timeline id from list_timelines.' } },
        required: ['timelineId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSwitchTimeline,
    },
    {
      name: 'add_timeline',
      title: 'Add an empty timeline',
      description: 'Create a new, empty timeline that shares the project media, and open it.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Optional name.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddTimeline,
    },
    {
      name: 'duplicate_timeline',
      title: 'Duplicate a timeline',
      description: 'Copy a timeline (the open one unless timelineId is given) and open the copy. Returns its id.',
      inputSchema: {
        type: 'object',
        properties: { timelineId: { type: 'string', description: 'Timeline id to copy (default: the open one).' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runDuplicateTimeline,
    },
    {
      name: 'rename_timeline',
      title: 'Rename a timeline',
      description: 'Rename a timeline.',
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Timeline id from list_timelines.' },
          name: { type: 'string', description: 'New name.' },
        },
        required: ['timelineId', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRenameTimeline,
    },
    {
      name: 'delete_timeline',
      title: 'Delete a timeline',
      description: 'Delete a timeline and its clips (media stays). A project must keep at least one timeline. Undoable.',
      inputSchema: {
        type: 'object',
        properties: { timelineId: { type: 'string', description: 'Timeline id from list_timelines.' } },
        required: ['timelineId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: runDeleteTimeline,
    },
    {
      name: 'save_project',
      title: 'Save the project to disk',
      description:
        'Flush the open project to its file in the project folder. Autosave also runs, but call this before telling the user the work is safe.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSaveProject,
    },
    {
      name: 'add_marker',
      title: 'Add a timeline marker',
      description:
        'Drop a marker at a time in seconds (defaults to the playhead when omitted). Optional color (#rrggbb) and label. Markers are non-destructive bookmarks; read them back from get_editor_state.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Marker time in seconds from the start.' },
          color: { type: 'string', description: 'Marker color as #rrggbb. Defaults to the first marker color.' },
          label: { type: 'string', description: 'Short label shown on the marker.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddMarker,
    },
    {
      name: 'remove_marker',
      title: 'Remove a timeline marker',
      description: 'Delete one marker by its id (from get_editor_state). Returns how many were removed.',
      inputSchema: {
        type: 'object',
        properties: { markerId: { type: 'string', description: 'Marker id from get_editor_state.' } },
        required: ['markerId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRemoveMarker,
    },
    {
      name: 'clear_markers',
      title: 'Remove all timeline markers',
      description: 'Delete every marker on the timeline. Returns the count cleared.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runClearMarkers,
    },
    {
      name: 'set_range',
      title: 'Set the in/out range',
      description: 'Set the in and/or out point (seconds). Used for range cut/clear and for exporting a range.',
      inputSchema: {
        type: 'object',
        properties: {
          inSeconds: { type: 'number', description: 'In point in seconds.' },
          outSeconds: { type: 'number', description: 'Out point in seconds.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetRange,
    },
    {
      name: 'clear_range',
      title: 'Clear the in/out range',
      description: 'Remove the in and out points.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runClearRange,
    },
    {
      name: 'cut_range',
      title: 'Cut or clear the in/out range',
      description:
        'Remove everything between the in and out points on every unlocked track. ripple=true (default) closes the gap; ripple=false leaves it. Requires a range (set_range).',
      inputSchema: {
        type: 'object',
        properties: { ripple: { type: 'boolean', description: 'Close the gap after cutting (default true).' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: runCutRange,
    },
    {
      name: 'add_sticker',
      title: 'Add a sticker or graphic',
      description:
        'Add a sticker/graphic clip by id from list_catalog (stickers). Without startSeconds it lands at the playhead. color overrides the default tint.',
      inputSchema: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: 'Sticker id from list_catalog.stickers.' },
          startSeconds: { type: 'number', description: 'Where the sticker starts.' },
          durationSeconds: { type: 'number', description: 'How long the sticker stays.' },
          trackId: { type: 'string', description: 'Target track id.' },
          color: { type: 'string', description: 'Tint color as #rrggbb.' },
        },
        required: ['stickerId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddSticker,
    },
    {
      name: 'add_caption',
      title: 'Add a manual caption or title',
      description:
        'Add a caption/subtitle text clip (caption:true) at a time, with an optional preset from list_catalog (captionStyles) and a position of top|middle|bottom. This is the locally-feasible alternative to cloud speech-to-text captions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The caption words.' },
          startSeconds: { type: 'number', description: 'Where the caption starts. Defaults to the playhead.' },
          durationSeconds: { type: 'number', description: 'How long the caption stays. Defaults to 2s.' },
          preset: { type: 'string', description: 'Caption style preset id from list_catalog.captionStyles.' },
          position: { type: 'string', description: 'One of top|middle|bottom.' },
          trackId: { type: 'string', description: 'Target text track id.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddCaption,
    },
    {
      name: 'add_track',
      title: 'Add a timeline track',
      description:
        'Add a new track of a given kind (video|audio|text|graphic|adjust) near another track. nearTrackId defaults to the first track; below places it under the reference.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Track kind: video|audio|text|graphic|adjust.' },
          nearTrackId: { type: 'string', description: 'Insert next to this track id.' },
          below: { type: 'boolean', description: 'Insert below the reference track instead of above.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddTrack,
    },
    {
      name: 'delete_track',
      title: 'Delete or clear a timeline track',
      description:
        'Delete a track and its clips. The main (base) track is only emptied, never removed. Returns how many clips were removed.',
      inputSchema: {
        type: 'object',
        properties: { trackId: { type: 'string', description: 'Track id from get_editor_state.' } },
        required: ['trackId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: runDeleteTrack,
    },
    {
      name: 'move_track',
      title: 'Reorder a timeline track',
      description: 'Move a track up (direction >= 0) or down (direction < 0) by one step.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track id from get_editor_state.' },
          direction: { type: 'number', description: '>= 0 moves up, < 0 moves down.' },
        },
        required: ['trackId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runMoveTrack,
    },
    {
      name: 'rename_track',
      title: 'Rename a timeline track',
      description: 'Give a track a name shown in the timeline header.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track id from get_editor_state.' },
          name: { type: 'string', description: 'The new track name.' },
        },
        required: ['trackId', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRenameTrack,
    },
    {
      name: 'set_track_solo',
      title: 'Solo a timeline track',
      description: 'Toggle solo on a track so only it (and other soloed tracks) is audible/visible. Returns the new solo state.',
      inputSchema: {
        type: 'object',
        properties: { trackId: { type: 'string', description: 'Track id from get_editor_state.' } },
        required: ['trackId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetTrackSolo,
    },
    {
      name: 'add_adjustment',
      title: 'Add a color-adjustment layer',
      description:
        'Add an adjustment (color) layer clip. adjust is a map of color keys (-100..100), grade is a color grade object. It applies to every clip beneath it on the timeline.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Layer name.' },
          adjust: { type: 'object', description: 'Map of color-adjustment keys, each -100..100 (e.g. {brightness:10,contrast:-5,saturation:20}).' },
          grade: { type: 'object', description: 'A color grade object (off/hsl/curves/wheels/lut).' },
          startSeconds: { type: 'number', description: 'Where the layer starts.' },
          durationSeconds: { type: 'number', description: 'How long the layer lasts.' },
          trackId: { type: 'string', description: 'Target track id.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddAdjustment,
    },
    {
      name: 'set_color_grade',
      title: 'Apply a color grade to a clip',
      description:
        'Set a color grade (off/hsl/curves/wheels/lut sections) on an existing clip. Invalid or neutral values are ignored. Returns the resulting grade.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          grade: { type: 'object', description: 'Color grade object with any of off/hsl/curves/wheels/lut sections.' },
        },
        required: ['clipId', 'grade'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetColorGrade,
    },
    {
      name: 'insert_template',
      title: 'Insert a project template at the playhead',
      description:
        'Insert a built-in project template (its backdrops, images, sounds and tracks) into the open project at the current playhead. Returns the ids of the new clips. List templates with list_catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'Template id from list_catalog (e.g. "title-intro").' },
        },
        required: ['templateId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runInsertTemplate,
    },
    {
      name: 'set_clip_attribute',
      title: 'Set a clip attribute group (mask, chroma key, cutout, retouch, transform, color, ...)',
      description:
        'Set one attribute group of a clip in place (no keyframes). group is one of the ids from list_catalog.attributeGroups; attributes is an object of that group’s keys. Unknown keys are ignored. Use this for mask/chroma key/background removal/retouch, and any other group.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          group: { type: 'string', description: 'Attribute group id (e.g. "chroma", "cutout", "mask", "retouch", "transform", "color").' },
          attributes: {
            type: 'object',
            description:
              'Object of key:value for the chosen group. Examples: chroma {keyed:true,color:"#00ff00",similarity:30,smoothness:10,spill:5}; cutout {model:"person"}; mask {mode:"ellipse",x:0,y:0,radius:0.6}.',
          },
        },
        required: ['clipId', 'group', 'attributes'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetClipAttribute,
    },
    {
      name: 'set_speed_ramp',
      title: 'Apply or remove a velocity speed ramp on a clip',
      description:
        'Apply a named velocity ramp (dramatic speed curve, optional accent) to a video/audio clip, or remove it by passing an empty rampId. List ramps with list_catalog. Speed ramps only apply to clips that can have speed (video/audio).',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          rampId: {
            type: 'string',
            description: 'Ramp id from list_catalog (e.g. "punch-in"). Omit or empty to remove the ramp (constant speed).',
          },
          accent: { type: 'boolean', description: 'Add the ramp’s accent (flash / zoom punch / motion blur). Default true.', default: true },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetSpeedRamp,
    },
    {
      name: 'set_speed_curve',
      title: 'Set a custom variable speed curve on a clip',
      description:
        'Give a timed video/audio clip a custom speed curve (time remapping). points is a list of {t, v}: t is 0..1 across the clip, v is the speed multiplier (0.1..10). Endpoints are filled automatically. Omit points to remove the curve (constant speed). Built-in shapes are in list_catalog.curvePresets.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          points: {
            type: 'array',
            description:
              'At least two points [{t:0..1, v:multiplier}]. Example: [{t:0,v:1},{t:0.5,v:3},{t:1,v:1}]. Omit or empty to remove the curve.',
            items: {
              type: 'object',
              properties: {
                t: { type: 'number', description: 'Position across the clip, 0..1.' },
                v: { type: 'number', description: 'Speed multiplier, 0.1..10.' },
              },
            },
          },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetSpeedCurve,
    },
    {
      name: 'list_luts',
      title: 'List available LUTs',
      description: 'List the LUTs available in the library (user-imported .cube files). Use apply_lut to attach one to a clip.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListLuts,
    },
    {
      name: 'apply_lut',
      title: 'Apply or clear a LUT on a clip',
      description:
        'Apply a LUT (color lookup table) to a video/image/adjust clip, or clear it by omitting lutId. The LUT must already be in the library (see list_luts).',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
          lutId: { type: 'string', description: 'LUT id from list_luts. Omit or empty to clear the clip’s LUT.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runApplyLut,
    },
    {
      name: 'auto_color',
      title: 'Auto-adjust a clip’s color',
      description:
        'Analyze the clip’s ungraded frame at the playhead and auto-set exposure, contrast, whites, blacks, temperature and tint. Requires the preview to be available. Works on video/image/adjust clips.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Clip id from get_editor_state.' },
        },
        required: ['clipId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAutoColor,
    },
  ];
}

/**
 * 音频级 MCP 工具：本地可合成/可自动化的那一半。
 * ------------------------------------------------------------------
 * 这一层覆盖「不需要联网、不依赖 Puter 云」的音频能力：
 *
 *   - 音效（SFX）：设备本地合成（`media/sfx.js` 的 renderSfx），无版权库、无网络。
 *   - 音乐床（music beds）：同样是设备本地合成（`media/music-render.js` 的 musicBlob）。
 *   - 片段音频特效（audioFx）：降噪 / 增强 / 声道分离 / 声像 / 声道 / 响度归一 /
 *     人声预设，全部是片段上的 `clip.audioFx` 属性，纯本地、可撤销。
 *
 * 明确**不做**（插件里没有 Puter 云，做不到）：
 *   - 自动字幕（语音转文字，generateCaptions 需要 Puter AI）。
 *   - TTS 配音（synthesize 调 puter.ai.txt2speech）。
 * 这俩在 host 桥里若以后接入 Puter 后端，可再加。
 *
 * 时间单位：对外秒，内部微秒（mcp-context 的 micros/seconds）。
 */

import { SFX, SFX_GROUPS, SFX_BY_ID, renderSfx } from '../media/sfx.js';
import { MUSIC, MUSIC_BY_ID } from '../media/music.js';
import { musicBlob } from '../media/music-render.js';
import { encodeWav } from '../media/wav.js';
import { normalizeAudioFx } from '../model/audio.js';
import { findClip } from '../model/timeline.js';
import { requireEditor, text, seconds, micros } from './mcp-context.js';

const SFX_RATE = 44100;

/* ------------------------------------------------------------ 摘要 */

function clipSummary(clip) {
  return {
    id: clip.id,
    type: clip.type,
    name: clip.name || '',
    startSeconds: seconds(clip.start),
    durationSeconds: seconds(clip.duration),
    assetId: clip.assetId || undefined,
    volume: typeof clip.volume === 'number' ? clip.volume : undefined,
  };
}

/**
 * Mirror the app's addGenerated(): render to a WAV blob, import it once per
 * project (matched by name + size), then drop it on the timeline. Returns the
 * new clip, or null if import failed.
 */
async function addRenderedAsset(ctx, name, blob, origin, startMicros, targetTrackId) {
  const { store } = ctx;
  let asset = Object.values(store.project.assets).find(
    (a) => a.kind === 'audio' && a.name === name && a.size === blob.size,
  );
  if (!asset) {
    const made = await ctx.actions.importFiles([new File([blob], name, { type: 'audio/wav' })], { origin });
    if (!made || !made.length) return null;
    asset = made[0];
  }
  return ctx.actions.addAsset(asset, {
    start: startMicros,
    trackId: targetTrackId ? String(targetTrackId) : undefined,
  });
}

/* ------------------------------------------------------------ 工具实现 */

async function runListSfx() {
  const groups = {};
  for (const s of SFX) {
    const group = SFX_GROUPS.find((g) => g.id === s.group)?.id || s.group;
    (groups[group] ||= []).push({
      id: s.id,
      label: s.label,
      durationSeconds: s.duration ? seconds(s.duration) : undefined,
    });
  }
  return text({ groups, count: SFX.length });
}

async function runAddSfx(args) {
  const ctx = requireEditor();
  const sfxId = String(args.sfxId);
  if (!SFX_BY_ID.has(sfxId)) throw new Error(`Unknown sfx ${sfxId}. See list_sfx.`);
  const def = SFX_BY_ID.get(sfxId);
  const samples = renderSfx(sfxId, SFX_RATE);
  const blob = encodeWav([samples], SFX_RATE);
  const clip = await addRenderedAsset(
    ctx,
    `${def.label}.wav`,
    blob,
    'sfx',
    micros(args.startSeconds, 'start'),
    args.targetTrackId,
  );
  if (!clip) throw new Error('The sound effect could not be added to the timeline.');
  return text({ clip: clipSummary(clip) });
}

async function runListMusic() {
  const moods = {};
  for (const m of MUSIC) {
    (moods[m.mood] ||= []).push({
      id: m.id,
      label: m.label,
      durationSeconds: m.duration ? seconds(m.duration) : undefined,
    });
  }
  return text({ moods, count: MUSIC.length });
}

async function runAddMusic(args) {
  const ctx = requireEditor();
  const musicId = String(args.musicId);
  if (!MUSIC_BY_ID.has(musicId)) throw new Error(`Unknown music track ${musicId}. See list_music.`);
  const def = MUSIC_BY_ID.get(musicId);
  const blob = await musicBlob(musicId);
  const clip = await addRenderedAsset(
    ctx,
    `${def.label}.wav`,
    blob,
    'music',
    micros(args.startSeconds, 'start'),
    args.targetTrackId,
  );
  if (!clip) throw new Error('The music track could not be added to the timeline.');
  return text({ clip: clipSummary(clip) });
}

async function runSetAudioFx(args) {
  const ctx = requireEditor();
  const clipId = String(args.clipId);
  const found = findClip(ctx.store.project, clipId);
  if (!found) throw new Error(`Unknown clip ${clipId}. Read the ids from get_editor_state.`);
  if (found.track.locked) throw new Error('That clip is on a locked track; unlock it first.');
  if (!args.fx || typeof args.fx !== 'object') {
    throw new Error(
      'Pass an fx object: { denoise:{on,amount}, enhance:{on,amount}, separate:{on,mode,amount}, pan:{on,value}, channel:{on,mode}, normalize:{on,target}, voice:{id,params} }.',
    );
  }

  // Merge onto the clip's existing audioFx so other effects are not reset.
  const prev = found.clip.audioFx && typeof found.clip.audioFx === 'object' ? found.clip.audioFx : {};
  const merged = normalizeAudioFx(args.fx);
  const next = { ...prev, ...merged };
  ctx.actions.editClip(clipId, 'MCP: audio fx', (clip) => {
    clip.audioFx = next;
  });

  const saved = findClip(ctx.store.project, clipId)?.clip;
  return text({ clipId, audioFx: saved?.audioFx || null });
}

/* ------------------------------------------------------------ 工具表 */

export function audioMcpTools() {
  return [
    {
      name: 'list_sfx',
      title: 'List sound effects',
      description:
        'Every device-synthesized sound effect, grouped by category, with ids and durations. Add one with add_sfx. No network or library needed.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListSfx,
    },
    {
      name: 'add_sfx',
      title: 'Add a sound effect',
      description:
        'Render a sound effect locally and drop it on the timeline as an audio clip. sfxId from list_sfx; without startSeconds it lands at the playhead. targetTrackId picks the audio track.',
      inputSchema: {
        type: 'object',
        properties: {
          sfxId: { type: 'string', description: 'Sound effect id from list_sfx.' },
          startSeconds: { type: 'number', description: 'Where it starts.' },
          targetTrackId: { type: 'string', description: 'Target audio track id.' },
        },
        required: ['sfxId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddSfx,
    },
    {
      name: 'list_music',
      title: 'List music beds',
      description:
        'Every device-synthesized music bed, grouped by mood, with ids and durations. Add one with add_music.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListMusic,
    },
    {
      name: 'add_music',
      title: 'Add a music bed',
      description:
        'Render a music bed locally and drop it on the timeline as an audio clip. musicId from list_music; without startSeconds it lands at the playhead. targetTrackId picks the audio track.',
      inputSchema: {
        type: 'object',
        properties: {
          musicId: { type: 'string', description: 'Music bed id from list_music.' },
          startSeconds: { type: 'number', description: 'Where it starts.' },
          targetTrackId: { type: 'string', description: 'Target audio track id.' },
        },
        required: ['musicId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runAddMusic,
    },
    {
      name: 'set_audio_fx',
      title: 'Apply audio effects to a clip',
      description:
        'Turn on/off and tune a clip’s audio effects: denoise (amount 0..100), enhance (amount 0..100), separate (mode voice|music, amount 0..100), pan (value -100..100), channel (mode stereo|left|right|mono), normalize (target -40..-5 dB), voice (id + params). Merged onto the clip’s existing audioFx. See list_catalog.audioFxKeys.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Audio or video clip id.' },
          fx: { type: 'object', description: 'Audio-fx patch; unknown keys ignored.', additionalProperties: true },
        },
        required: ['clipId', 'fx'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetAudioFx,
    },
  ];
}

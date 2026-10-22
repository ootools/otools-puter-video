// @vitest-environment jsdom
/**
 * 插件侧 MCP 桥的边界（video 版：库目录 = 工程目录）。
 *
 * 只测「契约」——宿主读 `window.__otoolsMcp` 能得到什么形状、异常怎么变成
 * isError、路径守卫挡不挡越界、写工具落点对不对；不测文案翻译（这些描述是
 * 给 AI 读的，本来就不进 i18n 词表）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/Users/local/Videos/Video Studio';

vi.mock('../src/otools/backend.js', () => ({
  MARKER: 'video-studio.json',
  resolveRoot: vi.fn(),
  ensureRoot: vi.fn(),
}));

vi.mock('../src/otools/host.js', () => ({
  joinPath: vi.fn(async (...parts) => parts.filter(Boolean).join('/')),
  dirName: vi.fn((p) => {
    const at = String(p).lastIndexOf('/');
    return at > 0 ? String(p).slice(0, at) : '';
  }),
  listDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDir: vi.fn(),
}));

// 用轻量假数据替换「本地合成」引擎，避免测试里真的渲染音频。
vi.mock('../src/media/sfx.js', () => ({
  SFX: [{ id: 'beep', label: 'Beep', group: 'test', duration: 100_000 }],
  SFX_GROUPS: [{ id: 'test', label: 'Test' }],
  SFX_BY_ID: new Map([['beep', { id: 'beep', label: 'Beep', group: 'test' }]]),
  renderSfx: vi.fn(() => new Float32Array(16)),
}));

vi.mock('../src/media/music.js', () => ({
  MUSIC: [{ id: 'calm', label: 'Calm', mood: 'chill', duration: 200_000 }],
  MUSIC_BY_ID: new Map([['calm', { id: 'calm', label: 'Calm', mood: 'chill' }]]),
  musicDuration: () => 200_000,
}));

vi.mock('../src/media/music-render.js', () => ({
  MUSIC_RATE: 44100,
  musicBlob: vi.fn(async () => new Blob(['wavedata'])),
}));

// 模板插入依赖 canvas 渲染，单测里用轻量替身，只校验参数与返回形状。
vi.mock('../src/ui/template-insert.js', () => ({
  insertTemplate: vi.fn(async () => ['c-tpl-1', 'c-tpl-2']),
}));

// 调色工具依赖播放器取帧，单测里替身，只校验参数。
vi.mock('../src/ui/color-tools.js', () => ({
  applyLut: vi.fn(() => true),
  autoAdjust: vi.fn(() => ({ exposure: 1, temperature: 2 })),
}));

// 时间线模型：rename/delete 走真实 TL 函数会依赖完整 project 结构，测试用轻量假实现。
vi.mock('../src/model/timelines.js', () => ({
  ensureTimelines: vi.fn(),
  listTimelines: (p) => p.timelines || [],
  activeTimeline: (p) => (p.timelines || []).find((t) => t.id === p.timelineId),
  renameTimeline: vi.fn((p, id, name) => {
    const t = (p.timelines || []).find((x) => x.id === id);
    if (t) t.name = name;
    return Boolean(t);
  }),
  deleteTimeline: vi.fn((p, id) => {
    p.timelines = (p.timelines || []).filter((x) => x.id !== id);
    if (p.timelineId === id) p.timelineId = p.timelines[0]?.id;
  }),
}));

import { installMcpBridge, mcpToolDefs, mcpToolNames } from '../src/otools/mcp.js';
import { setVideoMcpContext, videoMcpTools } from '../src/otools/mcp-tools.js';
import { ensureRoot, resolveRoot } from '../src/otools/backend.js';
import * as host from '../src/otools/host.js';

const bridge = () => window.__otoolsMcp;

const project = {
  id: 'p1',
  name: 'Demo',
  created: 1,
  modified: 2,
  settings: { width: 1920, height: 1080, fps: 30, ratio: '16:9' },
  tracks: [
    {
      id: 't1',
      kind: 'video',
      main: true,
      clips: [{ id: 'c1', type: 'video', assetId: 'a1', name: 'clip', start: 0, duration: 5_000_000, in: 0, speed: 1, animIn: null, animOut: null, animLoop: null }],
    },
    {
      id: 't2',
      kind: 'audio',
      clips: [{ id: 'c2', type: 'audio', assetId: 'a2', name: 'music', start: 1_000_000, duration: 3_000_000, in: 0, speed: 1 }],
    },
  ],
  assets: {
    a1: { id: 'a1', name: 'clip.mp4', kind: 'video', duration: 5_000_000, width: 1920, height: 1080, hasAudio: true },
    a2: { id: 'a2', name: 'music.mp3', kind: 'audio', duration: 3_000_000 },
  },
  markers: [{}, {}],
  timelineId: 'tl1',
  timelines: [
    { id: 'tl1', name: 'Main' },
    { id: 'tl2', name: 'Alt' },
  ],
};

/** 假的 Library：只实现 MCP 工具真正用到的那几个方法。 */
function fakeLibrary(overrides = {}) {
  return {
    listProjects: vi.fn(async () => [
      {
        id: 'p1',
        name: 'Demo',
        created: 1,
        modified: 2,
        duration: 5_000_000,
        ratio: '16:9',
        width: 1920,
        height: 1080,
      },
    ]),
    listTrash: vi.fn(async () => [{ id: 'p0' }]),
    openProject: vi.fn(async () => project),
    createProject: vi.fn(async ({ name, ratio }) => ({
      id: 'p9',
      name,
      settings: { ratio: ratio === '9:16' ? '9:16' : '16:9', width: 1920, height: 1080 },
    })),
    renameProject: vi.fn(async (id, name) => ({ id, name })),
    storageUsage: vi.fn(async () => ({
      projects: 1,
      trashed: 1,
      mediaFiles: 3,
      mediaBytes: 2048,
    })),
    listLuts: vi.fn(async () => [
      { id: 'teal', name: 'Teal' },
      { id: 'warm', name: 'Warm' },
    ]),
    ...overrides,
  };
}

/**
 * 假的编辑器 ctx：只实现时间线工具真正用到的那几个方法。
 *
 * `store.update` 会真的执行回调（和上游一样），所以断言能看到改动落在工程上。
 */
function fakeEditor({ empty = false } = {}) {
  const doc = structuredClone(project);
  if (empty) doc.tracks.forEach((track) => (track.clips = []));

  const store = {
    project: doc,
    time: 0,
    fps: 30,
    selection: new Set(),
    dirty: false,
    nest: [],
    history: { canUndo: () => true, canRedo: () => false },
    get selectedIds() {
      return [...store.selection];
    },
    get selected() {
      if (store.selection.size !== 1) return null;
      const [id] = store.selection;
      const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      if (!clip) return null;
      const track = doc.tracks.find((t) => t.clips.includes(clip));
      return { clip, track };
    },
    select(ids, { add = false, toggle = false } = {}) {
      if (!add && !toggle) store.selection.clear();
      for (const id of ids || []) {
        if (toggle && store.selection.has(id)) store.selection.delete(id);
        else store.selection.add(id);
      }
    },
    clearSelection() {
      store.selection.clear();
    },
    get duration() {
      let end = 0;
      for (const track of doc.tracks) for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
      return end;
    },
    update(label, fn) {
      const result = fn(doc);
      return result === undefined ? true : result;
    },
    seek(time) {
      store.time = time;
    },
  };

  const actions = {
    addAsset: vi.fn((asset, opts = {}) => {
      const clip = {
        id: 'c-new',
        type: asset.kind === 'audio' ? 'audio' : 'video',
        assetId: asset.id,
        name: asset.name,
        start: opts.start ?? store.time,
        duration: asset.duration || 5_000_000,
        in: 0,
        speed: 1,
      };
      doc.tracks[0].clips.push(clip);
      return clip;
    }),
    addText: vi.fn((lookId, opts = {}) => {
      const clip = {
        id: 'c-text',
        type: 'text',
        text: opts.text,
        start: opts.start ?? store.time,
        duration: opts.duration ?? 5_000_000,
      };
      doc.tracks[0].clips.push(clip);
      return clip;
    }),
    editClip: vi.fn((id, label, fn) => {
      const clip = doc.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
      if (!clip) return false;
      const result = fn(clip);
      return result === undefined ? true : result;
    }),
    setSpeed: vi.fn(),
    addEffect: vi.fn(() => ({ id: 'c-fx', type: 'effect', start: 0, duration: 1_000_000 })),
    addFilter: vi.fn(() => null),
    applyTransition: vi.fn(() => true),
    addSticker: vi.fn((stickerId, opts = {}) => {
      const clip = {
        id: 'c-sticker',
        type: 'sticker',
        sticker: stickerId,
        start: opts.start ?? store.time,
        duration: opts.duration ?? 5_000_000,
        transform: { scale: 0.6 },
      };
      doc.tracks[0].clips.push(clip);
      return clip;
    }),
    addAdjustment: vi.fn((opts = {}) => {
      const clip = {
        id: 'c-adjust',
        type: 'adjust',
        name: opts.name || 'Color layer',
        start: opts.start ?? store.time,
        duration: opts.duration ?? 5_000_000,
        adjust: {},
        grade: null,
      };
      doc.tracks[0].clips.push(clip);
      return clip;
    }),
    applySpeedRamp: vi.fn((id, rampId) => (rampId === 'bad' ? false : true)),
    setSpeedCurve: vi.fn(() => true),
    duplicate: vi.fn(() => {
      const made = store.selectedIds.map((id, i) => `dup-${id}-${i}`);
      store.select(made);
    }),
    freeze: vi.fn(() => store.select(['still-c1'])),
    setProjectSettings: vi.fn((patch) => Object.assign(doc.settings, patch)),
    importFiles: vi.fn(async () => [
      { id: 'a9', name: 'clip.mp4', kind: 'video', duration: 3_000_000 },
    ]),
  };

  const commands = {
    list: [{ id: 'undo', label: 'Undo', group: 'Editing', enabled: () => true }],
    run: vi.fn((id) => id === 'undo'),
  };

  const library = {
    listLuts: vi.fn(async () => [
      { id: 'teal', name: 'Teal' },
      { id: 'warm', name: 'Warm' },
    ]),
  };

  const timelines = {
    list: () => doc.timelines,
    active: () => doc.timelines.find((t) => t.id === doc.timelineId),
    open: vi.fn((id) => {
      doc.timelineId = id;
    }),
    create: vi.fn((opts = {}) => {
      const t = { id: `tl${doc.timelines.length + 1}`, name: opts.name || 'Timeline' };
      doc.timelines.push(t);
      doc.timelineId = t.id;
      return t.id;
    }),
    duplicate: vi.fn((id) => {
      const src = doc.timelines.find((t) => t.id === (id || doc.timelineId));
      const t = { id: `tl${doc.timelines.length + 1}`, name: `${src ? src.name : 'Timeline'} copy` };
      doc.timelines.push(t);
      doc.timelineId = t.id;
      return t.id;
    }),
  };

  return { store, actions, commands, timelines, saver: { save: vi.fn(async () => {}) }, library };
}

describe('MCP 桥（video）', () => {
  let library;
  let openProject;
  let refreshHome;
  let editor;
  let context;

  beforeEach(() => {
    delete window.__otoolsMcp;
    vi.clearAllMocks();
    resolveRoot.mockResolvedValue(ROOT);
    host.listDir.mockResolvedValue([]);
    host.readFile.mockResolvedValue(null);

    library = fakeLibrary();
    openProject = vi.fn(async () => {});
    refreshHome = vi.fn(async () => {});
    editor = fakeEditor();
    context = {
      library,
      libraryRoot: ROOT,
      openProject,
      refreshHome,
      editorContext: () => editor,
    };
    setVideoMcpContext(context);
    installMcpBridge({ extraTools: videoMcpTools() });
  });

  it('挂载 window.__otoolsMcp 且暴露 listTools/call', () => {
    expect(typeof bridge().listTools).toBe('function');
    expect(typeof bridge().call).toBe('function');
  });

  it('listTools 返回带 name/inputSchema/annotations 的工具表', async () => {
    const tools = await bridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      ...mcpToolNames(),
      ...videoMcpTools().map((tool) => tool.name),
    ]);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.annotations).toBeTypeOf('object');
    }
  });

  it('list_library 落在工程目录并跳过库标记文件', async () => {
    host.listDir.mockResolvedValue([
      { name: 'video-studio.json', isDir: false, size: 1, modified: 1 },
      { name: 'index.json', isDir: false, size: 12, modified: 5 },
      { name: 'projects', isDir: true, size: 0, modified: 6 },
    ]);

    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.entries).toEqual([
      { path: 'index.json', name: 'index.json', kind: 'file', size: 12, modified: 5 },
      { path: 'projects', name: 'projects', kind: 'directory', size: 0, modified: 6 },
    ]);
    expect(host.listDir).toHaveBeenCalledWith(ROOT);
  });

  it('list_library 支持子目录并把相对路径拼进条目', async () => {
    host.listDir.mockResolvedValue([{ name: 'a.json', isDir: false, size: 3, modified: 9 }]);
    const result = await bridge().call('list_library', { path: 'projects' });
    const payload = JSON.parse(result.content[0].text);
    expect(host.listDir).toHaveBeenCalledWith(`${ROOT}/projects`);
    expect(payload.entries[0].path).toBe('projects/a.json');
  });

  it('read_file 返回 base64 内容与元信息', async () => {
    host.readFile.mockResolvedValue({
      name: 'index.json',
      size: 2,
      mime: 'application/json',
      dataBase64: 'e30=',
    });
    const result = await bridge().call('read_file', { path: 'index.json' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      path: 'index.json',
      size: 2,
      mime: 'application/json',
      base64: 'e30=',
    });
  });

  it('read_file 拒绝跳出工程目录的路径', async () => {
    const result = await bridge().call('read_file', { path: '../../secret.txt' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/inside the library folder/);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('read_file 拒绝绝对路径', async () => {
    const result = await bridge().call('read_file', { path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('read_file 对不存在的文件返回 isError', async () => {
    const result = await bridge().call('read_file', { path: 'projects/missing.json' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No such file/);
  });

  it('write_file 先确保工程目录存在，再建父目录并写入 base64', async () => {
    const result = await bridge().call('write_file', {
      path: 'exports/deck.json',
      base64: 'aGk=',
    });
    expect(result.isError).toBe(false);
    expect(ensureRoot).toHaveBeenCalledWith(ROOT);
    expect(host.createDir).toHaveBeenCalledWith(`${ROOT}/exports`);
    expect(host.writeFile).toHaveBeenCalledWith(`${ROOT}/exports/deck.json`, 'aGk=');
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      path: 'exports/deck.json',
      bytes: 2,
    });
  });

  it('write_file 缺 base64 时返回 isError 且不落盘', async () => {
    const result = await bridge().call('write_file', { path: 'a.json' });
    expect(result.isError).toBe(true);
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('业务能力抛错时由桥转成 isError', async () => {
    host.listDir.mockRejectedValue(new Error('disk gone'));
    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk gone');
  });

  it('未知工具返回 isError，而不是抛异常', async () => {
    const result = await bridge().call('nope', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  it('宿主不在时给出可行动的说明', async () => {
    resolveRoot.mockResolvedValue('');
    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/OTools host is not available/);
  });

  it('extraTools 可以追加领域工具，run 不会外泄给宿主', async () => {
    delete window.__otoolsMcp;
    const run = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }));
    installMcpBridge({ extraTools: [{ name: 'domain_tool', description: 'x', run }] });

    const tools = await bridge().listTools();
    const added = tools.find((tool) => tool.name === 'domain_tool');
    expect(added).toBeTruthy();
    expect(added.run).toBeUndefined();

    const result = await bridge().call('domain_tool', { a: 1 });
    expect(run).toHaveBeenCalledWith({ a: 1 });
    expect(result.content[0].text).toBe('ok');
  });

  /* ------------------------------------------------------ 时间线工具 */

  it('get_editor_state 报出轨道、片段、素材与播放头', async () => {
    editor.store.time = 2_000_000;
    const result = await bridge().call('get_editor_state', {});
    expect(result.isError).toBe(false);
    const state = JSON.parse(result.content[0].text);
    expect(state).toMatchObject({
      projectId: 'p1',
      fps: 30,
      durationSeconds: 5,
      playheadSeconds: 2,
      canUndo: true,
      canRedo: false,
    });
    expect(state.tracks).toHaveLength(2);
    expect(state.tracks[0].clips[0]).toMatchObject({
      id: 'c1',
      type: 'video',
      startSeconds: 0,
      durationSeconds: 5,
      speed: 1,
    });
    expect(state.assets.map((asset) => asset.id)).toEqual(['a1', 'a2']);
  });

  it('编辑器没打开时时间线工具给出可行动的说明', async () => {
    setVideoMcpContext({ ...context, editorContext: () => null });
    const result = await bridge().call('get_editor_state', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/open_project/);
  });

  it('list_catalog 给出特效/滤镜/转场/文本 look 的 id', async () => {
    const result = await bridge().call('list_catalog', {});
    const catalog = JSON.parse(result.content[0].text);
    expect(catalog.effects.length).toBeGreaterThan(0);
    expect(catalog.filters.length).toBeGreaterThan(0);
    expect(catalog.transitions.length).toBeGreaterThan(0);
    expect(catalog.textLooks.length).toBeGreaterThan(0);
    expect(catalog.animations.in.length).toBeGreaterThan(0);
    expect(catalog.blendModes).toContain('normal');
  });

  it('add_clip 把秒换成微秒，并按 durationSeconds 修长度', async () => {
    const result = await bridge().call('add_clip', {
      assetId: 'a1',
      startSeconds: 2,
      durationSeconds: 1.5,
    });
    expect(result.isError).toBe(false);
    expect(editor.actions.addAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1' }),
      expect.objectContaining({ start: 2_000_000 }),
    );
    const clip = JSON.parse(result.content[0].text).clip;
    expect(clip).toMatchObject({ id: 'c-new', startSeconds: 2, durationSeconds: 1.5 });
  });

  it('add_clip 对未知素材返回 isError', async () => {
    const result = await bridge().call('add_clip', { assetId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown asset/);
  });

  it('add_text 用给定 look 建文本片段', async () => {
    const result = await bridge().call('add_text', {
      text: 'Hello',
      lookId: 'title-bold',
      startSeconds: 1,
    });
    expect(result.isError).toBe(false);
    expect(editor.actions.addText).toHaveBeenCalledWith(
      'title-bold',
      expect.objectContaining({ text: 'Hello', start: 1_000_000 }),
    );
    expect(JSON.parse(result.content[0].text).clip).toMatchObject({ type: 'text', text: 'Hello' });
  });

  it('update_clip 改起止/速度并回读结果', async () => {
    const result = await bridge().call('update_clip', {
      clipId: 'c1',
      patch: { startSeconds: 0.5, durationSeconds: 2, speed: 2 },
    });
    expect(result.isError).toBe(false);
    const clip = JSON.parse(result.content[0].text).clip;
    expect(clip).toMatchObject({ id: 'c1', startSeconds: 0.5, durationSeconds: 2 });
    expect(editor.actions.setSpeed).toHaveBeenCalledWith('c1', 2);
  });

  it('update_clip 对未知片段返回 isError', async () => {
    const result = await bridge().call('update_clip', { clipId: 'nope', patch: { speed: 2 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  it('remove_clip 真的把片段从轨道上删掉', async () => {
    const result = await bridge().call('remove_clip', { clipIds: ['c1'] });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).removed).toBe(1);
    expect(editor.store.project.tracks[0].clips.find((clip) => clip.id === 'c1')).toBeUndefined();
  });

  it('split_clip 对未知片段返回 isError', async () => {
    const result = await bridge().call('split_clip', { clipId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  it('apply_transition 拒绝未知 id，接受合法 id', async () => {
    const bad = await bridge().call('apply_transition', { transitionId: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/Unknown transition/);

    const ok = await bridge().call('apply_transition', { transitionId: 'mix', clipId: 'c1' });
    expect(ok.isError).toBe(false);
    expect(editor.actions.applyTransition).toHaveBeenCalledWith(
      'mix',
      expect.objectContaining({ clipId: 'c1' }),
    );
  });

  it('apply_effect 拒绝未知 id，接受合法 id', async () => {
    const bad = await bridge().call('apply_effect', { effectId: 'nope' });
    expect(bad.isError).toBe(true);

    const ok = await bridge().call('apply_effect', { effectId: 'blur' });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content[0].text).clip).toMatchObject({ id: 'c-fx' });
  });

  it('update_track 显式设置 muted/locked/hidden', async () => {
    const result = await bridge().call('update_track', { trackId: 't2', muted: true });
    expect(result.isError).toBe(false);
    expect(editor.store.project.tracks[1].muted).toBe(true);

    const bad = await bridge().call('update_track', { trackId: 't2' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/muted, locked or hidden/);
  });

  it('set_project_settings 改画布与帧率', async () => {
    const result = await bridge().call('set_project_settings', { width: 1080, height: 1920, fps: 60 });
    expect(result.isError).toBe(false);
    expect(editor.store.project.settings).toMatchObject({ width: 1080, height: 1920, fps: 60 });
  });

  it('run_command 拒绝未知/禁用的命令，执行合法命令', async () => {
    const bad = await bridge().call('run_command', { id: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/list_commands/);

    const ok = await bridge().call('run_command', { id: 'undo' });
    expect(ok.isError).toBe(false);
    expect(editor.commands.run).toHaveBeenCalledWith('undo');
  });

  it('save_project 走 saver', async () => {
    const result = await bridge().call('save_project', {});
    expect(result.isError).toBe(false);
    expect(editor.saver.save).toHaveBeenCalled();
  });

  /* ------------------------------------------------------ 素材与出片 */

  it('import_media 缺路径时直接报错', async () => {
    const result = await bridge().call('import_media', { paths: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/absolute file path/);
  });

  it('export_video 在空时间线上拒绝导出', async () => {
    setVideoMcpContext({ ...context, editorContext: () => fakeEditor({ empty: true }) });
    const result = await bridge().call('export_video', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timeline is empty/i);
  });

  it('get_job 对未知任务返回 isError', async () => {
    const result = await bridge().call('get_job', { id: 'job-404' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown job/);
  });

  it('工具表与 plugin.json 的 mcp 声明一致', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(here, '..', '..', 'plugin.json'), 'utf8'),
    );
    expect(manifest.mcp.enabled).toBe(true);
    expect(manifest.mcp.backend).toBe('webview');
    expect(manifest.mcp.namespace).toBe('puter-video');

    const domainNames = videoMcpTools().map((tool) => tool.name);
    expect(manifest.mcp.expose).toEqual([...mcpToolNames(), ...domainNames]);
    for (const tool of [...mcpToolDefs(), ...videoMcpTools()]) {
      expect(manifest.mcp.annotations?.[tool.name]).toBeTypeOf('object');
    }
  });

  /* -------------------------------------------------------- 领域工具 */

  it('list_projects 把微秒换成秒，并单独报回收站数量', async () => {
    const result = await bridge().call('list_projects', {});
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.projects).toEqual([
      {
        id: 'p1',
        name: 'Demo',
        modified: 2,
        created: 1,
        durationSeconds: 5,
        ratio: '16:9',
        width: 1920,
        height: 1080,
      },
    ]);
    expect(payload.trashCount).toBe(1);
  });

  it('get_project 汇总画布、轨道与片段数', async () => {
    const result = await bridge().call('get_project', { id: 'p1' });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(library.openProject).toHaveBeenCalledWith('p1');
    expect(payload).toMatchObject({
      id: 'p1',
      name: 'Demo',
      durationSeconds: 5,
      settings: { width: 1920, height: 1080, fps: 30, ratio: '16:9' },
      trackCount: 2,
      clipCount: 2,
      assetCount: 2,
      markerCount: 2,
    });
    expect(payload.tracks[0]).toMatchObject({ id: 't1', kind: 'video', main: true, clipCount: 1 });
  });

  it('get_project 缺 id 时返回可行动的 isError', async () => {
    const result = await bridge().call('get_project', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/project id is required/);
    expect(library.openProject).not.toHaveBeenCalled();
  });

  it('get_storage_usage 透传工程库的统计', async () => {
    const result = await bridge().call('get_storage_usage', {});
    expect(JSON.parse(result.content[0].text)).toEqual({
      projects: 1,
      trashed: 1,
      mediaFiles: 3,
      mediaBytes: 2048,
    });
  });

  it('create_project 建工程并刷新首页列表', async () => {
    const result = await bridge().call('create_project', { name: 'Trailer', ratio: '9:16' });
    expect(result.isError).toBe(false);
    expect(library.createProject).toHaveBeenCalledWith({ name: 'Trailer', ratio: '9:16' });
    expect(refreshHome).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 'p9', ratio: '9:16' });
  });

  it('create_project 不传名字时给默认名', async () => {
    await bridge().call('create_project', {});
    expect(library.createProject).toHaveBeenCalledWith({
      name: 'Untitled project',
      ratio: '16:9',
    });
  });

  it('rename_project 改完刷新首页，空名字直接拒', async () => {
    const ok = await bridge().call('rename_project', { id: 'p1', name: 'Renamed' });
    expect(ok.isError).toBe(false);
    expect(library.renameProject).toHaveBeenCalledWith('p1', 'Renamed');
    expect(refreshHome).toHaveBeenCalled();

    const bad = await bridge().call('rename_project', { id: 'p1', name: '   ' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/new project name is required/);
  });

  it('open_project 先确认工程存在，再交给入口打开', async () => {
    const result = await bridge().call('open_project', { id: 'p1' });
    expect(result.isError).toBe(false);
    expect(library.openProject).toHaveBeenCalledWith('p1');
    expect(openProject).toHaveBeenCalledWith('p1');
  });

  it('工程库还没就绪时，领域工具给出「仍在启动」而不是 undefined 错误', async () => {
    setVideoMcpContext(null);
    const result = await bridge().call('list_projects', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/still starting/);
  });

  /* ------------------------------------------------------ 文本/动画/关键帧 */

  it('add_text 接受 style 覆盖与 y 位置', async () => {
    editor.actions.addText.mockImplementation((lookId, opts = {}) => ({
      id: 'c-text',
      type: 'text',
      text: opts.text,
      start: opts.start ?? 0,
      duration: opts.duration ?? 5_000_000,
      y: opts.y,
      style: { font: 'Inter', size: 64, color: '#ffffff' },
    }));
    const result = await bridge().call('add_text', {
      text: 'Hi',
      lookId: 'subtitle',
      style: { color: '#ff0000', size: 80, bold: true },
    });
    expect(result.isError).toBe(false);
    expect(editor.actions.editClip).toHaveBeenCalled();
    const clip = JSON.parse(result.content[0].text).clip;
    expect(clip).toMatchObject({ type: 'text', text: 'Hi' });
  });

  it('update_text_style 合并字体/字号/颜色并忽略未知键', async () => {
    editor.actions.addText.mockImplementation((lookId, opts = {}) => {
      const clip = {
        id: 'c-text',
        type: 'text',
        text: opts.text,
        start: 0,
        duration: 5_000_000,
        style: { font: 'Inter', size: 64, color: '#ffffff' },
      };
      // 与 fakeEditor 的默认实现一致：把片段落到 store，findClip 才能找到。
      editor.store.project.tracks[0].clips.push(clip);
      return clip;
    });
    await bridge().call('add_text', { text: 'Hi', lookId: 'subtitle' });

    const result = await bridge().call('update_text_style', {
      clipId: 'c-text',
      style: { color: '#ff0000', size: 80, bold: true, bogus: 'x' },
    });
    expect(result.isError).toBe(false);
    const style = JSON.parse(result.content[0].text).style;
    expect(style).toMatchObject({ color: '#ff0000', size: 80, bold: true });
    expect(style.bogus).toBeUndefined();
  });

  it('update_text_style 对非文本片段返回 isError', async () => {
    const result = await bridge().call('update_text_style', { clipId: 'c1', style: { size: 10 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/text clips/);
  });

  it('apply_animation 设置 animIn 并拒绝未知 id', async () => {
    const bad = await bridge().call('apply_animation', { clipId: 'c1', kind: 'in', animationId: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/Unknown animation/);

    const ok = await bridge().call('apply_animation', { clipId: 'c1', kind: 'in', animationId: 'pop-in', durationSeconds: 0.5 });
    expect(ok.isError).toBe(false);
    expect(editor.store.project.tracks[0].clips[0].animIn).toMatchObject({ id: 'pop-in' });
  });

  it('apply_animation 对不支持动画的片段返回 isError', async () => {
    const result = await bridge().call('apply_animation', { clipId: 'c2', kind: 'in' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/video, image, text or graphic/);
  });

  it('set_keyframe 写入微秒级关键帧；非法 prop/越界被拒', async () => {
    const badProp = await bridge().call('set_keyframe', { clipId: 'c1', prop: 'nope', timeSeconds: 1, value: 1 });
    expect(badProp.isError).toBe(true);
    expect(badProp.content[0].text).toMatch(/x, y, scale/);

    const badTime = await bridge().call('set_keyframe', { clipId: 'c1', prop: 'x', timeSeconds: 99, value: 1 });
    expect(badTime.isError).toBe(true);
    expect(badTime.content[0].text).toMatch(/inside the clip/);

    const ok = await bridge().call('set_keyframe', { clipId: 'c1', prop: 'x', timeSeconds: 1, value: 120, ease: 'easeIn' });
    expect(ok.isError).toBe(false);
    const keyframes = editor.store.project.tracks[0].clips[0].keyframes;
    expect(keyframes.x).toHaveLength(1);
    expect(keyframes.x[0]).toMatchObject({ t: 1_000_000, v: 120, ease: 'easeIn' });
  });

  it('remove_keyframe 删掉刚才写入的关键帧', async () => {
    await bridge().call('set_keyframe', { clipId: 'c1', prop: 'x', timeSeconds: 1, value: 120 });
    const result = await bridge().call('remove_keyframe', { clipId: 'c1', prop: 'x', timeSeconds: 1 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).removed).toBe(1);
    expect(editor.store.project.tracks[0].clips[0].keyframes.x).toBeUndefined();
  });

  /* ------------------------------------------------------ 音频（本地合成） */

  it('list_sfx 与 list_music 透传合成的条目', async () => {
    const sfx = JSON.parse((await bridge().call('list_sfx', {})).content[0].text);
    expect(sfx.count).toBe(1);
    expect(sfx.groups.test[0]).toMatchObject({ id: 'beep' });

    const music = JSON.parse((await bridge().call('list_music', {})).content[0].text);
    expect(music.count).toBe(1);
    expect(music.moods.chill[0]).toMatchObject({ id: 'calm' });
  });

  it('add_sfx 渲染并落到时间线，add_music 同理', async () => {
    editor.actions.importFiles.mockResolvedValue([{ id: 'a9', name: 'Beep.wav', kind: 'audio', duration: 100_000 }]);
    const sfx = await bridge().call('add_sfx', { sfxId: 'beep', startSeconds: 1 });
    expect(sfx.isError).toBe(false);
    expect(JSON.parse(sfx.content[0].text).clip).toMatchObject({ type: 'audio', startSeconds: 1 });

    const music = await bridge().call('add_music', { musicId: 'calm', startSeconds: 2 });
    expect(music.isError).toBe(false);
    expect(JSON.parse(music.content[0].text).clip).toMatchObject({ type: 'audio', startSeconds: 2 });
  });

  it('add_sfx 拒绝未知 id', async () => {
    const result = await bridge().call('add_sfx', { sfxId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown sfx/);
  });

  it('set_audio_fx 合并降噪并保留其它特效', async () => {
    const result = await bridge().call('set_audio_fx', {
      clipId: 'c2',
      fx: { denoise: { on: true, amount: 70 }, enhance: { on: true, amount: 40 } },
    });
    expect(result.isError).toBe(false);
    const fx = JSON.parse(result.content[0].text).audioFx;
    expect(fx.denoise).toMatchObject({ on: true, amount: 70 });
    expect(fx.enhance).toMatchObject({ on: true, amount: 40 });
    expect(fx.separate.on).toBe(false);
  });

  it('set_audio_fx 对未知片段返回 isError', async () => {
    const result = await bridge().call('set_audio_fx', { clipId: 'nope', fx: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  /* ------------------------------------------------------ 标记 / 贴纸 / 字幕 / 轨道 / 调色 */

  it('add_marker 落到工程并能被 remove_marker / clear_markers 处理', async () => {
    const add = await bridge().call('add_marker', { seconds: 3, label: 'hook' });
    expect(add.isError).toBe(false);
    const id = JSON.parse(add.content[0].text).marker.id;
    expect(JSON.parse(add.content[0].text).marker).toMatchObject({ timeSeconds: 3, label: 'hook' });

    const state = JSON.parse((await bridge().call('get_editor_state', {})).content[0].text);
    expect(state.markers.find((m) => m.id === id)).toMatchObject({ timeSeconds: 3, label: 'hook' });

    const rm = await bridge().call('remove_marker', { markerId: id });
    expect(rm.isError).toBe(false);
    expect(JSON.parse(rm.content[0].text).removed).toBe(1);

    const clr = await bridge().call('add_marker', { seconds: 1 });
    expect(clr.isError).toBe(false);
    const clrAll = await bridge().call('clear_markers', {});
    expect(clrAll.isError).toBe(false);
    expect(JSON.parse(clrAll.content[0].text).cleared).toBeGreaterThanOrEqual(1);
  });

  it('add_sticker 落到时间线', async () => {
    const result = await bridge().call('add_sticker', { stickerId: 'star', startSeconds: 0.5 });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).clip).toMatchObject({ type: 'sticker', startSeconds: 0.5 });
  });

  it('add_caption 创建 caption 文本片段', async () => {
    const result = await bridge().call('add_caption', { text: 'Hello', startSeconds: 1, preset: 'subtitle' });
    expect(result.isError).toBe(false);
    const clip = JSON.parse(result.content[0].text).clip;
    expect(clip).toMatchObject({ type: 'text', text: 'Hello' });
    const placed = editor.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
    expect(placed.caption).toBe(true);
  });

  it('add_caption 缺文本返回 isError', async () => {
    const result = await bridge().call('add_caption', { text: '  ' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Caption text is required/);
  });

  it('add_track / delete_track / move_track / rename_track / set_track_solo', async () => {
    const before = editor.store.project.tracks.length;
    const added = await bridge().call('add_track', { kind: 'text', below: true });
    expect(added.isError).toBe(false);
    expect(editor.store.project.tracks.length).toBe(before + 1);
    const trackId = JSON.parse(added.content[0].text).trackId;

    const renamed = await bridge().call('rename_track', { trackId, name: 'Subs' });
    expect(renamed.isError).toBe(false);
    expect(editor.store.project.tracks.find((t) => t.id === trackId).name).toBe('Subs');

    const moved = await bridge().call('move_track', { trackId, direction: -1 });
    expect(moved.isError).toBe(false);

    const solo = await bridge().call('set_track_solo', { trackId });
    expect(solo.isError).toBe(false);

    const del = await bridge().call('delete_track', { trackId });
    expect(del.isError).toBe(false);
    expect(editor.store.project.tracks.find((t) => t.id === trackId)).toBeUndefined();
  });

  it('add_track 拒绝非法 kind', async () => {
    const result = await bridge().call('add_track', { kind: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/video\|audio\|text\|graphic\|adjust/);
  });

  it('add_adjustment 创建颜色层；set_color_grade 写入 grade', async () => {
    const adj = await bridge().call('add_adjustment', { name: 'Grade', adjust: { brightness: 10 } });
    expect(adj.isError).toBe(false);
    expect(JSON.parse(adj.content[0].text).clip).toMatchObject({ type: 'adjust' });

    const grade = await bridge().call('set_color_grade', {
      clipId: 'c1',
      grade: { hsl: { blue: { h: 5, s: 10, l: -5 } } },
    });
    expect(grade.isError).toBe(false);
    expect(JSON.parse(grade.content[0].text).grade).toMatchObject({ hsl: { blue: { h: 5, s: 10, l: -5 } } });
  });

  it('set_color_grade 对未知片段返回 isError', async () => {
    const result = await bridge().call('set_color_grade', { clipId: 'nope', grade: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  it('list_catalog 透出 stickers 与 captionStyles', async () => {
    const cat = JSON.parse((await bridge().call('list_catalog', {})).content[0].text);
    expect(Array.isArray(cat.stickers)).toBe(true);
    expect(cat.stickers.length).toBeGreaterThan(0);
    expect(Array.isArray(cat.captionStyles)).toBe(true);
    expect(cat.trackKinds).toEqual(['video', 'audio', 'text', 'graphic', 'adjust']);
  });

  it('list_catalog 透出 templates / attributeGroups / speedRamps', async () => {
    const cat = JSON.parse((await bridge().call('list_catalog', {})).content[0].text);
    expect(Array.isArray(cat.templates)).toBe(true);
    expect(cat.templates.find((t) => t.id === 'title-intro')).toBeTruthy();
    expect(Array.isArray(cat.attributeGroups)).toBe(true);
    const chroma = cat.attributeGroups.find((g) => g.id === 'chroma');
    expect(chroma.keys).toContain('chroma');
    expect(Array.isArray(cat.speedRamps)).toBe(true);
    expect(cat.speedRamps.find((r) => r.id === 'punch-in')).toBeTruthy();
  });

  it('insert_template 插入模板并返回新片段 id', async () => {
    const { insertTemplate } = await import('../src/ui/template-insert.js');
    const result = await bridge().call('insert_template', { templateId: 'title-intro' });
    expect(result.isError).toBe(false);
    expect(insertTemplate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'title-intro' }), expect.anything());
    const payload = JSON.parse(result.content[0].text);
    expect(payload.insertedClips).toEqual(['c-tpl-1', 'c-tpl-2']);
  });

  it('insert_template 对未知模板返回 isError', async () => {
    const result = await bridge().call('insert_template', { templateId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown template/);
  });

  it('set_clip_attribute 写入 chroma 组并忽略未知键', async () => {
    const result = await bridge().call('set_clip_attribute', {
      clipId: 'c1',
      group: 'chroma',
      attributes: { chroma: { keyed: true, color: '#00ff00', similarity: 30, junk: 1 }, bogus: 9 },
    });
    expect(result.isError).toBe(false);
    const clip = JSON.parse(result.content[0].text);
    expect(clip.set).toEqual(['chroma']);
    const c1 = editor.store.project.tracks[0].clips[0];
    expect(c1.chroma).toMatchObject({ keyed: true, color: '#00ff00' });
    expect(c1.bogus).toBeUndefined();
  });

  it('set_clip_attribute 对不适用的片段类型返回 isError', async () => {
    const result = await bridge().call('set_clip_attribute', {
      clipId: 'c2',
      group: 'chroma',
      attributes: { chroma: { keyed: true } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not apply to audio/);
  });

  it('set_clip_attribute 对未知组返回 isError', async () => {
    const result = await bridge().call('set_clip_attribute', { clipId: 'c1', group: 'nope', attributes: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown attribute group/);
  });

  it('set_speed_ramp 应用 ramp 并支持移除', async () => {
    const ok = await bridge().call('set_speed_ramp', { clipId: 'c1', rampId: 'punch-in' });
    expect(ok.isError).toBe(false);
    expect(editor.actions.applySpeedRamp).toHaveBeenCalledWith('c1', 'punch-in', { accent: true });
    const removed = await bridge().call('set_speed_ramp', { clipId: 'c1', rampId: '' });
    expect(removed.isError).toBe(false);
    expect(editor.actions.applySpeedRamp).toHaveBeenCalledWith('c1', null, { accent: true });
  });

  it('set_speed_ramp 对未知 ramp 返回 isError', async () => {
    const result = await bridge().call('set_speed_ramp', { clipId: 'c1', rampId: 'bad-id' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown ramp/);
  });

  it('list_luts 返回库里的 LUT', async () => {
    const result = await bridge().call('list_luts', {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).luts).toEqual([
      { id: 'teal', name: 'Teal' },
      { id: 'warm', name: 'Warm' },
    ]);
  });

  it('apply_lut 应用并支持清除', async () => {
    const { applyLut } = await import('../src/ui/color-tools.js');
    const ok = await bridge().call('apply_lut', { clipId: 'c1', lutId: 'warm' });
    expect(ok.isError).toBe(false);
    expect(applyLut).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({ id: 'warm' }));
    const cleared = await bridge().call('apply_lut', { clipId: 'c1' });
    expect(cleared.isError).toBe(false);
    expect(applyLut).toHaveBeenCalledWith(expect.anything(), 'c1', null);
  });

  it('apply_lut 对未知 LUT 返回 isError', async () => {
    const result = await bridge().call('apply_lut', { clipId: 'c1', lutId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown LUT/);
  });

  it('auto_color 调用自动调色', async () => {
    const { autoAdjust } = await import('../src/ui/color-tools.js');
    const result = await bridge().call('auto_color', { clipId: 'c1' });
    expect(result.isError).toBe(false);
    expect(autoAdjust).toHaveBeenCalledWith(expect.anything(), 'c1');
    expect(JSON.parse(result.content[0].text).applied).toMatchObject({ exposure: 1 });
  });

  it('auto_color 对未知片段返回 isError', async () => {
    const result = await bridge().call('auto_color', { clipId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  it('set_keyframe_ease 修改既有键的缓动', async () => {
    const seed = await bridge().call('set_keyframe', { clipId: 'c1', prop: 'opacity', timeSeconds: 0.5, value: 0.8, ease: 'linear' });
    expect(seed.isError).toBe(false);
    const result = await bridge().call('set_keyframe_ease', { clipId: 'c1', prop: 'opacity', timeSeconds: 0.5, ease: 'easeInOut' });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ease).toBe('easeInOut');
    const keys = editor.store.project.tracks[0].clips[0].keyframes.opacity;
    expect(keys[0].ease).toBe('easeInOut');
  });

  it('set_keyframe_ease 拒绝未知缓动并拒绝不存在的键', async () => {
    const badEase = await bridge().call('set_keyframe_ease', { clipId: 'c1', prop: 'opacity', timeSeconds: 0.5, ease: 'nope' });
    expect(badEase.isError).toBe(true);
    expect(badEase.content[0].text).toMatch(/Unknown ease/);
    const noKey = await bridge().call('set_keyframe_ease', { clipId: 'c1', prop: 'rotation', timeSeconds: 0.5, ease: 'linear' });
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0].text).toMatch(/No keyframe/);
  });

  it('set_speed_curve 应用自定义曲线并支持移除', async () => {
    const ok = await bridge().call('set_speed_curve', {
      clipId: 'c1',
      points: [{ t: 0, v: 1 }, { t: 0.5, v: 3 }, { t: 1, v: 1 }],
    });
    expect(ok.isError).toBe(false);
    expect(editor.actions.setSpeedCurve).toHaveBeenCalledWith(
      'c1',
      [{ t: 0, v: 1 }, { t: 0.5, v: 3 }, { t: 1, v: 1 }],
      expect.objectContaining({ dropRamp: true }),
    );
    const removed = await bridge().call('set_speed_curve', { clipId: 'c1' });
    expect(removed.isError).toBe(false);
    expect(editor.actions.setSpeedCurve).toHaveBeenCalledWith('c1', null, expect.objectContaining({ dropRamp: true }));
  });

  it('set_speed_curve 拒绝少于两个点', async () => {
    const result = await bridge().call('set_speed_curve', { clipId: 'c1', points: [{ t: 0, v: 1 }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least two points/);
  });

  it('list_catalog 透出 curvePresets', async () => {
    const cat = JSON.parse((await bridge().call('list_catalog', {})).content[0].text);
    expect(Array.isArray(cat.curvePresets)).toBe(true);
    expect(cat.curvePresets.find((p) => p.id === 'pulse')).toBeTruthy();
  });

  it('select_clips 设置并返回当前选中', async () => {
    const sel = await bridge().call('select_clips', { clipIds: ['c1'] });
    expect(sel.isError).toBe(false);
    expect(JSON.parse(sel.content[0].text).selected).toEqual(['c1']);
    const none = await bridge().call('select_clips', { clipIds: [] });
    expect(JSON.parse(none.content[0].text).selected).toEqual([]);
  });

  it('select_clips 对未知片段返回 isError', async () => {
    const result = await bridge().call('select_clips', { clipIds: ['nope'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown clip/);
  });

  it('duplicate_clips 复制并返回新片段 id', async () => {
    const result = await bridge().call('duplicate_clips', { clipId: 'c1' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).duplicated).toEqual(['dup-c1-0']);
    expect(editor.actions.duplicate).toHaveBeenCalled();
  });

  it('freeze_frame 冻结并返回静帧 id', async () => {
    const result = await bridge().call('freeze_frame', { clipId: 'c1', atSeconds: 1 });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.stillClipId).toBe('still-c1');
    expect(payload.atSeconds).toBe(1);
  });

  it('freeze_frame 拒绝非视频片段', async () => {
    const result = await bridge().call('freeze_frame', { clipId: 'c2', atSeconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/video clips/);
  });

  it('detach_audio 抽出音频并返回新片段 id', async () => {
    const result = await bridge().call('detach_audio', { clipId: 'c1' });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.audioClipId).toBeTruthy();
    // 原视频片段被静音并标记 audioDetached
    expect(editor.store.project.tracks[0].clips[0].audioDetached).toBe(true);
  });

  it('detach_audio 拒绝非视频片段', async () => {
    const result = await bridge().call('detach_audio', { clipId: 'c2' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/video clips/);
  });

  it('toggle_clip 禁用并重新启用片段', async () => {
    const off = await bridge().call('toggle_clip', { clipId: 'c1', disabled: true });
    expect(off.isError).toBe(false);
    expect(JSON.parse(off.content[0].text).disabled).toBe(true);
    expect(editor.store.project.tracks[0].clips[0].disabled).toBe(true);
    const on = await bridge().call('toggle_clip', { clipId: 'c1', disabled: false });
    expect(JSON.parse(on.content[0].text).disabled).toBe(false);
    expect(editor.store.project.tracks[0].clips[0].disabled).toBeUndefined();
  });

  it('group_clips 编组并返回 group id，ungroup 解散', async () => {
    const g = await bridge().call('group_clips', { clipIds: ['c1', 'c2'] });
    expect(g.isError).toBe(false);
    const groupId = JSON.parse(g.content[0].text).groupId;
    expect(groupId).toBeTruthy();
    expect(editor.store.project.tracks[0].clips[0].group).toBe(groupId);
    const single = await bridge().call('group_clips', { clipIds: ['c1'] });
    expect(single.isError).toBe(true);
    expect(single.content[0].text).toMatch(/two or more/);
    const u = await bridge().call('ungroup_clips', { clipIds: ['c1', 'c2'] });
    expect(u.isError).toBe(false);
    expect(editor.store.project.tracks[0].clips[0].group).toBeUndefined();
  });

  it('mirror_clip 水平翻转', async () => {
    await bridge().call('add_sticker', { stickerId: 'star' });
    const result = await bridge().call('mirror_clip', { clipId: 'c-sticker' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).flipH).toBe(true);
    const sticker = editor.store.project.tracks[0].clips.find((c) => c.id === 'c-sticker');
    expect(sticker.transform.flipH).toBe(true);
  });

  it('mirror_clip 对无 transform 的片段返回 isError', async () => {
    const result = await bridge().call('mirror_clip', { clipId: 'c1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/transform/);
  });

  it('get_editor_state 暴露 range 与 timelines', async () => {
    const state = JSON.parse((await bridge().call('get_editor_state', {})).content[0].text);
    expect(state.range).toBeNull();
    expect(state.timelines).toEqual([
      { id: 'tl1', name: 'Main', active: true },
      { id: 'tl2', name: 'Alt', active: false },
    ]);
  });

  it('set_range 设入出点，clear_range 清掉', async () => {
    const r = await bridge().call('set_range', { inSeconds: 1, outSeconds: 3 });
    expect(r.isError).toBe(false);
    const payload = JSON.parse(r.content[0].text);
    expect(payload).toMatchObject({ inSeconds: 1, outSeconds: 3 });
    const state = JSON.parse((await bridge().call('get_editor_state', {})).content[0].text);
    expect(state.range).toMatchObject({ inSeconds: 1, outSeconds: 3 });
    const c = await bridge().call('clear_range', {});
    expect(JSON.parse(c.content[0].text).cleared).toBe(true);
  });

  it('cut_range 无区间时返回 isError', async () => {
    const result = await bridge().call('cut_range', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No in\/out range/);
  });

  it('list_timelines / switch_timeline / add_timeline / duplicate_timeline', async () => {
    const list = JSON.parse((await bridge().call('list_timelines', {})).content[0].text);
    expect(list.timelines.map((t) => t.id)).toEqual(['tl1', 'tl2']);
    await bridge().call('switch_timeline', { timelineId: 'tl2' });
    expect(editor.store.project.timelineId).toBe('tl2');
    const add = await bridge().call('add_timeline', { name: 'Third' });
    expect(add.isError).toBe(false);
    expect(editor.store.project.timelines.length).toBe(3);
    const dup = await bridge().call('duplicate_timeline', { timelineId: 'tl1' });
    expect(dup.isError).toBe(false);
    expect(editor.store.project.timelines.length).toBe(4);
  });

  it('rename_timeline / delete_timeline', async () => {
    const rn = await bridge().call('rename_timeline', { timelineId: 'tl2', name: 'Second' });
    expect(rn.isError).toBe(false);
    expect(editor.store.project.timelines.find((t) => t.id === 'tl2').name).toBe('Second');
    const del = await bridge().call('delete_timeline', { timelineId: 'tl2' });
    expect(del.isError).toBe(false);
    expect(editor.store.project.timelines.some((t) => t.id === 'tl2')).toBe(false);
  });

  it('delete_timeline 不能删到只剩零个', async () => {
    await bridge().call('delete_timeline', { timelineId: 'tl2' });
    const last = await bridge().call('delete_timeline', { timelineId: 'tl1' });
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toMatch(/at least one timeline/);
  });

  it('switch_timeline 对未知 id 返回 isError', async () => {
    const result = await bridge().call('switch_timeline', { timelineId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown timeline/);
  });

  const addTextClip = (text) => {
    const clip = { id: 't-text', type: 'text', text, start: 0, duration: 5_000_000 };
    editor.store.project.tracks[0].clips.push(clip);
    return clip;
  };

  it('find_replace_text 只查不改', async () => {
    addTextClip('Hello world');
    const r = await bridge().call('find_replace_text', { find: 'world' });
    expect(r.isError).toBe(false);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.matches[0]).toMatchObject({ clipId: 't-text', atSeconds: 0, locked: false });
    expect(editor.store.project.tracks[0].clips.find((c) => c.id === 't-text').text).toBe('Hello world');
  });

  it('find_replace_text 替换全部', async () => {
    addTextClip('cat and cat');
    const r = await bridge().call('find_replace_text', { find: 'cat', replace: 'dog' });
    expect(JSON.parse(r.content[0].text).replaced).toBe(2);
    expect(editor.store.project.tracks[0].clips.find((c) => c.id === 't-text').text).toBe('dog and dog');
  });

  it('find_replace_text 只替换第一处（all=false）', async () => {
    addTextClip('cat and cat');
    const r = await bridge().call('find_replace_text', { find: 'cat', replace: 'dog', all: false });
    expect(JSON.parse(r.content[0].text).replaced).toBe(1);
    expect(editor.store.project.tracks[0].clips.find((c) => c.id === 't-text').text).toBe('dog and cat');
  });

  it('find_replace_text 支持 matchCase', async () => {
    addTextClip('Cat cat');
    const r = await bridge().call('find_replace_text', { find: 'cat', matchCase: true });
    expect(JSON.parse(r.content[0].text).count).toBe(1);
  });

  it('find_replace_text 缺 find 返回 isError', async () => {
    const r = await bridge().call('find_replace_text', { find: '' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/find is required/);
  });
});


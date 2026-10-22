/**
 * 工程级 MCP 工具：列工程、看结构、看占用、建/改名/打开。
 *
 * 这些工具不依赖编辑器是否打开（`get_project` 直接读工程文件），所以在首页
 * 也能用。真正改时间线的工具在 `mcp-editor-tools.js`，出片在 `mcp-media-tools.js`。
 */

import { projectDuration } from '../model/timeline.js';
import {
  getVideoMcpContext,
  requireLibrary,
  text,
  seconds,
  requiredId,
} from './mcp-context.js';

async function refreshHome() {
  try {
    await getVideoMcpContext()?.refreshHome?.();
  } catch {
    /* 首页不在时刷新失败不该让工具调用失败 */
  }
}

/* ------------------------------------------------------------ 工具实现 */

async function runListProjects() {
  const library = requireLibrary();
  const projects = await library.listProjects();
  const trash = await library.listTrash().catch(() => []);

  return text({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      modified: project.modified,
      created: project.created,
      durationSeconds: seconds(project.duration),
      ratio: project.ratio,
      width: project.width,
      height: project.height,
    })),
    trashCount: trash.length,
  });
}

async function runGetProject(args) {
  const project = await requireLibrary().openProject(requiredId(args.id, 'project id'));

  return text({
    id: project.id,
    name: project.name,
    created: project.created,
    modified: project.modified,
    durationSeconds: seconds(projectDuration(project)),
    settings: {
      width: project.settings?.width,
      height: project.settings?.height,
      fps: project.settings?.fps,
      ratio: project.settings?.ratio,
    },
    trackCount: project.tracks.length,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      main: Boolean(track.main),
      locked: Boolean(track.locked),
      hidden: Boolean(track.hidden),
      muted: Boolean(track.muted),
      clipCount: track.clips.length,
    })),
    clipCount: project.tracks.reduce((total, track) => total + track.clips.length, 0),
    assetCount: Object.keys(project.assets || {}).length,
    markerCount: (project.markers || []).length,
  });
}

async function runStorageUsage() {
  return text(await requireLibrary().storageUsage());
}

async function runCreateProject(args) {
  const name = String(args.name == null ? '' : args.name).trim() || 'Untitled project';
  const ratio = String(args.ratio == null ? '' : args.ratio).trim() || '16:9';

  // 比例不合法时上游会静默回落到 16:9，所以这里回报的是**实际生效**的值，
  // 让 AI 一眼看出自己传错了，而不是以为设置成功了。
  const project = await requireLibrary().createProject({ name, ratio });
  await refreshHome();

  return text({
    id: project.id,
    name: project.name,
    ratio: project.settings?.ratio,
    width: project.settings?.width,
    height: project.settings?.height,
  });
}

async function runRenameProject(args) {
  const id = requiredId(args.id, 'project id');
  const name = String(args.name == null ? '' : args.name).trim();
  if (!name) throw new Error('A new project name is required.');

  const project = await requireLibrary().renameProject(id, name);
  await refreshHome();
  return text({ id: project.id, name: project.name });
}

async function runOpenProject(args) {
  const id = requiredId(args.id, 'project id');
  const context = getVideoMcpContext();
  if (typeof context?.openProject !== 'function') {
    throw new Error('Opening a project is not available in this build of the plugin.');
  }

  // 先确认工程真的存在，否则界面会先切走再弹错。
  await requireLibrary().openProject(id);
  await context.openProject(id);
  return text({ id, opened: true });
}

/* ------------------------------------------------------------ 工具表 */

export function projectMcpTools() {
  return [
    {
      name: 'list_projects',
      title: 'List video projects',
      description:
        'List the projects in the Video Studio library, most recently modified first: id, name, duration in seconds, aspect ratio and last modified time. The Trash is not included; only its size is reported.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListProjects,
    },
    {
      name: 'get_project',
      title: 'Inspect a video project',
      description:
        'Return one project’s structure from disk: name, canvas size, fps, duration in seconds, per-track clip counts, total clip/asset/marker counts. Works even when the project is not open. Use list_projects to find the id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Project id from list_projects.' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runGetProject,
    },
    {
      name: 'get_storage_usage',
      title: 'Show library storage usage',
      description:
        'Report how many projects, trashed projects and imported media files the library holds, plus the total media size when the folder reports file sizes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runStorageUsage,
    },
    {
      name: 'create_project',
      title: 'Create a video project',
      description:
        'Create a new empty project in the library and return its id and the canvas size that was actually applied. Ratios are "16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "21:9", "2:1" or "original"; anything else falls back to 16:9, which the result shows.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name. Defaults to "Untitled project".' },
          ratio: { type: 'string', description: 'Aspect ratio id. Defaults to "16:9".' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runCreateProject,
    },
    {
      name: 'rename_project',
      title: 'Rename a video project',
      description: 'Rename an existing project. The project file and its media are not touched.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project id from list_projects.' },
          name: { type: 'string', description: 'The new name.' },
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRenameProject,
    },
    {
      name: 'open_project',
      title: 'Open a project in the editor',
      description:
        'Open an existing project in the Video Studio editor, so the user sees it on screen and the timeline tools (add_clip, add_text, export_video …) can run against it.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Project id from list_projects.' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runOpenProject,
    },
  ];
}

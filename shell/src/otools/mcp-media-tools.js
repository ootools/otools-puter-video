/**
 * 出片与素材导入：把「AI 真能做出一个视频文件」这件事落到磁盘上。
 * ------------------------------------------------------------------
 * ## 为什么这两个工具是「任务」而不是一次调用
 *
 * 宿主的 webview eval 单次只有 **10 秒**（`webview_bridge.rs::EVAL_TIMEOUT`），
 * 而导入一段 4K 素材、渲染一条 1 分钟的片子都远超这个数。所以 `import_media`
 * 和 `export_video` 只**启动**任务并立刻返回 `jobId`，真正的活在自己的异步链里
 * 跑完；AI 用 `get_job` 轮询进度，跑完后结果（文件路径、帧数、字节数）就在任务里。
 *
 * 文件由插件自己写盘（`host.writeBlob`），不经过 MCP 回传——几十 MB 的 base64
 * 塞进 JSON-RPC 既慢又没意义。
 *
 * ## 路径边界
 *
 * 导入允许**绝对路径**（素材通常在下载/桌面等别处，这是唯一可行的读法）；
 * 导出只写**工程目录内的相对路径**，默认 `exports/<片名>.<ext>`，与文件工具的
 * 边界保持一致。
 */

import * as host from './host.js';
import {
  requireEditor,
  requireLibraryRoot,
  requiredId,
  optionalMicros,
  optionalNumber,
  safeRelative,
  seconds,
  text,
} from './mcp-context.js';

/* ------------------------------------------------------------ 任务表 */

const MAX_JOBS = 20;
let sequence = 0;
const jobs = new Map();

function createJob(kind, label) {
  const job = {
    id: `job-${++sequence}`,
    kind,
    label,
    status: 'running',
    phase: 'starting',
    progress: 0,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  // 只留最近 MAX_JOBS 个：任务结果不是审计日志，旧的不值得占内存。
  for (const key of jobs.keys()) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(key);
  }
  return job;
}

function jobSummary(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    phase: job.phase,
    progress: Math.round(job.progress * 1000) / 1000,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedSeconds: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 100) / 10,
    result: job.result,
    error: job.error,
  };
}

/** 起一个后台任务：立刻返回 job，活儿在微任务链里跑。 */
function startJob(kind, label, task) {
  const job = createJob(kind, label);
  Promise.resolve()
    .then(() => task(job))
    .then((result) => {
      job.result = result ?? null;
      job.status = 'done';
      job.phase = 'done';
      job.progress = 1;
    })
    .catch((error) => {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = String((error && error.message) || error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

/* ------------------------------------------------------------ 路径 */

async function targetPath(relative) {
  const root = requireLibraryRoot();
  return host.joinPath(root, ...relative.split('/'));
}

/** 片名转成安全的文件名片段（去掉路径分隔符与控制字符）。 */
function safeBase(name, fallback = 'Video') {
  const value = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (value || fallback).slice(0, 120);
}

/* ------------------------------------------------------------ 导入 */

async function runImportMedia(args) {
  requireEditor();
  const paths = (Array.isArray(args.paths) ? args.paths : [args.path])
    .map((value) => String(value == null ? '' : value).trim())
    .filter(Boolean);
  if (!paths.length) throw new Error('Pass at least one absolute file path in paths.');

  const job = startJob('import', `${paths.length} file(s)`, async (current) => {
    const files = [];
    for (const [index, path] of paths.entries()) {
      current.phase = `reading ${path}`;
      current.progress = (index / paths.length) * 0.8;
      const file = await host.readFile(path);
      if (!file) throw new Error(`No such file on disk: ${path}`);
      const blob = host.base64ToBlob(file.dataBase64, file.mime || host.mimeForPath(path));
      files.push(new File([blob], file.name, { type: blob.type || file.mime || '' }));
    }

    current.phase = 'importing';
    current.progress = 0.85;
    const ctx = requireEditor();
    const assets = await ctx.actions.importFiles(files, {
      addToTimeline: Boolean(args.addToTimeline),
    });

    return {
      assets: assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        durationSeconds: seconds(asset.duration),
        width: asset.width,
        height: asset.height,
      })),
      addedToTimeline: Boolean(args.addToTimeline),
    };
  });

  return text({ jobId: job.id, status: 'running', hint: 'Poll get_job until status is done.' });
}

/* ------------------------------------------------------------ 导出 */

function pickExportSettings(args) {
  const out = {};
  if (args.format) out.format = String(args.format);
  if (args.codec) out.codec = String(args.codec);
  if (args.bitrate) out.bitrate = String(args.bitrate);
  const custom = optionalNumber(args.customMbps, 'customMbps');
  if (custom !== undefined) out.customMbps = custom;
  if (args.includeAudio !== undefined) out.includeAudio = Boolean(args.includeAudio);
  return out;
}

async function runExportVideo(args) {
  const ctx = requireEditor();
  if (ctx.store.duration <= 0) {
    throw new Error('The timeline is empty. Add clips before exporting.');
  }

  const job = startJob('export', String(args.path || 'video'), async (current) => {
    const {
      CONTAINERS,
      DEFAULT_SETTINGS,
      detectCapabilities,
      exportProject,
      outputSize,
      reconcile,
    } = await import('../engine/exporter.js');

    // 复合片段正在编辑时导出的是外层工程：先把它们收回去。
    while (ctx.store.nest?.length) ctx.store.closeCompound();
    const project = ctx.store.projectForSave ? ctx.store.projectForSave() : ctx.store.project;

    const resolution = optionalNumber(args.resolution, 'resolution') ?? 1080;
    const fps = optionalNumber(args.fps, 'fps') ?? project.settings.fps ?? 30;
    const { width, height } = outputSize(project.settings.width, project.settings.height, resolution);

    current.phase = 'checking codecs';
    const caps = await detectCapabilities({ width, height, fps });
    const settings = reconcile(
      {
        ...DEFAULT_SETTINGS,
        name: project.name,
        resolution,
        fps,
        ...pickExportSettings(args),
      },
      caps,
    );

    current.phase = 'rendering';
    const output = await exportProject(project, ctx.library, settings, {
      target: 'memory',
      onProgress: (progress) => {
        if (progress?.phase) current.phase = progress.phase;
        if (Number.isFinite(progress?.fraction)) current.progress = progress.fraction;
      },
    });

    const ext = CONTAINERS[settings.format]?.ext || 'mp4';
    const fallback = output.fileName || `${safeBase(project.name)}.${ext}`;
    const relative = args.path ? safeRelative(args.path) : `exports/${safeBase(fallback)}`;
    const target = await targetPath(relative);

    current.phase = 'writing';
    await host.createDir(host.dirName(target));
    await host.writeBlob(target, output.blob);

    return {
      path: relative,
      absolutePath: target,
      bytes: output.blob.size,
      format: settings.format,
      codec: output.codec || settings.codec,
      audioCodec: output.audioCodec || null,
      width: output.width,
      height: output.height,
      fps: settings.fps,
      frames: output.frames,
      durationSeconds: seconds(output.duration),
      elapsedSeconds: Math.round((output.elapsed || 0) * 10) / 10,
      hardwareAccelerated: Boolean(output.hardware),
    };
  });

  return text({ jobId: job.id, status: 'running', hint: 'Poll get_job until status is done.' });
}

/* ------------------------------------------------------------ 单帧 */

async function runExportFrame(args) {
  const ctx = requireEditor();
  if (ctx.store.duration <= 0) {
    throw new Error('The timeline is empty. Add clips before exporting a frame.');
  }

  const { renderStill } = await import('../engine/exporter.js');
  const at =
    optionalMicros(args.timeSeconds, 'frame time') ?? Math.min(ctx.store.time, ctx.store.duration - 1);

  const bitmap = await renderStill(ctx.store.project, ctx.library, at, {
    maxWidth: ctx.store.project.settings.width,
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not encode the frame as PNG.');

    const relative = args.path
      ? safeRelative(args.path)
      : `exports/${safeBase(`${ctx.store.project.name} ${seconds(at)}s`)}.png`;
    const target = await targetPath(relative);
    await host.createDir(host.dirName(target));
    await host.writeBlob(target, blob);

    return text({
      path: relative,
      absolutePath: target,
      width: bitmap.width,
      height: bitmap.height,
      bytes: blob.size,
      timeSeconds: seconds(at),
    });
  } finally {
    bitmap.close?.();
  }
}

/* ------------------------------------------------------------ 任务查询 */

async function runGetJob(args) {
  const id = requiredId(args.id, 'job id');
  const job = jobs.get(id);
  if (!job) {
    throw new Error(`Unknown job ${id}. Jobs live for this session only — see list_jobs.`);
  }
  return text(jobSummary(job));
}

async function runListJobs() {
  return text({ jobs: [...jobs.values()].reverse().map(jobSummary) });
}

/* ------------------------------------------------------------ 工具表 */

export function mediaMcpTools() {
  return [
    {
      name: 'import_media',
      title: 'Import media files into the project',
      description:
        'Import video, audio or image files from this computer into the open project by absolute path. Runs as a background job because large files take longer than one call: poll get_job for the asset ids, then place them with add_clip. With addToTimeline they are appended at the playhead in order.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths, for example "/Users/me/Movies/clip.mp4".',
          },
          addToTimeline: {
            type: 'boolean',
            description: 'Append the imported media to the timeline from the playhead.',
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runImportMedia,
    },
    {
      name: 'export_video',
      title: 'Render the project to a video file',
      description:
        'Render the open project to MP4/MOV/WebM in the project folder (default "exports/<name>.<ext>") and return a job id. Rendering takes longer than one call, so poll get_job: its result carries the path, byte size, frame count and duration. Formats: mp4, mov, webm. Codecs: avc, hevc, vp9, av1. Resolutions: 480, 720, 1080, 1440, 2160 (short side).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Output path relative to the project folder. Defaults to exports/<name>.<ext>.',
          },
          format: { type: 'string', description: 'mp4, mov or webm.' },
          codec: { type: 'string', description: 'avc, hevc, vp9 or av1.' },
          resolution: { type: 'number', description: 'Short side in pixels: 480, 720, 1080, 1440 or 2160.' },
          fps: { type: 'number', description: 'Frame rate. Defaults to the project fps.' },
          bitrate: { type: 'string', description: 'small, balanced, high or custom.' },
          customMbps: { type: 'number', description: 'Megabits per second when bitrate is custom.' },
          includeAudio: { type: 'boolean', description: 'Include the mix. Defaults to true.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runExportVideo,
    },
    {
      name: 'export_frame',
      title: 'Save one frame as a PNG',
      description:
        'Render the frame at a given time (default: the playhead) at full project resolution and save it as a PNG in the project folder. Faster than a full render and useful as a poster or a quick check.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Output path relative to the project folder. Defaults to exports/<name> <time>s.png.',
          },
          timeSeconds: { type: 'number', description: 'Which frame to render. Defaults to the playhead.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runExportFrame,
    },
    {
      name: 'get_job',
      title: 'Check a background job',
      description:
        'Status of an import or export job: phase, progress from 0 to 1, result when done (asset ids or the written file), or the error when it failed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job id returned by import_media or export_video.' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runGetJob,
    },
    {
      name: 'list_jobs',
      title: 'List background jobs',
      description: 'Recent import and export jobs, newest first, with status and results.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListJobs,
    },
  ];
}

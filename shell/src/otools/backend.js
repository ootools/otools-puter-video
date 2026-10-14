/**
 * 工程库的本地磁盘后端：实现上游 `src/storage/backends.js` 里那套
 * 「readJSON / writeJSON / readBlob / writeBlob / remove / list」接口，
 * 但落到宿主磁盘上的一个**普通目录**，而不是 Puter 云盘或浏览器 OPFS。
 *
 * 目录布局沿用上游 `Library` 的约定（见 `src/storage/library.js` 顶部注释），
 * 所以磁盘上看到的就是一套能直接备份、拷走、进版本库的普通文件：
 *
 *   <工程目录>/
 *     index.json               工程列表
 *     projects/<id>.json       工程文档
 *     covers/<id>.jpg          首页缩略图
 *     media/<hash>.<ext>       导入的素材（所有工程共享）
 *     luts/index.json          LUT 列表
 *     luts/<hash>.cube         LUT 文件
 *
 * 工程目录默认是「视频/Video Studio」（没有视频目录时退到「文档」再退到「主目录」），
 * 用户可以在首页左下角的存储卡片里改（见 `shell/src/otools/ui.js`）。
 */

import * as host from './host.js';

/** 工程目录记在 localStorage：跨插件重启仍然记得。 */
const ROOT_KEY = 'otools-video.root';
/** 目录里放一个标记文件，用户改到别的目录时能看出这是本插件的工程目录。 */
const MARKER = 'video-studio.json';
/** 默认目录名（宿主路径 + 这一层）。 */
const FOLDER_NAME = 'Video Studio';

/** 后端类型标识：上游用它决定要不要挂 OPFS 素材缓存（这里不需要）。 */
export const KIND = 'otools';

/** 超过这个大小就在控制台留个痕迹（宿主的写接口只收 base64，必然过内存）。 */
const LARGE_FILE_BYTES = 256 * 1024 * 1024;

function readStoredRoot() {
  try {
    return String(window.localStorage.getItem(ROOT_KEY) || '').trim();
  } catch {
    return '';
  }
}

function storeRoot(path) {
  try {
    window.localStorage.setItem(ROOT_KEY, String(path || '').trim());
  } catch {
    /* 忽略 */
  }
}

/** 默认工程目录：优先「视频」，其次「文档」，最后「主目录」。 */
async function defaultRoot() {
  const base = host.knownPath('videos') || host.knownPath('documents') || host.knownPath('home');
  if (!base) return '';
  return host.joinPath(base, FOLDER_NAME);
}

/**
 * 当前工程目录。第一次调用时解析默认值并落盘，之后直接读缓存。
 * 宿主不可用时返回空串（调用方应退回上游的浏览器行为）。
 */
export async function resolveRoot() {
  if (!host.available()) return '';
  const stored = readStoredRoot();
  if (stored) return stored;
  const fallback = await defaultRoot();
  if (!fallback) return '';
  storeRoot(fallback);
  return fallback;
}

/** 换一个工程目录（用户在首页点了「更改目录」）。 */
export async function setRoot(path) {
  const next = String(path || '').trim();
  if (!next) return '';
  storeRoot(next);
  await host.createDir(next);
  return next;
}

/** 目录里的标记文件内容：给人看，也给将来做版本迁移留个位。 */
function markerPayload(root) {
  return {
    app: 'otools-video',
    name: 'Video Studio',
    root,
    note: 'This folder is the Video Studio plugin project library. Projects, covers and imported media live here as plain files.',
    layout: ['index.json', 'projects/<id>.json', 'covers/<id>.jpg', 'media/<hash>.<ext>', 'luts/index.json', 'luts/<hash>.cube'],
  };
}

/** 建好工程目录并写下标记文件（已存在时只补标记文件，不动其它内容）。 */
export async function ensureRoot(root) {
  if (!root) return;
  await host.createDir(root);
  const marker = await host.joinPath(root, MARKER);
  const existing = await host.readFile(marker);
  if (!existing) {
    await host.writeFile(marker, host.bytesToBase64(new TextEncoder().encode(`${JSON.stringify(markerPayload(root), null, 2)}\n`)));
  }
}

/**
 * 上游 `Library` 要的那个后端。路径一律是相对工程目录的 POSIX 风格
 * （`projects/xxx.json`、`media/<hash>.mp4`），这里拼成宿主绝对路径。
 */
export function otoolsBackend(root) {
  const abs = (path) => (path ? `${root}/${String(path).replace(/^\/+/, '')}` : root);

  const backend = {
    kind: KIND,
    /** 工程目录的绝对路径（首页显示、以及「在文件管理器里打开」用）。 */
    get root() {
      return root;
    },

    async readJSON(path) {
      const file = await host.readFile(abs(path));
      if (!file || !file.dataBase64) return null;
      const text = new TextDecoder().decode(host.base64ToBytes(file.dataBase64));
      return text ? JSON.parse(text) : null;
    },

    async writeJSON(path, value) {
      const target = abs(path);
      await host.createDir(host.dirName(target));
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      await host.writeFile(target, host.bytesToBase64(bytes));
    },

    async readBlob(path) {
      const file = await host.readFile(abs(path));
      if (!file || !file.dataBase64) return null;
      // 上游靠 blob.type 判断媒体类型，宿主给的 mime 比扩展名猜更准，优先用它。
      return host.base64ToBlob(file.dataBase64, file.mime || host.mimeForPath(path));
    },

    async writeBlob(path, blob) {
      const target = abs(path);
      await host.createDir(host.dirName(target));
      // 宿主的写文件接口只收 base64，所以素材进库时必然要在内存里过一次
      // base64（约 1.33 倍大小）。几百 MB 还能忍，上 GB 会很慢甚至把 webview
      // 撑爆——这里留个明确的痕迹，免得事后只看到「导入卡住」。
      if (blob.size > LARGE_FILE_BYTES) {
        console.warn(`[otools-video] 写入 ${(blob.size / 1048576).toFixed(0)} MB 的素材，需要过一次 base64 IPC，会比较慢：${path}`);
        host.diag({ lastLargeWrite: path, bytes: blob.size });
      }
      await host.writeBlob(target, blob);
    },

    async remove(path) {
      await host.removeEntry(abs(path), { recursive: true });
    },

    async list(dir) {
      const entries = await host.listDir(abs(dir));
      return entries.map((e) => ({ name: e.name, isDir: e.isDir, modified: e.modified, size: e.size }));
    },
  };

  return backend;
}

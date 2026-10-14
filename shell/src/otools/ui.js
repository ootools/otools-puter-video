/**
 * 移植层用到的一点点界面胶水。
 *
 * 上游界面本身一行不用重画——这里只补三件宿主相关的小事：
 *   1. 首页左下角存储卡片里的「工程目录」按钮（看路径 / 换目录 / 在文件管理器里打开）
 *   2. 「另存到…」：宿主另存对话框 + 写盘，替换掉浏览器下载
 *   3. 「存到视频目录」：不弹对话框，直接落到宿主的 Videos 目录（导出对话框的默认目的地）
 *
 * 全部在宿主不可用时返回 null / false，让调用方退回上游原有的浏览器行为。
 */

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openDialog, toast } from '../ui/dialog.js';
import * as host from './host.js';
import { resolveRoot, setRoot } from './backend.js';

/** 宿主可用才接管。 */
export function hostReady() {
  return host.available();
}

/** 把宿主/系统抛出的错误转成一句话（上游各处 toast 都用它）。 */
export function hostMessage(err) {
  return host.errorMessage(err);
}

/* ------------------------------------------------------------ 导入 / 导出 */

/**
 * 弹宿主另存对话框并写盘。
 * @returns {Promise<string|null>} 落盘路径；用户在对话框里取消时 null。
 */
export async function saveBlobAs(blob, fileName, { title = 'Save as', filters } = {}) {
  if (!hostReady()) return null;
  const path = await host.pickSavePath({ title, defaultPath: fileName, filters });
  if (!path) return null;
  await host.writeBlob(path, blob);
  return path;
}

/** 同名文件自动加序号：`clip.mp4` → `clip (2).mp4`。 */
function dedupeName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * 不弹对话框，直接把导出结果落到宿主的 Videos 目录（导出对话框的默认目的地）。
 * 目标目录不存在时退回「另存为」。
 */
export async function saveBlobToVideos(blob, fileName) {
  if (!hostReady()) return null;
  const videos = host.knownPath('videos') || host.knownPath('documents') || host.knownPath('home');
  if (!videos) return saveBlobAs(blob, fileName);
  await host.createDir(videos);
  const taken = new Set((await host.listDir(videos)).map((e) => e.name));
  const target = await host.joinPath(videos, dedupeName(fileName, taken));
  await host.writeBlob(target, blob);
  return target;
}

/* --------------------------------------------------------- 工程目录卡片 */

/** 工程目录的显示名（太长时只留尾部两段，避免把侧栏撑开）。 */
function shortPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/**
 * 首页存储卡片里的「工程目录」按钮。
 *
 * 上游的存储卡片只说明「存在 Puter 云 / 存在这个浏览器里」，对本地插件来说
 * 真正需要说的是「存在哪个目录、怎么换」。这个按钮把三件事收在一处：
 * 看完整路径、换目录（宿主目录对话框）、在系统文件管理器里打开。
 */
export function storageFolderButton(library) {
  const backend = library?.backend;
  if (!backend || backend.kind !== 'otools') return null;

  const btn = h('button.btn.small.block', { type: 'button', 'aria-label': 'Project folder' },
    icon('folderOpen', 14), h('span.folder-label', shortPath(backend.root)));

  const sync = () => {
    const label = btn.querySelector('.folder-label');
    if (label) label.textContent = shortPath(backend.root);
    btn.dataset.tip = backend.root || '';
  };
  sync();

  btn.addEventListener('click', () => {
    const pathEl = h('p.dialog-text.folder-path', backend.root || '');
    const change = h('button.btn.primary', { type: 'button' }, icon('folderInput', 16), 'Change folder');
    const reveal = h('button.btn', { type: 'button' }, icon('folderOpen', 16), 'Show in file manager');
    const copy = h('button.btn', { type: 'button' }, icon('copy', 16), 'Copy path');
    const close = h('button.btn', { type: 'button' }, 'Close');
    const dlg = openDialog({
      title: 'Project folder',
      body: h('div', h('p.dialog-text', 'Projects, covers and imported media are plain files in this folder. Point it at a synced folder (OneDrive, Dropbox, a git repo…) to back projects up.'),
        pathEl),
      actions: [close, copy, reveal, change],
      className: 'small',
    });
    close.addEventListener('click', () => dlg.close());
    copy.addEventListener('click', () => {
      try { navigator.clipboard.writeText(backend.root); } catch { /* 忽略 */ }
      toast('Folder path copied.', { kind: 'success' });
    });
    reveal.addEventListener('click', () => host.revealPath(backend.root));
    change.addEventListener('click', async () => {
      change.disabled = true;
      try {
        const picked = await host.pickFolder({ title: 'Choose the project folder', directory: backend.root });
        if (!picked) return;
        if (picked === backend.root) return;
        await setRoot(picked);
        dlg.close();
        // 工程库换了根目录，最省事也最不容易出错的做法是重新加载整个应用。
        toast('Project folder changed. Reloading…', { kind: 'success' });
        setTimeout(() => window.location.reload(), 400);
      } catch (err) {
        toast(`Could not change the folder: ${host.errorMessage(err)}`, { kind: 'error' });
        change.disabled = false;
      }
    });
  });

  // 首次运行时把默认目录真正建出来，卡片上显示的路径才是真的。
  resolveRoot().then((root) => {
    if (root) sync();
  }).catch(() => {});

  return btn;
}

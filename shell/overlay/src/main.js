/**
 * 应用入口（覆盖上游同名文件）。
 *
 * 与上游 `src/main.js` 的差别只有一件事：**启动时选哪个「世界」**。
 *
 *   上游                                  插件版
 *   ------------------------------------  --------------------------------------------
 *   等 5 秒 `window.puter` 到岗            不等——插件页里永远不会出现 puter
 *   登录了 → puterBackend（Puter 云盘）     宿主可用 → otoolsBackend（本机目录）
 *   没登录 → opfsBackend（浏览器 OPFS）     宿主不可用 → 上游原样的 opfsBackend 兜底
 *   #review=... 打开评审页                  没有评审（上游的分享/评论是 Puter worker）
 *   puter.ui.onLaunchedWithItems 接文件     没有（宿主没有这个概念）
 *
 * 除这一段以外，上游的路由、加载态、错误页、开发钩子都原样保留；
 * 工程文档、时间线、渲染、导出这些真正的功能一行没动。
 */

import './styles/fonts.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/editor.css';
import './styles/timeline.css';
import './styles/home.css';
import './styles/responsive.css';
import { h } from './lib/dom.js';
import { icon, appIcon } from './lib/icons.js';
import { applyTheme } from './ui/prefs.js';
import { Library } from './storage/library.js';
import { opfsBackend, opfsAvailable, memoryBackend } from './storage/backends.js';
import { Home } from './ui/home.js';
import { importProjectBundle } from './storage/bundle.js';
import { toast } from './ui/dialog.js';
import { loadDsp } from './media/dsp.js';
// 移植层：宿主桥 + 本地磁盘工程库。
import * as host from './otools/host.js';
import { otoolsBackend, resolveRoot, ensureRoot } from './otools/backend.js';
// 移植层：多语言（跟随宿主，可在界面里覆盖）+ 主题跟随。
import { installI18n, t } from './otools/i18n.js';
import { installDomTranslation } from './otools/dom-i18n.js';
import { installThemeFollow, primeThemeFromHost } from './otools/theme-sync.js';

// 语言与主题都要在第一次渲染之前装好：
//   - installI18n 解析出当前语言（宿主 → 用户覆盖 → 浏览器），并开始监听宿主切换；
//   - installDomTranslation 挂上 DOM 翻译层，之后上游渲染出来的界面文案会被自动替换；
//   - primeThemeFromHost + installThemeFollow 让主题跟随宿主（用户自己选过就不跟随）。
installI18n();
installDomTranslation();
primeThemeFromHost();
installThemeFollow();

const root = document.getElementById('app');
applyTheme();
loadDsp();

let library = null;
let account = null;
let view = null;

function loading(text) {
  root.setAttribute('aria-busy', 'true');
  root.replaceChildren(h('div.splash', { role: 'status' }, appIcon(56), h('div.spinner'), h('p', text)));
}

function errorScreen(title, message, retry) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main#main.splash', icon('cloudOff', 32), h('h1.splash-title', title), h('p.splash-sub', message), retry ? h('button.btn.primary', { type: 'button', onclick: retry }, 'Try again') : null));
}

function showHome() {
  view?.dispose?.();
  if (/#project=/.test(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}`);
  view = new Home(root, {
    library,
    account,
    onOpen: (id) => openProject(id),
    onCreate: (opts) => createProject(opts),
    onImportFiles: (files) => createProject({ ratio: 'original' }, files),
  });
}

async function openProject(id, files) {
  view?.dispose?.();
  loading(t('Opening project...'));
  let project;
  try {
    project = await library.openProject(id);
  } catch (err) {
    toast(err?.message || t("Couldn't open the project."), { kind: 'error' });
    showHome();
    return;
  }
  if (project.deletedAt) {
    toast(t('{name} is in the Trash. Restore it to open it.', { name: project.name }), { kind: 'error' });
    history.replaceState(null, '', '#trash');
    showHome();
    return;
  }
  const { Editor } = await import('./ui/editor.js');
  view = new Editor(root, {
    library,
    project,
    account,
    onExit: () => showHome(),
    onNewProject: () => createProject({ ratio: 'original' }),
    onOpenProject: (other) => openProject(other),
  });
  history.replaceState(null, '', `#project=${encodeURIComponent(id)}`);
  if (files?.length) {
    const assets = await view.ctx.actions.importFiles(files);
    let first = true;
    for (const a of assets) {
      view.ctx.actions.addAsset(a, { start: view.ctx.store.duration, adoptRatio: first });
      first = false;
    }
    view.ctx.store.seek(0);
  }
}

async function createProject(opts = {}, files) {
  loading(t('Creating project...'));
  try {
    const n = (await library.listProjects()).length + 1;
    const project = await library.createProject({ name: `Project ${n}`, ratio: opts.ratio || 'original' });
    await openProject(project.id, files);
  } catch (err) {
    console.error(err);
    toast(t("Couldn't create a project."), { kind: 'error' });
    showHome();
  }
}

async function openBundle(file) {
  loading(t('Opening project file...'));
  try {
    const { project } = await importProjectBundle(library, file);
    await openProject(project.id);
  } catch (err) {
    console.error(err);
    toast(err?.message || t("Couldn't open the project file."), { kind: 'error' });
    showHome();
  }
}

/**
 * 插件版启动：工程库落在宿主的本地磁盘目录里。
 *
 * 目录在 `otools/backend.js` 里解析（默认「视频/Video Studio」，用户可在首页换）。
 * 这里负责把它建出来、把标记文件写上，然后把 `Library` 接上去。
 */
async function startOtools() {
  loading(t('Opening your project folder...'));
  let rootPath = '';
  try {
    rootPath = await resolveRoot();
    if (!rootPath) throw new Error(t('The host did not report a folder for this computer.'));
    await ensureRoot(rootPath);
  } catch (err) {
    console.error(err);
    errorScreen(t('Could not open the project folder'), `${host.errorMessage(err)}${t(' — pick another folder in OTools and try again.')}`, () => location.reload());
    return;
  }
  library = new Library(otoolsBackend(rootPath));
  account = {
    // 没有账号体系：显示成本地工作区，而不是「未登录」。
    user: { username: 'Local' },
    env: 'otools',
    picture: null,
  };
  host.diag({ root: rootPath, backend: 'otools' });
  route();
}

/** 宿主不可用（把 dist/ 拖进普通浏览器）：退回上游的浏览器本地存储。 */
function startLocal(env) {
  library = new Library(opfsAvailable() ? opfsBackend() : memoryBackend());
  account = { user: null, env, picture: null };
  route();
}

function route() {
  const m = /#project=([^&]+)/.exec(location.hash);
  if (m) openProject(decodeURIComponent(m[1]));
  else showHome();
}

async function boot() {
  if (host.available()) {
    await startOtools();
    return;
  }
  // 没有宿主：上游的「离线」分支，存在浏览器里，功能照常（导入/导出走浏览器自己的对话框）。
  console.warn('[video-studio] OTools host not found; falling back to browser storage.');
  startLocal('web');
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

if (typeof window !== 'undefined' && !window.__VIDEO_STUDIO_TEST__) boot();

// Development hook: drive the app from the console or browser automation.
//   await vs.importDev(['clip-a.mp4', 'music.mp3'], { add: true })
if (import.meta.env.DEV) {
  window.vs = {
    get view() {
      return view;
    },
    get ctx() {
      return view?.ctx;
    },
    get library() {
      return library;
    },
    async importDev(names, { add = false } = {}) {
      const files = [];
      for (const n of names) {
        const blob = await (await fetch(`/.dev-media/${n}`)).blob();
        files.push(new File([blob], n, { type: blob.type }));
      }
      return view.ctx.actions.importFiles(files, { addToTimeline: add });
    },
  };
}

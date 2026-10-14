/**
 * i18n 爬虫：在 jsdom 里**真的把界面挂起来**，看屏幕上还剩哪些英文。
 * ------------------------------------------------------------------
 *   node scripts/i18n-crawl.mjs            总览（按屏幕分组列缺口）
 *   node scripts/i18n-crawl.mjs --all      连属性（title/aria-label）也列出来
 *   node scripts/i18n-crawl.mjs --json     机器可读，给 CI 或别的脚本用
 *
 * 为什么需要它——`i18n-report.mjs` 衡量的是「词典 vs 源码里启发式抽出来的
 * 候选」，也就是**我的抽取器认得的东西**。抽取器漏掉一种调用形状（曾经漏掉
 * `store.update('Add track', …)`），那一整类文案就永远不出现在报告里，
 * 于是「覆盖率 95%」和「界面上还有英文」可以同时为真。
 *
 * 这个脚本换一把尺子：不问源码里写了什么，只问**渲染出来之后屏幕上是什么**。
 * 它挂载首页（项目 / 模板 / 回收站）与编辑器（时间线、素材面板、检查器、
 * 偏好设置、导出），装上 DOM 翻译层，然后把没被翻掉的可见文本收集起来。
 *
 * 已知局限（写在这里免得被当成漏译去查）：
 *   - jsdom 没有布局、没有 WebGL、没有 canvas，靠渲染才出现的文案看不到；
 *   - `svg` 子树整棵跳过，里面若有文字不会被统计；
 *   - 用户自己的内容（项目名、文件名）本来就不该翻，过滤掉了。
 */
import path from 'node:path';
import process from 'node:process';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDir, prepareTree } from './tree.mjs';

register('./lib/stub-css-loader.mjs', import.meta.url);

const has = (name) => process.argv.includes(`--${name}`);

/* ------------------------------------------------------------ jsdom 环境 */

/**
 * 把 jsdom 铺成全局，让上游模块以为自己跑在浏览器里。
 * 这些垫片与上游 `tests/setup.js` 保持一致——同样的环境，同样的行为。
 */
async function installDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title></title></head>
     <body><div id="app"></div><div id="live-region"></div></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDialogElement = window.HTMLDialogElement;
  globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
  globalThis.Event = window.Event;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  // Node 22 把 navigator / location / history / localStorage 定义成只有 getter 的
  // 全局属性，直接赋值会抛。用 defineProperty 覆盖掉。
  for (const name of ['navigator', 'location', 'history', 'localStorage']) {
    Object.defineProperty(globalThis, name, { value: window[name], writable: true, configurable: true });
  }

  window.URL.createObjectURL ||= () => 'blob:stub';
  window.URL.revokeObjectURL ||= () => {};

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = window.ResizeObserver = ResizeObserverStub;

  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.matchMedia = matchMedia;
  globalThis.matchMedia = matchMedia;

  globalThis.requestAnimationFrame = window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = (id) => clearTimeout(id);

  // jsdom 没有 canvas 后端；上游对 getContext() 返回 null 是有防备的。
  window.HTMLCanvasElement.prototype.getContext = () => null;
  if (window.HTMLDialogElement) {
    window.HTMLDialogElement.prototype.showModal ||= function showModal() {
      this.open = true;
    };
    window.HTMLDialogElement.prototype.close ||= function close() {
      this.open = false;
    };
  }
  window.Element.prototype.scrollIntoView ||= function scrollIntoView() {};
  window.Element.prototype.setPointerCapture ||= function setPointerCapture() {};

  return dom;
}

/* ------------------------------------------------------------ 加载构建树 */

const load = (relative) => import(pathToFileURL(path.join(buildDir, relative)).href);

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上游 `tests/helpers.js` 的 `fixture/clip/onMain` 是构造测试工程的最小工具，
 * 直接复用（它在构建树里，和上游测试跑的是同一份）。
 */
async function loadFixtures() {
  return load('tests/helpers.js');
}

/* ---------------------------------------------------------------- 主流程 */

/** 一次「挂载 → 等渲染 → 收集漏译」。 */
async function collect(label, mount) {
  const domI18n = await load('src/otools/dom-i18n.js');
  const i18n = await load('src/otools/i18n.js');
  // 语言跟着宿主走：这里把宿主推的值设成中文，走的就是真实路径。
  globalThis.window.__OTOOLS_LOCALE__ = { locale: 'zh-CN' };
  i18n.setPreference('auto');
  i18n.setPreference('zh-CN');

  domI18n.resetMisses();
  const started = Date.now();
  try {
    await mount();
  } catch (error) {
    return { label, error: error?.message || String(error), rows: [], ms: Date.now() - started };
  }
  await settle();
  domI18n.translateAll();
  await settle();

  return { label, rows: domI18n.missingReport(), ms: Date.now() - started };
}

/**
 * 判断一条漏译值不值得报。
 *
 * `missingReport()` 记的是「所有没被翻掉的文本节点」——里面必然混着时间码、
 * 分辨率、文件名、用户的项目名。这里把明显不是界面文案的滤掉，剩下的才是
 * 真的「界面上能看见的英文」。
 *
 * 其中**含中文的要滤掉**：那是我们翻好的译文（比如「跟随 OTools」里的
 * OTools 也含拉丁字母），不算漏译。
 */
function isUiText(value) {
  const v = value.trim();
  if (v.length < 2) return false;
  if (!/[A-Za-z]{2,}/.test(v)) return false; // 没有连续字母：时间码、数字
  if (/[\u4e00-\u9fa5]/.test(v)) return false; // 已经含中文：不是漏译
  if (/^[\d\s:·.,%×x+\-/]+$/i.test(v)) return false; // 纯数据
  if (/^[A-Z0-9.\s×+-]+$/.test(v)) return false; // 全大写缩写：H.264、LUFS
  if (/Mbps$/.test(v)) return false; // 码率单位，国际通用，按设计保留
  if (/\bYouTube\b/.test(v)) return false; // 平台品牌名（比例提示里的 YouTube 等），按设计保留
  if (/\.(?:mp4|mov|webm|mkv|png|jpe?g|gif|webp|wav|mp3|m4a|aac|ogg|json|cube|srt|vtt|txt|zip)$/i.test(v)) return false;
  if (/^[\w.-]+@[\w.-]+$/.test(v)) return false;
  return true;
}

async function main() {
  const { stats } = prepareTree();
  if (!stats) process.exit(1);

  await installDom();

  const { Library } = await load('src/storage/library.js');
  const { memoryBackend } = await load('src/storage/backends.js');
  const { Home } = await load('src/ui/home.js');
  const { Editor } = await load('src/ui/editor.js');
  const fixtures = await loadFixtures();

  // 工程名故意用「用户数据」的写法：它们**不该**被翻译，
  // 出现在缺口里就说明跳过区写坏了。
  // 工程与素材的名字故意用**真实的样子**：项目名是用户数据（不该被翻，
  // 出现在缺口里就说明跳过区写坏了），素材名用带扩展名的文件名——
  // 这样它们会被 isUiText 的文件名规则滤掉，而不是伪装成漏译。
  const library = new Library(memoryBackend());
  await library.createProject({ name: 'Holiday cut', ratio: '16:9' });
  await library.createProject({ name: 'Interview', ratio: '9:16' });
  const trashed = await library.createProject({ name: 'Old cut' });
  await library.trashProject(trashed.id);

  const account = { user: { username: 'Local' }, env: 'otools', picture: null };
  const noop = () => {};

  /** 一片干净的 `#app`：首页每个视图都要，编辑器只第一次要。 */
  function freshRoot() {
    globalThis.document.body.replaceChildren();
    const root = globalThis.document.createElement('div');
    root.id = 'app';
    globalThis.document.body.append(root, Object.assign(globalThis.document.createElement('div'), { id: 'live-region' }));
    return root;
  }

  /** 复用已有的 `#app`：编辑器只挂一次，后面的屏幕都落在同一个实例上。 */
  function sharedRoot() {
    return globalThis.document.getElementById('app') || freshRoot();
  }

  /**
   * 编辑器**只挂一次**。
   *
   * 一开始每个屏幕都 `new Editor(...)`，五个编辑器屏幕就是五份完整挂载，
   * 在 jsdom 里要跑二十多分钟。改成先建好、再在上面逐个面板打开——
   * 覆盖的面板一个没少，时间降到一分钟量级。
   */
  /**
   * 给编辑器用的工程：素材名改成带扩展名的样子。
   *
   * 上游的 `fixture()` 用素材 id 当名字（`vid` / `aud` / `silent`），渲染出来
   * 会出现在下拉框里——那是用户数据，不是漏译。改成文件名之后它们会被
   * `isUiText` 的规则滤掉，剩下的才是真的「界面上看得见的英文」。
   */
  async function editorProject() {
    const project = fixtures.fixture();
    for (const [id, name] of [['vid', 'beach.mp4'], ['silent', 'clip-2.mp4'], ['aud', 'music.mp3'], ['img', 'family.jpg']]) {
      if (project.assets[id]) project.assets[id].name = name;
    }
    fixtures.onMain(project, fixtures.clip('video', 0, 4), fixtures.clip('image', 4, 2));
    project.markers.push({ id: 'm1', time: 1_000_000, color: '#f5b83d', label: 'Beat' });
    project.range = { in: 0, out: 3_000_000 };
    await library.saveProject(project);
    return project;
  }

  let editor = null;
  async function editorOnce() {
    if (editor) return editor;
    editor = new Editor(sharedRoot(), { library, project: await editorProject(), account, onExit: noop, onNewProject: noop, onOpenProject: noop });
    await settle(80);
    return editor;
  }

  /** 选中时间线上的第一个片段：检查器的内容取决于选中的是什么。 */
  function selectFirstClip(view = editor) {
    const clip = view.ctx.store.project.tracks.flatMap((t) => t.clips)[0];
    view.ctx.store.select([clip.id]);
  }

  const screens = [
    ['首页 · 项目', () => new Home(freshRoot(), { library, account, onOpen: noop, onCreate: noop, onImportFiles: noop })],
    [
      '首页 · 模板',
      () => {
        const home = new Home(freshRoot(), { library, account, onOpen: noop, onCreate: noop, onImportFiles: noop });
        home.show('templates');
        return home;
      },
    ],
    [
      '首页 · 回收站',
      () => {
        const home = new Home(freshRoot(), { library, account, onOpen: noop, onCreate: noop, onImportFiles: noop });
        home.show('trash');
        return home;
      },
    ],
    ['编辑器 · 外壳', editorOnce],
    [
      '编辑器 · 片段检查器',
      async () => {
        const view = await editorOnce();
        selectFirstClip(view);
        await settle(80);
        return view;
      },
    ],
    [
      '编辑器 · 关键帧面板与历史',
      async () => {
        const view = await editorOnce();
        selectFirstClip(view);
        view.ctx.timeline.toggleKeyframePanel();
        view.ctx.history.toggle(true);
        await settle(80);
        return view;
      },
    ],
    [
      '编辑器 · 偏好设置',
      async () => {
        const view = await editorOnce();
        view.ctx.openPreferences();
        await settle(80);
        return view;
      },
    ],
    [
      '编辑器 · 导出',
      async () => {
        const view = await editorOnce();
        view.ctx.openExport?.();
        await settle(80);
        return view;
      },
    ],
  ];

  const results = [];
  const timer = (label) => console.log(`… ${label}`);

  for (const [label, mount] of screens) {
    timer(label);
    const result = await collect(label, mount);
    results.push(result);
    if (!has('json')) {
      const shown = result.rows.filter((row) => isUiText(row.key) && (has('all') || row.text > 0));
      const seconds = (result.ms / 1000).toFixed(1);
      console.log(`── ${label}（${result.error ? `挂载失败：${result.error}` : `${seconds}s`}）`);
      if (!shown.length) {
        console.log('   没有发现漏译');
        continue;
      }
      for (const row of shown.slice(0, has('all') ? 200 : 40)) {
        const kind = row.text ? 'text' : 'attr';
        console.log(`   [${kind}] ${JSON.stringify(row.key)}`);
      }
      if (shown.length > (has('all') ? 200 : 40)) console.log(`   …还有 ${shown.length - 40} 条，用 --all 看全部`);
    }
  }

  // 汇总：同一个文案可能在多个屏幕出现，按屏幕数排一下，好决定先修哪个
  const byKey = new Map();
  for (const result of results) {
    for (const row of result.rows) {
      if (!isUiText(row.key)) continue;
      if (!has('all') && !row.text) continue;
      const entry = byKey.get(row.key) || { key: row.key, screens: new Set(), text: 0, attr: 0 };
      entry.screens.add(result.label);
      entry.text += row.text;
      entry.attr += row.attr;
      byKey.set(row.key, entry);
    }
  }

  const ranked = [...byKey.values()].sort((a, b) => b.screens.size - a.screens.size || b.text - a.text || a.key.localeCompare(b.key));

  if (has('json')) {
    console.log(JSON.stringify({ screens: results.map((r) => ({ label: r.label, error: r.error })), missing: ranked.map((r) => ({ key: r.key, screens: [...r.screens], text: r.text, attr: r.attr })) }, null, 2));
    return;
  }

  console.log('\n══ 汇总 ══════════════════════════════════════════════════');
  if (!ranked.length) {
    console.log('屏幕上没有残留英文。');
    return;
  }
  console.log(`共 ${ranked.length} 条残留，按出现屏幕数排序：\n`);
  for (const row of ranked.slice(0, 60)) {
    console.log(`  ${String(row.screens.size).padStart(2)} 屏  ${row.text ? 'T' : ' '}${row.attr ? 'A' : ' '}  ${JSON.stringify(row.key)}`);
  }
  console.log('\n（T = 可见文本，A = 悬停提示/无障碍标签）');
}

try {
  await main();
} catch (error) {
  console.error(`\n爬取失败：${error?.stack || error}`);
  process.exit(1);
}

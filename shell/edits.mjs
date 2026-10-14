/**
 * 外科手术式改动清单（移植层第二部分）。
 * ------------------------------------------------------------------
 * `upstream/` 一行都不改：构建时先把它整棵树拷进 `.build/`，再按这里的清单
 * 逐条做**字符串替换**。每条都必须命中恰好 `expect` 次，否则构建直接失败——
 * 上游改了这段代码时，构建会在 CI 上大声报错，而不是悄悄产出一个半移植的包。
 *
 * 什么改动放这里、什么改动放 `shell/overlay/`：
 *
 *   overlay/   整文件替换。用在「这个文件的存在理由变了」的地方——
 *              `index.html`（不再加载 Puter SDK）、`vite.config.js`（构建布局变了）、
 *              `src/main.js`（启动时选哪个世界）。
 *   edits.mjs  1~5 行的局部改动。用在「逻辑不变、只是把 Puter 换成宿主」的地方——
 *              去掉分享入口、把「保存到 Puter」换成宿主另存、把提示文案里的
 *              「Sign in to Puter」换成「本插件不接云端 AI」。
 *
 * `tests/` 也在构建树里，所以**上游测试里跟着一起过期的断言也从这里改**——
 * 这是「改测试」唯一被认可的做法（不要去动 upstream/tests/）。`scripts/test.mjs`
 * 跑的就是改过之后的测试，所以移植层的文案变化会被上游的回归套件覆盖到。
 *
 * 一条 edit 的形状：
 *   { file, find, replace, expect?, why }
 *   - find    必须与 `.build/` 里的原文逐字符一致（含缩进）
 *   - expect  命中次数，默认 1；不是这个数就报错
 *   - why     为什么要改；这条会出现在报错信息里，写给人看
 */

export const edits = [
  /* ============================================================ 评审 / 分享 */
  // 上游的「分享评审」是一整套 Puter 云能力：把 720p 评审副本传到 Puter 云盘、
  // 在用户账号里部署一个 worker、用 puter.kv 存评论、用邀请链接让别人登录评论。
  // 插件版把这一整块拿掉（src/review/、src/ui/review/、worker/ 也一并从构建里删除）。

  {
    file: 'src/ui/editor.js',
    find: "import { createReviewPanel } from './review/review-panel.js';\n",
    replace: '',
    why: '评审面板是 Puter worker + 云盘的功能，插件里整个删除',
  },
  {
    file: 'src/ui/editor.js',
    find: `      openShareReview: () => {
        while (store.nest?.length) store.closeCompound();
        return import('./review/share-dialog.js').then((m) => m.openShareDialog(ctx));
      },
`,
    replace: '',
    why: '分享对话框的入口一并删除',
  },
  {
    file: 'src/ui/editor.js',
    find: `    ctx.review = createReviewPanel(ctx);
    this.el.append(ctx.review.el);
`,
    replace: '',
    why: '不再创建评审面板',
  },
  {
    file: 'src/ui/editor.js',
    find: '    this.ctx.review?.dispose?.();\n',
    replace: '',
    why: '没有评审面板可释放',
  },
  {
    file: 'src/ui/topbar.js',
    find: `    cmd('shareReview', { icon: 'shareReview', label: 'Share for review...' }),
    cmd('reviewComments', { icon: 'comment', label: 'Review comments' }),
`,
    replace: '',
    why: '主菜单里的分享/评论入口删除',
  },
  {
    file: 'src/ui/topbar.js',
    find: `      cmd('shareReview', { icon: 'shareReview', label: 'Share for review...' }),
      cmd('reviewComments', { icon: 'comment', label: 'Review comments', checked: Boolean(ctx.review?.open) }),
`,
    replace: '',
    why: 'File 菜单里的分享/评论入口删除',
  },
  {
    file: 'src/ui/topbar.js',
    find: `  const shareBtn = h('button.btn.share-btn', { type: 'button', 'data-tip': 'Share for review' }, icon('shareReview', 16), h('span', 'Share'));
  shareBtn.addEventListener('click', () => commands.run('shareReview'));
`,
    replace: '',
    why: '顶栏的 Share 按钮删除',
  },
  {
    file: 'src/ui/topbar.js',
    find: "h('div.topbar-right', layoutBtn, shortcutsBtn, account, shareBtn, exportBtn),",
    replace: "h('div.topbar-right', layoutBtn, shortcutsBtn, account, exportBtn),",
    why: '顶栏不再放 Share 按钮',
  },
  {
    file: 'src/ui/commands.js',
    find: `    { id: 'shareReview', label: 'Share for review', group: 'File', keys: [], run: () => ctx.openShareReview?.() },
    { id: 'reviewComments', label: 'Show review comments', group: 'File', keys: [], run: () => ctx.review?.toggle() },
`,
    replace: '',
    why: '命令面板里的分享/评论命令删除',
  },

  /* ================================================== 编辑器里残留的 Puter */
  {
    file: 'src/ui/editor.js',
    find: `    // Inside the Puter desktop, save before the window closes.
    if (typeof puter !== 'undefined' && puter.env === 'app' && puter.ui?.onWindowClose) {
      puter.ui.onWindowClose(async () => {
        await this.saver.flush().catch(() => {});
        await library.flushUploads().catch(() => {});
        puter.exit();
      });
    }
`,
    replace: '',
    why: '只在 Puter 桌面壳里才有的窗口关闭钩子；插件没有这个概念（宿主自己管关闭）',
  },
  {
    file: 'src/ui/editor.js',
    find: "        h('p', 'Projects and media are saved as files in your Puter cloud.'),\n        h('p', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter')),",
    replace: "        h('p', 'Projects and media are saved as plain files in a folder on this computer.'),\n        h('p', h('a', { href: 'https://github.com/HeyPuter/everything/tree/main/src/video-studio', target: '_blank', rel: 'noopener' }, 'Video Studio by HeyPuter (MIT)')),",
    why: '关于框里的存储说明与署名',
  },

  /* ================================================================ 首页 */
  {
    file: 'src/ui/home.js',
    find: "import { TemplatePreview } from './template-preview.js';\n",
    replace: "import { TemplatePreview } from './template-preview.js';\nimport { storageFolderButton, hostReady, hostMessage, saveBlobAs } from '../otools/ui.js';\n",
    why: '移植层的存储目录卡片与宿主另存',
  },
  {
    file: 'src/ui/home.js',
    find: `    const where = backend === 'puter'
      ? [icon('cloudCheck', 16), 'Saved to your Puter cloud']
      : backend === 'local'
        ? [icon('drive', 16), 'Saved in this browser only']
        : [icon('alert', 16), 'Not saved: temporary storage'];`,
    replace: `    const where = backend === 'otools'
      ? [icon('drive', 16), 'Saved as files in a folder on this computer']
      : backend === 'local'
        ? [icon('drive', 16), 'Saved in this browser only']
        : [icon('alert', 16), 'Not saved: temporary storage'];`,
    why: '存储卡片说明本插件的工程存在本机目录里',
  },
  {
    file: 'src/ui/home.js',
    find: "    const storage = h('div.side-storage', h('p.storage-where', ...where), this.usageEl, signIn);",
    replace: "    const storage = h('div.side-storage', h('p.storage-where', ...where), this.usageEl, signIn, storageFolderButton(this.library));",
    why: '存储卡片上加「工程目录」按钮（看路径 / 换目录 / 在文件管理器里打开）',
  },
  {
    file: 'src/ui/home.js',
    find: "      h('footer.home-footer', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter')),",
    replace: "      h('footer.home-footer', h('a', { href: 'https://github.com/HeyPuter/everything/tree/main/src/video-studio', target: '_blank', rel: 'noopener' }, 'Video Studio by HeyPuter (MIT)')),",
    why: '首页页脚署名改成上游出处',
  },
  {
    file: 'src/ui/home.js',
    find: `  /** Download the file, or offer to save it to Puter when signed in. */
  deliver({ blob, fileName }) {
    const canSave = this.library.backend.kind === 'puter' && typeof puter !== 'undefined';
    if (!canSave) {
      downloadBlob(blob, fileName);
      toast(\`Downloaded \${fileName}\`, { kind: 'success' });
      return;
    }
    const status = h('p.dialog-text', { role: 'status' }, \`\${fileName} (\${formatSize(blob.size)})\`);
    const dl = h('button.btn', { type: 'button' }, icon('download', 16), 'Download');
    const save = h('button.btn.primary', { type: 'button' }, icon('cloud', 16), 'Save to Puter');
    const d = openDialog({ title: 'Project file ready', body: status, actions: [dl, save], className: 'small' });
    dl.addEventListener('click', () => {
      downloadBlob(blob, fileName);
      d.close();
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        let item;
        if (puter.ui?.showSaveFilePicker) item = await puter.ui.showSaveFilePicker(blob, fileName);
        else {
          const user = this.account?.user || (await puter.auth.getUser());
          item = await puter.fs.write(\`/\${user.username}/Documents/\${fileName}\`, blob, { dedupeName: true, createMissingParents: true, overwrite: false });
        }
        toast(\`Saved to \${item?.path || item?.name || 'Puter'}\`, { kind: 'success' });
        d.close();
      } catch (err) {
        toast(\`Could not save to Puter: \${err?.message || err}\`, { kind: 'error' });
        save.disabled = false;
      }
    });
  }`,
    replace: `  /** Save the project file to this computer, or download it in a plain browser. */
  deliver({ blob, fileName }) {
    if (!hostReady()) {
      downloadBlob(blob, fileName);
      toast(\`Downloaded \${fileName}\`, { kind: 'success' });
      return;
    }
    const status = h('p.dialog-text', { role: 'status' }, \`\${fileName} (\${formatSize(blob.size)})\`);
    const dl = h('button.btn', { type: 'button' }, icon('download', 16), 'Download');
    const save = h('button.btn.primary', { type: 'button' }, icon('drive', 16), 'Save to file');
    const d = openDialog({ title: 'Project file ready', body: status, actions: [dl, save], className: 'small' });
    dl.addEventListener('click', () => {
      downloadBlob(blob, fileName);
      d.close();
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const path = await saveBlobAs(blob, fileName, { title: 'Save project file' });
        if (!path) {
          save.disabled = false;
          return;
        }
        toast(\`Saved to \${path}\`, { kind: 'success' });
        d.close();
      } catch (err) {
        toast(\`Could not save the project file: \${hostMessage(err)}\`, { kind: 'error' });
        save.disabled = false;
      }
    });
  }`,
    why: '工程文件导出：从「存到 Puter 云盘」换成宿主另存对话框',
  },
  /* ================================================== 导出对话框（保存路径） */
  {
    file: 'src/ui/export-dialog.js',
    find: "import { prefs, setPref } from './prefs.js';\n",
    replace: "import { prefs, setPref } from './prefs.js';\nimport { hostReady, hostMessage, saveBlobAs, saveBlobToVideos } from '../otools/ui.js';\n",
    why: '移植层的宿主另存 / 存到视频目录',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "const signedIn = (ctx) => ctx.library?.backend?.kind === 'puter' && typeof puter !== 'undefined';",
    replace: `// 上游这里问的是「登录了 Puter 吗」，据此决定要不要显示「存到云盘」。
// 插件版问的是「宿主在不在」，据此决定要不要显示「存到本机」。
const canSaveLocally = () => hostReady();`,
    why: '把「登录 Puter」换成「宿主可用」',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: 'signedIn(ctx)',
    replace: 'canSaveLocally()',
    expect: 3,
    why: '三处调用点（目的地默认值、目的地选项、完成视图）跟着改名',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "if (canSaveLocally()) destOptions.push({ value: 'puter', label: 'Puter', icon: 'cloud' });",
    replace: "if (canSaveLocally()) destOptions.push({ value: 'puter', label: 'Videos folder', icon: 'drive' });",
    why: '目的地选项的文案：Puter → 本机 Videos 目录（内部值仍是 puter，不动其它逻辑）',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "    destHint.textContent = s.destination === 'puter' ? 'Saved to the Videos folder in your Puter account.' : 'Downloaded by your browser.';",
    replace: "    destHint.textContent = s.destination === 'puter' ? 'Saved straight to the Videos folder on this computer.' : hostReady() ? 'A system save dialog opens for each file.' : 'Downloaded by your browser.';",
    why: '目的地说明文案',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: `  function download(r) {
    const url = URL.createObjectURL(r.blob);
    urls.push(url);
    const a = h('a', { href: url, download: r.fileName, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }`,
    replace: `  /**
   * Save one result.
   *
   * 上游这里点的是一个 <a download>，在 Puter 的桌面壳里能落盘。插件宿主是
   * Tauri webview，没有下载管理：<a download> 要么静默失败，要么弹宿主的下载提示。
   * 所以有宿主时改走「系统另存对话框 + 写盘」，宿主不在（dist 拖进浏览器）才退回原来的做法。
   */
  async function download(r) {
    if (hostReady()) {
      try {
        const path = await saveBlobAs(r.blob, r.fileName, { title: 'Save export' });
        if (path) {
          announce(\`Saved \${r.fileName}\`);
          toast(\`Saved \${r.fileName}\`, { kind: 'success' });
        }
        return;
      } catch (err) {
        toast(\`Could not save \${r.fileName}: \${hostMessage(err)}\`, { kind: 'error' });
        return;
      }
    }
    const url = URL.createObjectURL(r.blob);
    urls.push(url);
    const a = h('a', { href: url, download: r.fileName, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }`,
    why: '导出落盘：浏览器下载换成宿主另存对话框',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: `  async function saveToVideos(r, statusEl) {
    statusEl.textContent = 'Saving to Puter...';
    try {
      const user = ctx.account?.user || (await puter.auth.getUser());
      const item = await puter.fs.write(\`/\${user.username}/Videos/\${r.fileName}\`, r.blob, { dedupeName: true, createMissingParents: true, overwrite: false });
      statusEl.textContent = \`Saved to \${item?.path || \`Videos/\${r.fileName}\`}\`;
      announce(\`Saved \${r.fileName} to Puter\`);
    } catch (err) {
      statusEl.textContent = 'Could not save to Puter.';
      toast(\`Could not save to Puter: \${err?.message || err}\`, { kind: 'error' });
    }
  }`,
    replace: `  async function saveToVideos(r, statusEl) {
    statusEl.textContent = 'Saving to the Videos folder...';
    try {
      const path = await saveBlobToVideos(r.blob, r.fileName);
      if (!path) throw new Error('no host');
      statusEl.textContent = \`Saved to \${path}\`;
      announce(\`Saved \${r.fileName}\`);
    } catch (err) {
      statusEl.textContent = 'Could not save the file.';
      toast(\`Could not save \${r.fileName}: \${hostMessage(err)}\`, { kind: 'error' });
    }
  }`,
    why: '「存到视频目录」：从 Puter 云盘换成宿主本机 Videos 目录',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: `  async function saveWithPicker(r, statusEl) {
    if (!puter.ui?.showSaveFilePicker) return saveToVideos(r, statusEl);
    statusEl.textContent = 'Choose where to save it in Puter.';
    try {
      // The picker never resolves when dismissed, so the status just stays as a prompt.
      const item = await puter.ui.showSaveFilePicker(r.blob, r.fileName);
      statusEl.textContent = \`Saved to \${item?.path || item?.name || 'Puter'}\`;
      announce(\`Saved \${r.fileName} to Puter\`);
    } catch (err) {
      statusEl.textContent = 'Could not save to Puter.';
      toast(\`Could not save to Puter: \${err?.message || err}\`, { kind: 'error' });
    }
  }`,
    replace: `  async function saveWithPicker(r, statusEl) {
    if (!hostReady()) return saveToVideos(r, statusEl);
    statusEl.textContent = 'Choose where to save it.';
    try {
      const path = await saveBlobAs(r.blob, r.fileName, { title: 'Save export' });
      if (!path) {
        statusEl.textContent = 'Save cancelled.';
        return;
      }
      statusEl.textContent = \`Saved to \${path}\`;
      announce(\`Saved \${r.fileName}\`);
    } catch (err) {
      statusEl.textContent = 'Could not save the file.';
      toast(\`Could not save \${r.fileName}: \${hostMessage(err)}\`, { kind: 'error' });
    }
  }`,
    why: '「另存为」按钮：从 Puter 的文件选择器换成宿主另存对话框',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "      const dl = h('button.btn', { type: 'button' }, icon('download', 16), 'Download');",
    replace: "      const dl = h('button.btn', { type: 'button' }, icon('download', 16), hostReady() ? 'Save as...' : 'Download');",
    why: '结果行的「Download」在有宿主时其实是「另存为」',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "      const save = cloud ? h('button.btn', { type: 'button' }, icon('cloud', 16), 'Save to Puter') : null;",
    replace: "      const save = cloud ? h('button.btn', { type: 'button' }, icon('drive', 16), 'Save to Videos folder') : null;",
    why: '结果行的「Save to Puter」文案',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: `  function finish() {`,
    replace: `  async function finish() {`,
    why: 'download() 现在是异步的（宿主另存是异步对话框），完成流程要能 await',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "    if (s.destination !== 'puter' || !cloud) for (const r of results) download(r);",
    replace: "    if (s.destination !== 'puter' || !cloud) for (const r of results) await download(r);",
    why: '有宿主时另存对话框要一个一个弹，不能并发',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: " * view with a live thumbnail, then a result view with Download and Save to\n * Puter. Settings are remembered per device.",
    replace: " * view with a live thumbnail, then a result view with Save as and Save to the\n * Videos folder. Settings are remembered per device.",
    why: '文件头注释里的描述',
  },

  /* ================================ 默认导出格式：VP9 / WebM ================================ */
  // H.264 / HEVC 在本插件里走的是 WebCodecs 的**硬件**编码路径：某些 webview
  // （macOS 上的 WKWebView 尤其常见）isConfigSupported() 说支持，真正开始编码却
  // 静默挂起——不会抛错，进度永远停在 0%。VP9 是软件编码（WebKit 上是进程内的
  // libvpx），在这些环境里能跑完，所以默认改成 VP9 / WebM；用户仍可以在导出
  // 设置里手动选回 H.264 / MP4。
  //
  // 只有「默认值」改了，用户一旦自己选过就以他的选择为准：编码卡住时**不自动
  // 换格式**（悄悄把选好的 MP4 变成 WebM 是不能接受的），而是明确报错并告诉他
  // 该改哪一项。
  {
    file: 'src/engine/exporter.js',
    find: "  codec: 'avc',\n  format: 'mp4',",
    replace: "  codec: 'vp9',\n  format: 'webm',",
    expect: 1,
    why: '默认导出格式改成 VP9 / WebM：WebCodecs 硬件编码在部分 webview 里会静默挂起',
  },

  // 上游这条断言写的是「H.264 + 192 kbps 音频，一分钟大约 70~80 MB」，但它用的是
  // `{ ...DEFAULT_SETTINGS }`——默认格式一改成 VP9（码率效率 0.65）数字就对不上了。
  // 断言的意图没变，所以这里把格式钉死成它当年假设的 H.264 / MP4。
  {
    file: 'tests/export.test.js',
    find: "    const s = { ...DEFAULT_SETTINGS, video: true, includeAudio: true, audio: false };",
    replace: "    const s = { ...DEFAULT_SETTINGS, codec: 'avc', format: 'mp4', video: true, includeAudio: true, audio: false };",
    expect: 1,
    why: '默认导出格式改成 VP9 后，这条体积估算断言仍应按它原本假设的 H.264 计算',
  },

  // 诊断：导出卡住时要把「当前停在哪一步」读出来（exporter.js 里记的阶段面包屑）——
  // 给 export-dialog.js 的这个 import 补上 currentExportStage。
  {
    file: 'src/ui/export-dialog.js',
    find: "  describeError, formatBytes, safeFileName, renderFrames,\n} from '../engine/exporter.js';",
    replace: "  describeError, formatBytes, safeFileName, renderFrames, currentExportStage, currentExportParams,\n} from '../engine/exporter.js';",
    expect: 1,
    why: '诊断：从 exporter.js 导入 currentExportStage / currentExportParams，卡住时报阶段、给探测喂真实参数',
  },
  // 诊断：裸 WebCodecs 编码能力探测（移植层自己的模块，构建时随 shell/src/ 进入 .build/）。
  {
    file: 'src/ui/export-dialog.js',
    find: "import { hostReady, hostMessage, saveBlobAs, saveBlobToVideos } from '../otools/ui.js';",
    replace: "import { hostReady, hostMessage, saveBlobAs, saveBlobToVideos } from '../otools/ui.js';\nimport { probeCodecs, summarizeProbes } from '../otools/codec-probe.js';",
    expect: 1,
    why: '诊断：导入裸 WebCodecs 探测，卡住时告诉用户到底哪个编码真出不了帧',
  },

  /* ============================ 导出卡住时说清「停在哪一步」 ============================ */
  // 「编码卡住」是个太笼统的说法：同一副样子背后可能是编码能力检测、输出启动、
  // 字体/LUT/抠图模型加载、逐帧渲染、逐帧编码、收尾封装中的任何一步挂住。
  // 在 exporter.js 里记下当前阶段，卡住时报给用户，省得靠猜。
  {
    file: 'src/engine/exporter.js',
    find: "/** Output pixel size: project aspect, short side = resolution, even dimensions. */",
    replace: `/** 当前导出停在哪一步（诊断用；卡住时报给用户，也不写进任何产物）。 */
let exportStage = '';
export function currentExportStage() {
  return exportStage;
}

/** 当前导出的真实参数（诊断用；编码探测要拿它贴近复现，不能拿玩具配置猜）。 */
let exportParams = null;
export function currentExportParams() {
  return exportParams;
}

/** Output pixel size: project aspect, short side = resolution, even dimensions. */`,
    expect: 1,
    why: '导出卡住时要能说出停在哪一步，并把真实导出参数交给编码探测',
  },
  {
    file: 'src/engine/exporter.js',
    find: "  const hw = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps, hardwareAcceleration: 'prefer-hardware' }).catch(() => false);",
    replace: "  const hw = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps, hardwareAcceleration: 'prefer-hardware' }).catch(() => false);\n  exportParams = { codec: s.codec, width, height, fps, bitrate, hardware: hw };",
    expect: 1,
    why: '诊断：记下真实导出的 编码/分辨率/帧率/码率/硬件偏好，供编码探测贴近复现',
  },
  {
    file: 'src/engine/exporter.js',
    find: "  const supported = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps }).catch(() => false);",
    replace: "  exportStage = '检测编码能力';\n  const supported = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps }).catch(() => false);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：编码能力检测',
  },
  {
    file: 'src/engine/exporter.js',
    find: "  const sink = await openTarget(estimated, forceTarget);",
    replace: "  exportStage = '打开输出目标';\n  const sink = await openTarget(estimated, forceTarget);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：打开输出目标',
  },
  {
    file: 'src/engine/exporter.js',
    find: "    output.setMetadataTags({ title: s.name || project.name, date: new Date() });\n    await output.start();",
    replace: "    output.setMetadataTags({ title: s.name || project.name, date: new Date() });\n    exportStage = '启动输出（建编码器）';\n    await output.start();",
    expect: 2,
    why: '导出卡住时说清停在哪一步：output.start()（视频与音频两条导出路径都有这一步）',
  },
  {
    file: 'src/engine/exporter.js',
    find: "    await preloadFonts(project);",
    replace: "    exportStage = '加载字体';\n    await preloadFonts(project);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：字体',
  },
  {
    file: 'src/engine/exporter.js',
    find: "    await ensureLuts(project, library).catch(() => {});",
    replace: "    exportStage = '加载 LUT';\n    await ensureLuts(project, library).catch(() => {});",
    expect: 1,
    why: '导出卡住时说清停在哪一步：LUT',
  },
  {
    file: 'src/engine/exporter.js',
    find: "    await ensureCutout(project);",
    replace: "    exportStage = '加载人像抠图模型';\n    await ensureCutout(project);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：抠图模型（MediaPipe WASM，最容易在这一步静默挂住）',
  },
  {
    file: 'src/engine/exporter.js',
    find: "      await renderer.render(t);",
    replace: "      exportStage = `渲染第 ${i + 1} / ${total} 帧`;\n      await renderer.render(t);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：逐帧渲染',
  },
  {
    file: 'src/engine/exporter.js',
    find: "      await videoSource.add(i / fps, 1 / fps);",
    replace: "      exportStage = `编码第 ${i + 1} / ${total} 帧`;\n      await videoSource.add(i / fps, 1 / fps);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：逐帧编码',
  },
  {
    file: 'src/engine/exporter.js',
    find: "    await pumpAudio(Infinity);",
    replace: "    exportStage = '收尾混音与封装';\n    await pumpAudio(Infinity);",
    expect: 1,
    why: '导出卡住时说清停在哪一步：收尾',
  },
  {
    file: 'src/engine/exporter.js',
    find: "  } catch (err) {\n    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});",
    replace: "  } catch (err) {\n    exportStage = '';\n    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});",
    expect: 2,
    why: '出错时清掉阶段，免得下一次读到过期的值（视频与音频两条路径的 catch 都要清）',
  },

  /* ===================== 原生 H.264 快路径：浏览器 H.264 不给力，上宿主硬件编码 ===================== */
  // 诊断坐实：WKWebView 的 WebCodecs H.264 在真实分辨率会把 H.264 编到一半静默挂死
  // （isConfigSupported 说支持、实际 0 帧）。VP9 能编但慢。所以 H.264/MP4 在「宿主可用
  // 且 macOS 且 ffmpeg 带 h264_videotoolbox」时，改走宿主硬件编码：逐帧渲染成 JPEG 落盘，
  // 交 native/ 这个 cdylib 里的 ffmpeg 编成 H.264/MP4。任一条件不满足就继续走下面原有的
  // WebCodecs/mediabunny 管线（VP9/WebM 在浏览器里可靠），行为与从前完全一致。
  {
    file: 'src/engine/exporter.js',
    find: "import { framePosition, needsBetween, FRAME_SNAP } from '../model/slow-motion.js';\n",
    replace: "import { framePosition, needsBetween, FRAME_SNAP } from '../model/slow-motion.js';\nimport { nativeH264Available, exportVideoNativeH264 } from '../otools/native-encoder.js';\n",
    expect: 1,
    why: '原生 H.264 快路径：导入移植层的原生编码入口',
  },
  {
    file: 'src/engine/exporter.js',
    find: `  const total = frameCount(duration, fps);
  exportStage = '检测编码能力';`,
    replace: `  const total = frameCount(duration, fps);
  exportParams = { codec: s.codec, width, height, fps, bitrate, hardware: false };
  exportStage = '';
  // 【原生 H.264 快路径】H.264/MP4 且宿主可用（macOS + ffmpeg 带 h264_videotoolbox）时，
  // 不走浏览器 WebCodecs——它在部分 WKWebView（实测 1080p）把 H.264 编到一半静默挂死。
  // 改走宿主硬件编码：逐帧渲染成 JPEG 落盘，交 ffmpeg 编 H.264/MP4（video-only MVP）。
  // 任一条件不满足就继续走下面的 WebCodecs 管线（VP9/WebM 在浏览器里可靠）。
  if (s.video && !s.gif && s.codec === 'avc' && s.format === 'mp4' && (await nativeH264Available())) {
    exportStage = '原生编码（ffmpeg）';
    const nativeRenderer = new FrameRenderer(project, library, width, height);
    try {
      return await exportVideoNativeH264({
        width, height, fps, bitrate, total, duration, name: base,
        signal, onProgress,
        renderFrame: async (i) => { await nativeRenderer.render(frameTime(i, fps)); return nativeRenderer.canvas; },
      });
    } finally {
      await nativeRenderer?.dispose?.().catch(() => {});
    }
  }
  exportStage = '检测编码能力';`,
    expect: 1,
    why: '原生 H.264 快路径：H.264/MP4 + 宿主可用时走 ffmpeg 硬件编码，否则回落 WebCodecs',
  },

  /* ===== 导出卡 0% 看门狗：编码无进度时给出明确报错，而不是永远停在 0% ===== */
  {
    file: 'src/ui/export-dialog.js',
    find: "    controller = new AbortController();",
    replace: `    controller = new AbortController();
    // 编码看门狗：导出卡在 0% 时（WebCodecs/Mediabunny 在某些 webview 里会静默挂起，
    // 不抛错也不吐进度），超时后主动 abort 并给出明确报错，而不是永远停在 0%。
    let lastProgressAt = Date.now();
    let firstProgressSeen = false;
    let stallTimer = null;
    let stallReject = null;
    let stallPromise = null;
    // 卡住的是哪个 job（'video' / 'audio' / 'gif'）：报错文案要按它说人话。
    let stallKind = null;`,
    expect: 1,
    why: '导出卡 0% 看门狗：声明状态变量',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "        const run = kind === 'gif' ? (o) => exportGif(project, library, s, o) : (o) => exportProject(project, library, s, { kind, ...o });",
    replace: `        // 每个 job 启动前重置看门狗，并挂一个「无进度超时」定时器。
        lastProgressAt = Date.now();
        firstProgressSeen = false;
        stallPromise = new Promise((_, rej) => { stallReject = rej; });
        stallTimer = setInterval(() => {
          const since = Date.now() - lastProgressAt;
          // 首帧前给模型加载（LUT/人像抠图）留足时间；开始出帧后只要 12s 没进度就判卡死。
          const limit = firstProgressSeen ? 12000 : 20000;
          if (since > limit) {
            clearInterval(stallTimer);
            if (stallReject) stallReject(Object.assign(new Error('encoder-stalled'), { code: 'encoder-stalled' }));
          }
        }, 1000);
        const run = kind === 'gif' ? (o) => exportGif(project, library, s, o) : (o) => exportProject(project, library, s, { kind, ...o });`,
    expect: 1,
    why: '导出卡 0% 看门狗：每个 job 启动定时器',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "        const kind = jobs[j];",
    replace: "        const kind = jobs[j];\n        stallKind = kind;",
    expect: 1,
    why: '导出卡 0% 看门狗：记住当前 job，报错文案要用',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "        const r = await run({",
    replace: "        const runP = run({",
    expect: 1,
    why: '导出卡 0% 看门狗：把 run 存到变量，便于 race 与吞掉悬挂 rejection',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "            const overall = (j + p.fraction) / jobs.length;",
    replace: "            const overall = (j + p.fraction) / jobs.length;\n            lastProgressAt = Date.now();\n            firstProgressSeen = true;",
    expect: 1,
    why: '导出卡 0% 看门狗：每次进度回调都重置计时',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "        });",
    replace: `        });
        let r;
        try {
          r = await Promise.race([ runP, stallPromise ]);
        } finally {
          // 卡住时 runP 还挂着：挂个 noop 接住它迟到的 rejection，免得冒未处理拒绝。
          runP.catch(() => {});
        }`,
    expect: 1,
    why: '导出卡 0% 看门狗：run 与超时 promise 竞速；卡住就往外抛，不改用户的设置',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "        results.push(r);",
    replace: "        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }\n        results.push(r);",
    expect: 1,
    why: '导出卡 0% 看门狗：正常完成后清掉定时器',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: `  function fail(err) {
    state = 'error';
    titleEl.textContent = 'Export failed';
    const msg = describeError(err, s);
    body.replaceChildren(h('div.export-message', { role: 'alert' }, icon('alert', 28), h('p', msg)));
    const back = h('button.btn', { type: 'button' }, 'Back to settings');
    back.addEventListener('click', backToSettings);
    const close = h('button.btn.primary', { type: 'button' }, 'Close');
    close.addEventListener('click', () => dlg.close());
    footerInfo.replaceChildren();
    footerButtons.replaceChildren(back, close);
    back.focus();
  }`,
    replace: `  function fail(err) {
    state = 'error';
    titleEl.textContent = 'Export failed';
    // err 可能是 Error（交给 describeError 翻译）、字符串（已经翻好的中文报错），
    // 或 DOM 节点（多段报错，比如「卡在哪一步」＋后台探测结论）。统一成一个消息节点，
    // 再把它返回——调用方可握着这个引用，在后续（编码探测）拿到结果后**就地更新文案**。
    const msg = typeof err === 'string' || err?.nodeType ? err : describeError(err, s);
    const msgEl = typeof msg === 'string' ? h('p', msg) : msg;
    body.replaceChildren(h('div.export-message', { role: 'alert' }, icon('alert', 28), msgEl));
    const back = h('button.btn', { type: 'button' }, 'Back to settings');
    back.addEventListener('click', backToSettings);
    const close = h('button.btn.primary', { type: 'button' }, 'Close');
    close.addEventListener('click', () => dlg.close());
    footerInfo.replaceChildren();
    footerButtons.replaceChildren(back, close);
    back.focus();
    return msgEl;
  }`,
    expect: 1,
    why: '诊断：fail 支持直接传字符串/DOM 节点，并返回消息节点（供编码探测就地更新文案）',
  },
  {
    file: 'src/ui/export-dialog.js',
    find: "    } catch (err) {\n      if (err?.name === 'AbortError') {\n        if (!dlg.el.isConnected) return;\n        announce('Export canceled');\n        backToSettings();\n        return;\n      }\n      console.error(err);\n      fail(err);\n    }",
    replace: `    } catch (err) {
      if (err?.name === 'AbortError') {
        if (!dlg.el.isConnected) return;
        announce('Export canceled');
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        backToSettings();
        return;
      }
      if (err?.code === 'encoder-stalled') {
        console.error('Export stalled: no encode progress within timeout');
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        // 不偷偷换格式——用户选了什么就是什么。但要把「卡在哪一步、该改哪一项」说清楚。
        const codecLabel = VIDEO_CODECS.find((c) => c.value === s.codec)?.label || s.codec;
        const stage = currentExportStage();
        const canTryVp9 = stallKind === 'video' && s.codec !== 'vp9' && (!caps || caps.video.includes('vp9'));
        const headline = canTryVp9
          ? \`导出卡住：\${codecLabel} 编码在当前环境没有响应（系统编码器在部分环境会静默挂起）。请在导出设置里改用「VP9 / WebM」后重试——VP9 是软件编码，不依赖系统编码器；或降低分辨率、帧率，或改用 GIF 导出。\`
          : '导出卡住：编码一直没有进度。请尝试降低分辨率或帧率、缩短导出范围，或改用 GIF 导出。';
        // 先把明确的报错亮给用户；编码能力用**裸 WebCodecs** 探测确认（绕开渲染、
        // 绕开 mediabunny，只问浏览器自己能不能真编出帧），拿到结论后**就地补到报错里**。
        // 探测在后台跑，不阻塞报错显示。
        const lines = [h('p', headline)];
        if (stage) lines.push(h('p', \`卡在「\${stage}」这一步，之后一直没有进度。\`));
        const detail = h('p', '正在探测各编码能否真正出帧…');
        lines.push(detail);
        fail(h('div', ...lines));
        // 只对视频卡住探测（音频没有视频编码可探）。探测必须按**真实导出参数**跑——
        // 拿 320×180 编 3 帧会漏掉「1080p 下第 8 帧才卡」这种规模相关挂起、误报可用。
        // 帧数给到 40，要能跨过那种中途卡死。H.264 编不完→是编码器/GPU 进程（Branch A）；
        // 编得完→卡的是上面的 mediabunny（Branch B）。
        if (stallKind === 'video') {
          const p = currentExportParams() || {};
          const list = [...new Set([s.codec, 'vp9'])].filter((c) => c);
          probeCodecs({
            codecs: list,
            width: p.width, height: p.height, bitrate: p.bitrate, framerate: p.fps,
            hardware: p.hardware ? 'prefer-hardware' : 'no-preference',
            frames: 40, timeoutMs: 4000,
          })
            .then((probes) => {
              const summary = summarizeProbes(probes);
              if (summary) detail.textContent = \`按当前导出参数探测（\${p.width || '?'}×\${p.height || '?'}）：\${summary}。\`;
            })
            .catch(() => {});
        }
        return;
      }
      console.error(err);
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      fail(err);
    }`,
    expect: 1,
    why: '导出卡 0% 看门狗：超时命中时给出明确中文报错；取消/其它错误也清掉定时器',
  },

  /* ======================================================= 去 AI 的文案 */
  // 上游把「AI 可用」定义为「登录了 Puter 且工程存在云盘」（media/tts.js 的
  // aiAvailable）。插件里这个判断恒为假，于是所有 AI 面板都会走到各自的
  // 「登录后可用」空状态。逻辑不用改，但文案得说真话。

  {
    file: 'src/media/tts.js',
    find: "/** Puter AI is present and the user is signed in (the project lives in Puter). */\nexport function aiAvailable(ctx) {\n  return typeof puter !== 'undefined' && Boolean(puter.ai) && ctx.library?.backend?.kind === 'puter';\n}",
    replace: `/**
 * Whether cloud AI is available.
 *
 * 上游要求「登录了 Puter 且工程存在云盘」。插件版不接 Puter 云，也**不定义
 * window.puter**，所以这里恒为假——所有 AI 面板会自动落到各自的空状态，
 * 一个都不会被误判成可用。要让 AI 回来，就在启动时提供一个 window.puter
 * （见 README「与上游的差异 / 接回 AI」）。
 */
export function aiAvailable(ctx) {
  return typeof puter !== 'undefined' && Boolean(puter.ai) && ctx.library?.backend?.kind === 'puter';
}`,
    why: '把「为什么 AI 不可用」写在代码里，避免后来人以为是 bug',
  },
  {
    file: 'src/ui/script-video.js',
    find: `/** Explain that a tool needs a Puter account, with a sign-in button when possible. */
export function needAiDialog(account, what) {
  const close = h('button.btn', { type: 'button' }, 'Close');
  const signIn = account?.onSignIn ? h('button.btn.primary', { type: 'button' }, icon('cloud', 16), 'Sign in to Puter') : null;
  const d = openDialog({
    title: 'Sign in to use AI',
    body: h('p.dialog-text', \`\${what} uses Puter AI, so it needs a Puter account. Sign in, then try again.\`),
    actions: [close, signIn].filter(Boolean),
    className: 'small',
    labelledBody: true,
  });`,
    replace: `/** Explain that a tool needs cloud AI, with a sign-in button when the host offers one. */
export function needAiDialog(account, what) {
  const close = h('button.btn', { type: 'button' }, 'Close');
  const signIn = account?.onSignIn ? h('button.btn.primary', { type: 'button' }, icon('cloud', 16), 'Sign in') : null;
  const d = openDialog({
    title: 'Cloud AI is not available',
    body: h('p.dialog-text', \`\${what} runs on Puter AI. This OTools plugin deliberately does not use Puter, so the feature is off. \${AI_OFF_HINT}\`),
    actions: [close, signIn].filter(Boolean),
    className: 'small',
    labelledBody: true,
  });`,
    why: 'AI 提示对话框不再让人去登录 Puter',
  },
  {
    file: 'src/ui/script-video.js',
    find: "import { aiAvailable, TTS_VOICES, synthesize } from '../media/tts.js';",
    replace: "import { aiAvailable, TTS_VOICES, synthesize } from '../media/tts.js';\n\n/** 所有「云端 AI 不可用」提示共用的后半句。 */\nconst AI_OFF_HINT = 'Trimming, effects, colour, captions you type yourself and export all work on this computer.';",
    why: '共用文案常量',
  },
  {
    file: 'src/ui/panels/generate.js',
    find: "  return emptyState('user', 'Sign in to generate pictures', 'Picture generation runs on Puter AI, so it needs a Puter account.', btn);",
    replace: "  return emptyState('user', 'Picture generation is off', 'Picture generation runs on Puter AI, which this plugin does not use. Import pictures from this computer instead.', btn);",
    why: 'AI 生图面板的文案',
  },
  {
    file: 'src/ui/panels/audio.js',
    find: "  return emptyState('user', `Sign in to use ${what}`, `${what[0].toUpperCase()}${what.slice(1)} runs on Puter AI, so it needs a Puter account.`, btn);",
    replace: "  return emptyState('user', `${what[0].toUpperCase()}${what.slice(1)} is off`, `${what[0].toUpperCase()}${what.slice(1)} runs on Puter AI, which this plugin does not use. You can still import an audio file or record a voiceover.`, btn);",
    why: '音频面板的 AI 文案',
  },
  {
    file: 'src/ui/panels/avatars.js',
    find: "  return h('div.avatar-signin', emptyState('user', 'Sign in for spoken scripts', 'Text to speech runs on Puter AI, so it needs a Puter account. You can still give an avatar the voice of an audio clip on the timeline.', btn));",
    replace: "  return h('div.avatar-signin', emptyState('user', 'Spoken scripts are off', 'Text to speech runs on Puter AI, which this plugin does not use. You can still give an avatar the voice of an audio clip on the timeline.', btn));",
    why: '虚拟主播面板的 AI 文案',
  },
  {
    file: 'src/ui/inspector/text-speech.js',
    find: "  return h('div.text-speech', emptyState('user', 'Sign in to use text to speech', 'Text to speech runs on Puter AI, so it needs a Puter account.', btn));",
    replace: "  return h('div.text-speech', emptyState('user', 'Text to speech is off', 'Text to speech runs on Puter AI, which this plugin does not use.', btn));",
    why: '文字转语音面板的 AI 文案',
  },
  {
    file: 'src/ui/panels/captions.js',
    find: "  if (!aiAvailable(ctx)) return signInState(ctx, 'Sign in to generate captions', 'Generated captions turn speech into text with Puter AI, so they need a Puter account. You can still import subtitle files or add captions by hand.');",
    replace: "  if (!aiAvailable(ctx)) return signInState(ctx, 'Captions from speech are off', 'Generated captions turn speech into text with Puter AI, which this plugin does not use. Import a subtitle file or type captions by hand instead.');",
    why: '自动字幕面板的 AI 文案',
  },
  {
    file: 'src/ui/panels/captions.js',
    find: "  if (!aiAvailable(ctx)) return signInState(ctx, 'Sign in to create lyrics', 'Lyrics are heard with Puter AI speech to text, so they need a Puter account. You can still import a lyrics subtitle file or type lines in the Captions list.');",
    replace: "  if (!aiAvailable(ctx)) return signInState(ctx, 'Lyrics are off', 'Lyrics are heard with Puter AI speech to text, which this plugin does not use. Import a lyrics subtitle file or type lines in the Captions list instead.');",
    why: '歌词面板的 AI 文案',
  },
  {
    file: 'src/ui/panels/captions.js',
    find: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;\n  return { el: emptyState('user', title, text, btn), sync() {} };",
    replace: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in') : null;\n  return { el: emptyState('user', title, text, btn), sync() {} };",
    why: '空状态里的登录按钮文案',
  },
  {
    file: 'src/ui/panels/generate.js',
    find: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;",
    replace: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in') : null;",
    why: '空状态里的登录按钮文案',
  },
  {
    file: 'src/ui/panels/audio.js',
    find: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;",
    replace: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in') : null;",
    why: '空状态里的登录按钮文案',
  },
  {
    file: 'src/ui/panels/avatars.js',
    find: "  const btn = ctx.account?.onSignIn ? h('button.btn.small.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in to Puter') : null;",
    replace: "  const btn = ctx.account?.onSignIn ? h('button.btn.small.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in') : null;",
    why: '空状态里的登录按钮文案',
  },
  {
    file: 'src/ui/inspector/text-speech.js',
    find: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;",
    replace: "  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in') : null;",
    why: '空状态里的登录按钮文案',
  },
  /* ==================================================== 顶栏的保存图标 */
  {
    file: 'src/ui/topbar.js',
    find: "cmd('save', { icon: 'cloudCheck' })",
    replace: "cmd('save', { icon: 'saveLocal' })",
    expect: 2,
    why: '保存按钮不该再画一朵云（现在存的是本机文件）',
  },

  /* ============================================== 语言菜单（多语言支持的入口） */
  // 上游只有 Theme 菜单。语言跟随宿主（见 shell/src/otools/i18n.js），但用户
  // 应该能覆盖它，所以把「语言」放在 Theme 旁边——三处：应用菜单、账户菜单、
  // 桌面菜单栏的 View 菜单。菜单项的构造在 i18n.js 里（`languageMenuItems`），
  // 这样「有哪些语言」只有一处定义。

  {
    file: 'src/ui/topbar.js',
    find: "import { promptDialog } from './dialog.js';\n",
    replace: "import { promptDialog } from './dialog.js';\nimport { languageMenuItems } from '../otools/i18n.js';\n",
    why: '顶栏要用移植层的语言菜单',
  },
  {
    // 应用菜单与账户菜单里的 Theme（4 空格缩进）。带上换行是为了不与
    // View 菜单里 6 空格缩进的那一处混在一起。
    file: 'src/ui/topbar.js',
    find: "\n    { label: 'Theme', icon: 'sun', submenu: themeMenuItems },\n",
    replace: "\n    { label: 'Theme', icon: 'sun', submenu: themeMenuItems },\n    { label: 'Language', icon: 'languages', submenu: languageMenuItems },\n",
    expect: 2,
    why: '应用菜单与账户菜单里加上「语言」',
  },
  {
    file: 'src/ui/topbar.js',
    find: "\n      { label: 'Theme', icon: 'sun', submenu: themeMenuItems },\n",
    replace: "\n      { label: 'Theme', icon: 'sun', submenu: themeMenuItems },\n      { label: 'Language', icon: 'languages', submenu: languageMenuItems },\n",
    why: '桌面菜单栏 View 菜单里加上「语言」',
  },
  {
    file: 'src/ui/preferences-dialog.js',
    find: "import { prefs, setPref, getTheme, setTheme } from './prefs.js';\n",
    replace: "import { prefs, setPref, getTheme, setTheme } from './prefs.js';\nimport { preference, setPreference, localeOptionPairs } from '../otools/i18n.js';\n",
    why: '偏好设置里要放语言选择',
  },
  {
    file: 'src/ui/preferences-dialog.js',
    find: "    section('Appearance',\n      choiceRow('Theme', 'theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match the system']], { get: getTheme, set: setTheme }),\n    ),",
    replace: "    section('Appearance',\n      choiceRow('Theme', 'theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match the system']], { get: getTheme, set: setTheme }),\n      choiceRow('Language', 'language', localeOptionPairs(), { get: preference, set: setPreference }),\n    ),",
    why: '偏好设置的「外观」里加上语言选择（与 Theme 并排）',
  },

  /* ================================ 跟着上面文案一起过期的上游测试断言 */
  // 上游有 3 个用例专门断言「未登录时显示去登录 Puter 的提示」。
  // 上面把提示文案改成实话之后，这三个断言就过期了。改断言（而不是删用例）：
  // 它们验的行为——「云端 AI 不可用时给出说明，并且仍然提供不依赖云的那条路」——
  // 在插件里依然成立，只是措辞变了。

  {
    file: 'tests/avatar.test.js',
    find: "  it('shows the sign-in prompt for scripts when signed out but still offers audio clips', async () => {",
    replace: "  it('shows the cloud-AI-off prompt for scripts when signed out but still offers audio clips', async () => {",
    why: '用例名跟着文案走',
  },
  {
    file: 'tests/avatar.test.js',
    find: '    expect(tab.el.textContent).toMatch(/Sign in for spoken scripts/);',
    replace: '    expect(tab.el.textContent).toMatch(/Spoken scripts are off/);',
    why: '虚拟主播面板的空状态文案变了',
  },
  {
    file: 'tests/lyrics.test.js',
    find: "  it('asks to sign in when signed out', () => {\n    const { ctx } = mount({ signedIn: false });\n    expect(tab.el.textContent).toMatch(/Sign in to create lyrics/);\n    [...tab.el.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in to Puter')).click();",
    replace: "  it('explains that cloud AI is off when signed out', () => {\n    const { ctx } = mount({ signedIn: false });\n    expect(tab.el.textContent).toMatch(/Lyrics are off/);\n    [...tab.el.querySelectorAll('button')].find((b) => b.textContent.includes('Sign in')).click();",
    why: '歌词面板的空状态文案与按钮文案变了',
  },
  {
    file: 'tests/text-ui.test.js',
    find: "  it('shows the sign-in state for speech when signed out', () => {\n    tab('Speech').click();\n    expect(env.el.querySelector('.text-speech').textContent).toContain('Sign in to use text to speech');\n    button('Sign in to Puter').click();",
    replace: "  it('shows the cloud-AI-off state for speech when signed out', () => {\n    tab('Speech').click();\n    expect(env.el.querySelector('.text-speech').textContent).toContain('Text to speech is off');\n    button('Sign in').click();",
    why: '文字转语音面板的空状态文案与按钮文案变了',
  },
];

export default edits;

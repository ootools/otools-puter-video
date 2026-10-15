# otools-video

**Video Studio**（[HeyPuter/everything · src/video-studio](https://github.com/HeyPuter/everything/tree/main/src/video-studio)）的 **OTools 插件版**。

上游是一个跑在浏览器里的多轨视频剪辑器（CapCut 的开源替代）：时间线剪辑、字幕、92 种特效、
56 种转场、48 种滤镜、调色与关键帧、人物抠像与美颜、代理素材、WebCodecs 硬件导出。
**它原本是一个 Puter 应用**——工程和素材存在 Puter 云盘、AI 走 Puter AI、分享评审靠用户账号里部署的 worker。

本插件把「云」这一层整体换成「这台电脑」：

| 上游 | 插件版 |
| --- | --- |
| 工程与素材存在 Puter 云盘（未登录时退回浏览器 OPFS） | **本机目录里的普通文件**（默认「视频/Video Studio」，可在首页改） |
| `puter.ui.showOpenFilePicker` 从云盘导入 | 浏览器文件选择器 / 宿主对话框，直接读本机文件 |
| 导出落到 Puter 的 Videos 目录 | 宿主系统另存对话框 / 本机 Videos 目录 |
| `puter.ai.*`（脚本成片、语音字幕、配音、生图、编辑助手…） | **不提供**（上游自己的空状态会说明），但留了接回的口子 |
| Puter 账号登录、在线评审分享 | **不提供** |

**上游 `upstream/` 一行都没改。** 见下面「移植思路」。

---

## 目录

```
otools-video/
├── upstream/                    # HeyPuter/everything 的 src/video-studio 快照（原样，勿改）
├── shell/                       # 移植层（本仓库唯一需要维护的代码）
│   ├── overlay/                 #   整文件替换，按同路径盖到构建树上
│   │   ├── index.html           #     入口：不再加载 js.puter.com；首屏前定好主题
│   │   ├── vite.config.js       #     产物落到仓库根 dist/；不再引上游的 dev 插件
│   │   └── src/main.js          #     启动时选「宿主 + 本机目录」还是「浏览器兜底」
│   ├── src/otools/              #   新增模块，拷到构建树的 src/otools/
│   │   ├── host.js              #     宿主桥：对话框、读写、列目录、建目录、删除、重命名
│   │   ├── backend.js           #     工程库后端：实现上游 storage/backends.js 的接口
│   │   ├── ui.js                #     界面胶水：工程目录卡片、另存、存到视频目录、先选导出路径
│   │   ├── native-encoder.js    #     原生 H.264 编码器：逐帧 JPEG → ffmpeg 硬件编码（含音轨）
│   │   ├── codec-probe.js       #     裸 WebCodecs 编码探测（卡住时报「哪个编码真出不了帧」）
│   │   ├── i18n.js              #     多语言运行时：跟随宿主、可覆盖、实时切换
│   │   ├── i18n.zh-CN.js        #     简体中文词典（英文原文 → 译文）
│   │   ├── i18n.patterns.zh-CN.js #   带插值文案的模式表（anchored 正则）
│   │   ├── dom-i18n.js          #     DOM 翻译层：把上游界面上的英文换成译文
│   │   └── theme-sync.js        #     主题跟随宿主
│   ├── edits.mjs                #   外科手术式字符串替换清单（逐条校验命中次数）
│   ├── drop.mjs                 #   从构建树里删掉的上游文件（评审、云、上游开发夹具）
│   └── tests/                   #   移植层自己的测试（i18n、原生编码器、编码探测…）
├── native/                      #   原生插件（Rust cdylib）：ffmpeg shell-out 硬件 H.264
│   ├── Cargo.toml               #     crate-type = cdylib；产出 libotools_video_native.dylib
│   └── src/lib.rs               #     探活 ffmpeg / 组命令 / 跑编码 / 一键安装 ffmpeg
├── lib/                         #   原生库产物（macOS.dylib，构建生成，.gitignore）
├── scripts/
│   ├── sync-upstream.mjs        #   稀疏拉取上游快照 + 写 upstream.lock.json + --check
│   ├── tree.mjs                 #   合成 .build/（overlay + edits + drops + 清扫）
│   ├── build.mjs                #   node scripts/build.mjs  → dist/
│   ├── build-native.mjs         #   cargo build --release → lib/macOS.dylib
│   ├── dev.mjs                  #   node scripts/dev.mjs    → vite dev（HMR，端口 5517）
│   ├── test.mjs                 #   跑上游的测试套件 + 移植层测试，都在移植后的构建树上
│   ├── i18n-report.mjs          #   多语言覆盖率 / 重复键 / 缺口清单
│   ├── serve-dist.mjs           #   把 dist/ 当静态站点跑起来（无宿主，用于浏览器试）
│   ├── pack-plugin.mjs          #   打包 .oplg + 发布目录
│   ├── verify-plugin.mjs        #   校验 .oplg（ZIP/CRC/摘要/入口/无 Puter SDK）
│   └── deploy-to-otools.ps1     #   同步到 otools 仓库 plugins/ 本地试跑
├── plugin.json                  # OTools 插件清单（entry = dist/index.html）
├── logo.svg
├── upstream.lock.json           # 上游 pin：仓库 / 子路径 / 提交 / 整树内容哈希
├── package.json                 # 构建期依赖（与上游一致：vite / fontsource / mediabunny / mediapipe）
└── .build/  dist/  dist-pack/   # 构建产物（.gitignore）
```

---

## 移植思路

### 上游留了钩子，而且只有一个

上游虽然是个单体前端应用，但**对外部世界的依赖全部收敛在 `window.puter` 上**：
存储（`puter.fs`）、AI（`puter.ai`）、账号（`puter.auth`）、文件选择器（`puter.ui`）、
评审 worker（`puter.workers` / `puter.kv`）。而它自己就支持「拿不到 Puter 时退回本地」
（`src/main.js` 的 `boot()`：`typeof puter === 'undefined'` → `startLocal()`）。

所以最关键的一步是：**插件页面根本不加载 `https://js.puter.com/v2/`**，于是
`typeof puter === 'undefined'` 恒成立，所有云端入口按上游自己的判断自动隐藏或退回本地——
一行上游代码都不用动。

剩下的就是把「本地」从浏览器 OPFS 换成宿主磁盘：

| 上游接口 | 上游实现 | 插件实现 |
| --- | --- | --- |
| `Library(backend)` 的 `readJSON/writeJSON/readBlob/writeBlob/remove/list` | `puterBackend`（云盘）/ `opfsBackend`（浏览器） | `shell/src/otools/backend.js` 的 `otoolsBackend`（宿主磁盘） |
| `<input type=file>` 导入 | 浏览器文件选择器 | **原样保留**（不经 IPC，大文件最快） |
| `<a download>` 导出 | 浏览器下载 | `shell/src/otools/ui.js` 的 `saveBlobAs` / `saveBlobToVideos`（系统另存对话框） |
| `puter.ai.*` | Puter AI | 不提供（`aiAvailable()` 恒假，各面板走自己的空状态） |

### 三层移植，`upstream/` 一行不改

构建时（`scripts/tree.mjs`）把三层叠起来合成 `.build/`，再交给 vite：

```
.build/ = upstream/  +  shell/overlay/  +  shell/src/  +  shell/edits.mjs  −  shell/drop.mjs
```

| 层 | 放什么 | 为什么 |
| --- | --- | --- |
| `shell/overlay/` | 整文件替换 | 用在「这个文件存在的理由变了」的地方。只有 3 个文件：入口 HTML、vite 配置、`main.js`。 |
| `shell/src/` | 新增模块 | 移植层新写的代码（宿主桥 / 后端 / 界面胶水）。**不允许覆盖上游同名文件**，构建会报错。 |
| `shell/edits.mjs` | 字符串替换 | 用在「逻辑不变、只是把 Puter 换成宿主」的地方。每条都要求命中次数精确匹配，上游改了这段代码就在构建时炸。 |
| `shell/drop.mjs` | 删除清单 | 评审与上游开发夹具，整块从构建树里去掉。 |

**为什么不像 otools-cadcraft 那样用 `git subtree`？**
因为上游不是一个独立仓库。Video Studio 是 `HeyPuter/everything` **单体仓库**里的一个子目录，
同一个仓库还有 40 多个别的应用，整仓 checkout 约 1.7 GB，而我们要的只有 17 MB。
`git subtree` 只能整仓拉，挂进来会让本仓库每次 clone 都变成 1.7 GB。
所以改用「**稀疏检出 + 快照 + 内容哈希锁定**」：

```bash
node scripts/sync-upstream.mjs          # 稀疏拉取 → upstream/，并写 upstream.lock.json
node scripts/sync-upstream.mjs --check  # 校验 upstream/ 有没有被人就地改过
```

`upstream.lock.json` 记下仓库、子路径、提交号、提交时间和整棵树的内容哈希。
约束和 subtree 一样：**`upstream/` 只读**，改动一律进 `shell/`。

---

## 与上游的差异

### 去掉的功能（都是「云」）

- **Puter 账号**：没有登录/注册/头像/登出。首页左下角显示的是「本机目录」而不是「未登录」。
- **Puter 云盘存储**：换成宿主磁盘上的普通目录（见下）。
- **在线评审分享**：上游把 720p 评审副本传到云盘、在用户账号里部署一个 worker、
  用 KV 存评论、发邀请链接让别人登录评论。整套（`src/review/`、`src/ui/review/`、`worker/`）删除。
- **Puter AI**：脚本成片、语音自动字幕、歌词、翻译、配音、文字转语音、AI 生图 / 风格重绘、
  编辑助手（Ctrl+K）、亮点提取、说话人虚拟主播的语音。这些入口在上游都是
  「`aiAvailable()` 为假 → 显示空状态」，插件里恒为假，所以**它们自己就隐藏了**，
  提示文案改成了「本插件不接云端 AI」。
- **从 Puter 导入 / 保存到 Puter**：相关按钮与菜单项删除。

### 保留的功能（全部在本机跑）

时间线与多时间线、波纹编辑、复合片段、多机位、分组/标签/禁用、关键帧与缓动、
92 种特效、56 种转场、48 种滤镜、色轮/曲线/HSL/.cube LUT、遮罩、色度键、
**人物抠像与美颜**（MediaPipe 本机推理）、对象擦除、运动跟踪、防抖、
速度曲线与速度斜坡、平滑慢动作、代理素材、字幕（12 种样式、SRT/VTT 导入导出、
查找替换）、文字与文字模板、音频（波形、音量、淡入淡出、降噪、变声、声道）、
快照、撤销历史、项目模板、回收站、项目文件（.zip）导入导出、
**导出**（H.264/HEVC/VP9/AV1，MP4/WebM/MOV/GIF/静帧/WAV/SRT，480p–4K，24–60fps）。

其中 **H.264/MP4 在 macOS 上走宿主的原生硬件编码**（见下「原生 H.264 导出」）：浏览器
WebCodecs 的 H.264 在部分 WKWebView 里会静默挂死，所以插件把这条路径交给宿主自带的
ffmpeg（`h264_videotoolbox`），又快又稳，且**先选保存位置、再直接写文件**（大视频不进内存）。

### 工程目录

默认 `<视频>/Video Studio`（没有「视频」目录时退到「文档」，再退到「主目录」），
首次启动自动创建，并写一个 `video-studio.json` 标记文件。用户可以在**首页左下角的存储卡片**
上点「工程目录」按钮：看完整路径、换目录、在系统文件管理器里打开。

目录里就是上游 `Library` 的那套布局，都是普通文件：

```
Video Studio/
├── video-studio.json          # 标记文件（说明这个目录是什么）
├── index.json                 # 工程列表
├── projects/<id>.json         # 工程文档（纯 JSON，时间是整数微秒）
├── covers/<id>.jpg            # 首页缩略图
├── media/<hash>.<ext>         # 导入的素材，所有工程共享
└── luts/index.json, <hash>.cube   # 导入的调色 LUT
```

把工程目录指到同步盘（OneDrive / Dropbox / 一个 git 仓库）就等于自动备份。
`media/` 里是内容哈希命名的文件，别手动改名。

---

## 多语言与主题跟随

### 宿主怎么把语言交过来

OTools 的宿主会在**创建 webview 时**把语言与主题注入进来，之后在宿主里改设置会**再推一次**
（见宿主 `src-tauri/src/platform/webview/core.rs`）。注入的脚本等价于：

```js
document.documentElement.setAttribute('lang', 'zh-CN');
window.__OTOOLS_LOCALE__ = { locale: 'zh-CN' };
window.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale: 'zh-CN' } }));
document.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale: 'zh-CN' } }));
```

主题是同一套：`documentElement` 上的 `dark` / `light` 类、`data-theme-mode`、
`data-theme-accent`、一堆 `--el-color-*` 变量，加上 `window.__OTOOLS_THEME__` 与
`otools-theme-changed` 事件。

`shell/src/otools/i18n.js` 与 `theme-sync.js` 就盯这两套东西，所以**宿主里改语言/主题，
插件立刻跟着变，不需要重开插件**。三条监听同时用（CustomEvent、`lang` 属性变化、
`storage`），因为不同宿主版本推的方式不完全一样。

### 语言从哪来

优先级从高到低：

| 来源 | 说明 |
| --- | --- |
| 用户在本插件里选的 | 存在 `otools-video.locale`。菜单：**顶栏 → Theme 旁边 → Language**，以及 **偏好设置 → 外观 → Language** |
| 宿主推的 | 上面那套注入。默认行为就是跟随宿主 |
| 浏览器语言 | 宿主没说话时（例如把 `dist/` 拖进普通浏览器）用 `navigator.language` |

语言名用各自的语言写（`简体中文` / `English`），只有「跟随 OTools」那一项跟着界面语言走。
宿主支持 8 种语言（zh-CN / en-US / ja-JP / ko-KR / de-DE / ru-RU / es-ES / ar-SA），
**我们目前提供简体中文一份译文**；其它语言回退英文原文——上游本来就是英文界面，回退是安全的。
页面实际显示什么语言，`documentElement.lang` 就写什么（宿主是日语而我们只有英文时，
`lang` 会是 `en-US`，否则字体与断行会按日文来）。阿拉伯语会额外把 `dir` 设成 `rtl`。

### 上游界面怎么变中文

上游的界面文案是散在 60 多个文件里的英文字面量，**没有 i18n 钩子，也没有集中的文案表**。
「不改上游」这条底线之下，只有一条路：运行时的 DOM 翻译层（`shell/src/otools/dom-i18n.js`）
配上我们自己的词典（`shell/src/otools/i18n.zh-CN.js`）。

它的边界比功能更重要：

- **只精确匹配**：文本节点去掉首尾空白后必须与词典的键逐字符相同才替换。
  所以动态拼接的文案（`Undo 移动片段`、`Saved to C:\…`）不会被误伤。
- **用户内容整棵子树跳过**：时间线片段名、素材文件名、项目名、字幕正文、轨道名…
  见 `SKIP_SELECTORS`。翻译它们等于改用户的数据。
- 只碰文本与 `title` / `aria-label` / `placeholder` / `data-tip` / `alt`，不碰表单值、canvas、svg。
- 记着每个节点的**原文**，所以切语言是幂等的、可逆的（中文 → 英文 → 中文不会套娃）。

**覆盖率**（当前上游快照）：

```bash
node scripts/i18n-report.mjs             # 总览 + 缺口最大的文件 + 重复键检查
node scripts/i18n-report.mjs --missing   # 还没翻译的原文清单
node scripts/i18n-report.mjs --file src/ui/home.js
```

```
候选文案：1439 条不同文案，共出现 1662 次
词典条目：1591 条
已覆盖：1370/1439（95.2%），按出现次数算 95.7%
```

剩下那 5% 基本是**刻意不翻译**的：字体名（Poppins / Inter / Anton…）、编码与容器名
（H.264 / M4A (AAC) / OGG (Opus)）、音乐曲名，以及**评审分享**那一块——评审功能整个
从构建里删掉了，它的文案翻了也没用。没翻到的原文保持英文显示：露英文比露 key 好。

### 加一种语言

1. 复制 `shell/src/otools/i18n.zh-CN.js` 成 `i18n.<locale>.js`，改值（键不动）。
2. 在 `shell/src/otools/i18n.js` 顶上 import 并 `registerCatalog('<locale>', ...)`，
   同时在 `LOCALE_LABELS` 里加它的显示名。
3. `node scripts/i18n-report.mjs` 看还差多少。

词典是**平的** `{ '英文原文': '译文' }`，键与上游源码逐字符一致（包括 `…`、`’`、
末尾的 `...`）。上游同步之后重跑一次报告，把新增的补进来即可。

### 主题跟随

上游自己有主题（`video-studio:theme`，值 `dark` / `light` / `system`，界面里也有 Theme 菜单），
和宿主的主题不能打架，规则是「**我们跟随，直到用户自己选**」：

- 跟随宿主时把值写进 `video-studio:theme`，同时把写过的值记在 `otools-video.theme-followed`；
- 下次两者不一致 → 是用户在 Theme 菜单里自己选的 → 从此不再跟随；
- 用户选回跟宿主一样的值时，跟随自动重新生效。

首屏之前的那一次跟随由 `shell/overlay/index.html` 的内联脚本完成（避免浅色宿主里闪一下深色），
之后交给 `theme-sync.js`。

---

## 构建

```bash
npm install                     # vite / vitest / fontsource / mediabunny / mediapipe

node scripts/sync-upstream.mjs  # 首次：拉上游快照（之后跟进上游时再跑）
node scripts/build.mjs          # 合成 .build/ → vite build → dist/

node scripts/test.mjs           # 可选但强烈建议：跑上游的测试套件（跑在移植后的代码上）
node scripts/pack-plugin.mjs    # 打包 dist-pack/otools-video-<version>.oplg
node scripts/verify-plugin.mjs  # 打包后自检
```

不需要 Rust，不需要 Puter 账号。产物 `dist/` 约 31 MB（其中 MediaPipe 的人体/人脸/姿态/头发
模型与 wasm 约 22 MB，只在第一次用对应工具时加载）。

### 跑起来

```powershell
node scripts/build.mjs
pwsh -File scripts/deploy-to-otools.ps1     # 同步到 <otools>\plugins\otools-video
```

然后重载/重启 OTools，应用列表里会出现「视频剪辑」。

开发时用 `node scripts/dev.mjs`（vite dev + HMR，端口 5517，与 `plugin.json` 的 `devUrl` 一致）。
注意开发态下**宿主不在**，页面会退回上游的浏览器本地存储（OPFS），导入导出走浏览器自己的对话框——
要验证宿主行为必须装进 OTools。想在浏览器里给宿主桥打桩，可以在页面里先执行：

```js
window.otools = {
  dialog: { open: async () => null, save: async () => null },
  readHostFile: async () => ({ name: 'x', dataBase64: '' }),
  listHostDir: async () => [],
};
```

（宿主不在时 `window.__TAURI_INTERNALS__` 也不在，所以插件会走「浏览器兜底」这条路。）

---

## 打包本地安装包（.oplg）

```bash
node scripts/pack-plugin.mjs      # 产物在 dist-pack/：otools-video-<version>.oplg
node scripts/verify-plugin.mjs    # 打包后自检
```

`pack-plugin.mjs` 做三件事：

1. 从 `plugin.json` 生成**生产清单**——删掉 `devUrl` / `quickDev`（正式包不允许带），
   版本号可被第二个参数覆盖（`node scripts/pack-plugin.mjs --version 0.1.1`）。
2. 打成扁平结构的 ZIP（`plugin.json` / `logo.svg` / `dist/…`），即 `.oplg`。
3. 产出一份可直接整目录托管的发布目录：`plugin.json`、`logo.svg`、`SHA256SUMS`、`meta.json`。

`verify-plugin.mjs` 不依赖第三方库（自带最小 ZIP 读取器），除了清单合法性、
SHA256SUMS 覆盖与匹配、无 `devUrl`/`quickDev`、ZIP 条目无重复/无反斜杠/无绝对路径/无 `..`、
逐条 CRC 与解压大小、`entry` 与 `logo.svg` 在包内之外，还额外检查两条本插件特有的：

- 入口 HTML 里的资源引用必须是**相对路径**（宿主用 `otools-plugin://<uuid>/dist/index.html` 提供插件）；
- 入口 HTML 里**不能有指向 `puter.com` 的 `<script src>`**。

**本地安装**：OTools 插件市场 → 安装本地插件 → 选 `.oplg`（`.zip` 也行），
或把 `dist-pack/` 下那份扁平目录整个丢进宿主插件目录。

包内除了前端产物，还带一个原生库 **`lib/macOS.dylib`**（`native/` 编出来的 Rust cdylib），
供 macOS 上的原生 H.264 导出使用。没装 ffmpeg 时原生路径自动回落 WebCodecs，插件照常能用。

```bash
node scripts/build-native.mjs     # 重新编原生库（需要 cargo；只影响 macOS）
```

---

## 原生 H.264 导出（macOS）

浏览器 WebCodecs 的 H.264 在部分 WKWebView 里会**静默挂死**（`isConfigSupported()` 说支持，
编到第 8 帧左右就没有进度了），VP9 是软件编码能跑完但慢。所以插件在 macOS 上把
**H.264 / MP4** 这条路径交给宿主自带的 **ffmpeg 硬件编码（`h264_videotoolbox`）**：

1. 逐帧渲染成 JPEG 落到临时目录（在磁盘上，不占内存）；
2. 音轨用上游同一套离线混音渲成 16-bit PCM WAV；
3. ffmpeg 一次性编成 H.264/MP4（AAC 音轨），**直接写进你选的保存位置**——不再把整段
   视频读回内存，所以几 GB 的片子也不会爆内存。

**依赖 ffmpeg**（要带 `h264_videotoolbox`）。没装时导出设置里会**主动提示**并提供
**「一键安装 ffmpeg」**按钮（走 Homebrew）；也可以自己 `brew install ffmpeg`。
装好后重开插件即可生效。没装 ffmpeg / 非 macOS 时，导出自动回落 WebCodecs（VP9/WebM 等），
行为与从前一致。

> 排查：如果 ffmpeg 装了但原生路径仍没生效，多半是旧 `.oplg` 里的 `.dylib` 被宿主缓存了
> （生产清单里 `native.autoReload: false`）——重装插件或重启 OTools 即可；再确认
> `ffmpeg -encoders | grep h264_videotoolbox` 有输出。

---

## 跟进上游

```bash
node scripts/sync-upstream.mjs      # 拉最新 main，刷新 upstream/ 与 upstream.lock.json
git diff upstream/                  # 上游改了什么
node scripts/test.mjs               # 上游的测试跑在移植后的树上，先看有没有红
node scripts/build.mjs              # 有红就是某条 edit 对不上上游了，报错会指名道姓
```

要盯的地方就三类：

1. `shell/edits.mjs` 里的每一条 —— 上游改了被替换的那段代码，构建会报
   「命中 N 次，期望 M 次」并打印是哪一条、为什么改。照着上游的新代码更新 `find`/`replace`。
2. `shell/overlay/src/main.js` —— 上游 `src/main.js` 变了（新增启动分支、新增路由）时，
   把变化合并进 overlay 那份。这是唯一需要「人工同步」的文件，因为它跟上游差异最大。
3. `package.json` 的依赖版本 —— 跟着 `upstream/package.json` 走。

`shell/drop.mjs` 一般不用动，除非上游又加了新的「只服务云」的目录。

---

## 已知限制

- **导入大素材会走一次 base64 IPC**：宿主的写文件接口只收 base64，而工程库要把素材
  复制进 `media/`。几百 MB 的素材首次导入会有明显等待；1 GB 以上的素材建议先在外部转成
  低码率版本，或者开启代理素材。这是宿主接口的限制，不是移植选择。
- **素材每次打开工程会读一次盘**：上游只在「工程存在云盘」时才挂 OPFS 素材缓存
  （`Library` 里写死了 `kind === 'puter'`）；插件沿用它，所以素材不额外复制一份到浏览器存储，
  代价是每次进入工程要把用到的素材各读一遍（读过之后整场会话留在内存里，与上游的本地模式一致）。
  想省这一次读盘，就把 `src/storage/library.js` 的缓存条件放宽到 `otools`——
  代价是素材会在浏览器里再存一份。
- **导出走系统另存对话框**：有宿主时，原生 H.264 会在**渲染前**先弹一次另存对话框
  （之后直接写该文件，不再弹）；其它编码/多文件任务仍是每个文件弹一次（串行）。
  想完全不弹窗就用导出设置里的「Videos folder」目的地。
- **AI 功能全部不可用**，相关面板显示「本插件不接云端 AI」。
- **上游界面靠运行时翻译**：词典覆盖 95% 的候选文案（按出现次数 96%），
  剩下的是字体名 / 编码名 / 曲名 / 已删掉的评审功能。没翻到的保持英文。
  这是「不改上游」的代价，也是它的好处——上游更新时只要补词典，不用改代码。
- **浏览器直开（无宿主）时退回上游行为**：工程存在浏览器 OPFS 里，导入/导出走浏览器自己的
  对话框，导出是浏览器下载（Tauri webview 里没宿主时下载可能不落盘——那是兜底路径，不是正常用法）。
- **「回收站」是逻辑删除**：上游的设计，删除只是打标记，30 天后才真正清理文件。
- **标题栏的重命名不同步**：上游 `Services` 同款问题，与 cadcraft 一样属于上游行为。
- **上游 UI 是英文**：本插件不改文案语言，只把提到 Puter 的地方改成实话。

## 接回 AI（可选）

上游的 AI 全部通过 `window.puter.ai` 调用，能力检测用的是
`typeof puter !== 'undefined' && Boolean(puter.ai)`（见 `src/media/tts.js` 的 `aiAvailable`）。
所以只要在 `shell/overlay/src/main.js` 启动前装一个 `window.puter` 的桩，
把 `puter.ai.chat` / `txt2speech` / `speech2txt` / `txt2img` 接到任意后端，
上游的 AI 功能就会自己回来，不需要改上游代码。

OTools 宿主自带一个纯文本生成命令 `otools_ai_generate_text`
（`{ systemPrompt, userPrompt, temperature?, maxTokens? }` → `{ text, provider, model }`），
可以接上 `puter.ai.chat`。但要注意：宿主 AI **没有工具调用**，所以编辑助手（Ctrl+K）接不了；
也**不产出音频文件**（`otools_host_tts_speak` 只是让系统朗读），所以文字转语音 / 配音 /
会说话的主播接不了。能靠宿主 AI 救回来的只有基于单轮文本的那几项（翻译字幕、关键词、亮点提取）。

## 许可

上游为 MIT（`HeyPuter/everything` 根目录的 `LICENSE`，其 README 声明「本仓库及其所有子项目、
模块、组件」均按 MIT 分发）。本仓库的移植层（`shell/`、`plugin.json`、`scripts/`）同样以
MIT 分发；`upstream/` 保留上游原样，包括其 `README.md` 与许可声明。

第三方组件：Lucide（ISC）、Mediabunny（MPL-2.0）、MediaPipe 模型（Apache-2.0）、
字体为 SIL OFL 或 Apache-2.0。上游的 `npm run check:licenses`（`upstream/tools/check-licenses.mjs`）
可以复核。

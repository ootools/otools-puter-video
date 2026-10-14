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
│   │   ├── index.html           #     入口：不再加载 js.puter.com，主题跟随 OTools
│   │   ├── vite.config.js       #     产物落到仓库根 dist/；不再引上游的 dev 插件
│   │   └── src/main.js          #     启动时选「宿主 + 本机目录」还是「浏览器兜底」
│   ├── src/otools/              #   新增模块，拷到构建树的 src/otools/
│   │   ├── host.js              #     宿主桥：对话框、读写、列目录、建目录、删除、重命名
│   │   ├── backend.js           #     工程库后端：实现上游 storage/backends.js 的接口
│   │   └── ui.js                #     界面胶水：工程目录卡片、另存、存到视频目录
│   ├── edits.mjs                #   外科手术式字符串替换清单（逐条校验命中次数）
│   └── drop.mjs                 #   从构建树里删掉的上游文件（评审、云、上游开发夹具）
├── scripts/
│   ├── sync-upstream.mjs        #   稀疏拉取上游快照 + 写 upstream.lock.json + --check
│   ├── tree.mjs                 #   合成 .build/（overlay + edits + drops + 清扫）
│   ├── build.mjs                #   node scripts/build.mjs  → dist/
│   ├── dev.mjs                  #   node scripts/dev.mjs    → vite dev（HMR，端口 5517）
│   ├── test.mjs                 #   跑上游的测试套件，但跑在移植后的构建树上
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
或把 `dist-pack/` 下那份扁平目录整个丢进宿主插件目录。插件是纯前端，不注册 native dylib。

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
- **导出走系统另存对话框**：有宿主时，导出完成的每个文件都会弹一次另存对话框
  （多时间线导出就是多个对话框，串行）。想不弹窗就用导出设置里的「Videos folder」目的地。
- **AI 功能全部不可用**，相关面板显示「本插件不接云端 AI」。
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

# AGENTS.md —— otools-video 移植约定

给后续接手这个仓库的 agent（和人）的规则。核心一句话：**`upstream/` 一行都不要改**，
所有移植代码都放在 `shell/`，这样每次跟进上游都只是「重新叠加一次」。

## 铁律

1. **`upstream/` 保持上游原样**。它是 `HeyPuter/everything` 里 `src/video-studio`
   在某个提交上的快照（pin 在 `upstream.lock.json`）。就地改一个字符，
   `node scripts/sync-upstream.mjs --check` 就会失败，下次同步也会把它冲掉。
2. **改行为只有三个地方可以去**，选哪个看改动的形状：
   | 改动的形状 | 放哪 |
   | --- | --- |
   | 这个文件存在的理由变了（入口、构建配置、启动流程） | `shell/overlay/`（整文件替换） |
   | 全新的代码（宿主桥、后端、胶水、i18n） | `shell/src/otools/`（新增模块，**不允许覆盖上游同名文件**） |
   | 1~5 行的局部改动（去掉一个入口、换一句文案、把 Puter 换成宿主） | `shell/edits.mjs` |
   | 整块功能要拿掉（评审、云） | `shell/drop.mjs` |
   | 移植层自己的测试 | `shell/tests/`（拷到 `.build/tests/`，与上游测试同一个 vitest 进程） |
3. **`shell/edits.mjs` 的每一条都必须能命中**。`expect` 是硬约束：上游改了那段代码，
   构建会报「命中 N 次，期望 M 次」并打印是哪一条、为什么改。**不要为了让构建过而放宽 `expect`**，
   要去读上游的新代码，把 `find`/`replace` 更新到新的形状。
4. **不要在 `shell/overlay/` 里放新文件**。overlay 是「替换已有文件」，目标不存在就报错。
   新文件放 `shell/src/otools/`。
5. **不要把 `dist/`、`dist-pack/`、`.build/` 提交进 git**。都是本地构建产物。
6. **不要重新引入 Puter**。`index.html` 里不能出现 `js.puter.com`（`build.mjs` 与
   `verify-plugin.mjs` 都会拦）。要接 AI 就按 README 的「接回 AI」装一个自己的桩。

## 上手前必须知道的三件事

- **上游是单体仓库**。`git subtree` 在这里用不了（整仓 1.7 GB，我们要的只有 17 MB），
  所以用「稀疏检出 + 快照 + 内容哈希锁定」。更新上游就是
  `node scripts/sync-upstream.mjs`，然后 `git diff upstream/`。
- **构建根是 `.build/`，不是仓库根**。`node_modules` 在仓库根（上一级），
  所以 `vite.config.js` 里必须保留 `server.fs.allow: ['..']`，否则 dev 与 vitest 会以
  `Denied ID …/node_modules/…?url` 拒掉 `@mediapipe/tasks-vision` 这类包内资源
  （生产构建不走这条路径，只在 dev/test 上炸）。
- **构建产物不做批量删除**。`scripts/tree.mjs` 是「覆盖式叠加 + 清扫差集」，
  `vite.config.js` 里 `emptyOutDir: false`，`dist/` 的清理由 `sweepDist()` 做——
  清单必须来自 **Vite JS API 报回来的「本次产出了什么」**（`collectEmitted()`），
  **不能**改成「构建之后 dist/ 里有什么」：后者会把上一轮的残留一起记进清单，
  差集永远为空，旧 chunk 会一轮一轮堆下去（这个坑踩过一次）。

## 移植层的地图

| 文件 | 作用 |
| --- | --- |
| `shell/overlay/index.html` | 入口：不加载 Puter SDK；主题跟随 OTools（宿主已经把 `dark`/`light` 类打在 `documentElement` 上） |
| `shell/overlay/vite.config.js` | 产物落 `../dist`；`base: './'`；`server.fs.allow: ['..']` |
| `shell/overlay/src/main.js` | 启动：宿主可用 → 本机目录；否则 → 上游的 OPFS 兜底。评审路由与 `puter.ui` 钩子删除 |
| `shell/src/otools/host.js` | 宿主桥：`window.otoolsVideo`（对话框 / 读写 / 列目录 / 建目录 / 删除 / 重命名 / 主题 / 诊断） |
| `shell/src/otools/backend.js` | `otoolsBackend`：实现上游 `storage/backends.js` 的接口，落到本机目录 |
| `shell/src/otools/ui.js` | 界面胶水：工程目录卡片、`saveBlobAs`、`saveBlobToVideos`、`hostMessage` |
| `shell/src/otools/i18n.js` | 多语言运行时：读宿主语言、三条监听、用户覆盖、`t()`、给菜单用的语言项 |
| `shell/src/otools/i18n.zh-CN.js` | 简体中文词典（键 = 英文原文，逐字符一致） |
| `shell/src/otools/dom-i18n.js` | DOM 翻译层：只精确匹配、用户内容整棵子树跳过、可逆 |
| `shell/src/otools/theme-sync.js` | 主题跟随宿主（「跟随，直到用户自己选」） |
| `shell/edits.mjs` | 53 条局部改动（评审入口、Puter 文案、导出改宿主、保存图标、语言菜单） |
| `shell/drop.mjs` | 从构建树里删掉的路径（评审、上游的假 Puter 夹具）+ 删完之后必须还在的文件清单 |
| `shell/tests/` | 移植层测试：i18n 运行时 + DOM 翻译层的边界（27 个用例） |

## 多语言的规矩

上游没有 i18n，界面文案是散在 60 多个文件里的英文字面量。我们靠
**运行时 DOM 翻译层 + 我们自己的词典**把它变成中文，所以有几条必须守：

- **词典的键是「英文原文」**，必须与源码里的字面量逐字符一致（包括 `…`、`’`、
  末尾的 `...`）。值不会被再次翻译，可以放心用中文词。
- **不要翻译动态拼接的文案**。`Undo ${label}`、`Saved to ${path}` 这种匹配不上，
  用「前缀」当键是无效的。要覆盖它们就得改 `edits.mjs`（把整句变成固定文案）
  或者放弃。
- **不要把用户内容加进词典**。片段名、文件名、项目名、字幕正文都可能是任意字符串，
  撞上词典键就会被改写。`SKIP_SELECTORS` 里列了这些容器；发现新的用户内容区就往里加。
- **改了 `edits.mjs` 里引入的英文文案，就要同步改词典的键**——键对不上，那句就永远是英文。
- **上游同步之后跑一次 `node scripts/i18n-report.mjs`**，看覆盖率掉到哪了，
  用 `--missing` 把新增的补进词典。报告还会查**重复键**（JS 对象允许重复键，
  后者会静默吃掉前者）。
- **不要试图用「正则在源码上批量替换中文」**。那等于 fork 上游，下次同步全冲突。
  要翻译就走词典 + DOM 层。

## 语言与主题的宿主契约

宿主在创建 webview 时注入，之后改设置会**再推一次**：

```js
documentElement.lang = '<locale>';  window.__OTOOLS_LOCALE__ = { locale };
window / document 派发 'otools-locale-changed'
documentElement 上切 dark / light 类 + data-theme-mode / data-theme-accent + --el-color-* 变量
window.__OTOOLS_THEME__ = { themeMode, themeAccent, resolvedTheme };
window / document 派发 'otools-theme-changed'
```

三条监听（CustomEvent、`lang` 属性变化、`storage`）是刻意的冗余：不同宿主版本推的
方式不完全一样。**别把 `documentElement.lang` 当成「我们自己的状态」**——
`i18n.js` 里 `ourLang` 就是用来区分「宿主改的」和「我们改的」，去掉它会来回打架。

## 常见任务

- **上游更新了** → `node scripts/sync-upstream.mjs` → `git diff upstream/` →
  `node scripts/test.mjs`（上游 100 个测试文件跑在移植后的树上，是这里最强的回归）→
  `node scripts/build.mjs`（有 edit 对不上会在这一步报出来）。
  最后两件事要人工看一眼：`shell/overlay/src/main.js` 跟上游 `src/main.js` 的差异有没有变大；
  `package.json` 的依赖版本要不要跟着 `upstream/package.json` 走。
- **要加一个新的宿主能力**（例如把工程目录做成宿主的一个「打开方式」入口）→ 在
  `shell/src/otools/host.js` 里加函数（包装 API 优先、`__TAURI_INTERNALS__.invoke` 兜底），
  在 `ui.js` 里包一层给人用的形状，然后在 `shell/edits.mjs` 或 overlay 里接到界面上。
- **要改 OTools 侧的元信息**（名称/图标/关键词/版本）→ `plugin.json`。

## 不要做的事

- 不要给 `upstream/` 打补丁、加 `.cfg`、写 TODO。
- 不要用 `rm -rf .build` 之外的方式「清理构建树」——`tree.mjs` 的清扫逻辑就是为
  「不做批量删除」设计的，加了删除会把它绕回去。
- 不要在 `shell/edits.mjs` 里写跨越多行的巨大替换。超过 5 行、或者涉及结构性改动，
  就该走 `shell/overlay/`（整文件替换，diff 一眼能看完）。
- 不要把 AI 功能「顺手接一下宿主 AI」就合进来。宿主 AI 只有单轮文本生成，
  没有工具调用、不产出音频文件，接上去会让编辑助手/配音/主播这几处变成半坏状态。
  要接就按 README 的「接回 AI」整段设计。

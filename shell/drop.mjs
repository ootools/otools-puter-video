/**
 * 从构建树里删掉的上游文件 / 目录（移植层第三部分）。
 * ------------------------------------------------------------------
 * 这些文件只服务于插件里已经不存在的功能（Puter 云盘与在线评审），
 * 或者只服务于上游自己的开发/发布流程。`upstream/` 里它们原样保留，
 * 构建时在 `.build/` 里删掉——这样上游的 diff 永远干净。
 */

export const drops = [
  // —— 在线评审（Puter worker + 云盘 + puter.kv）——
  'src/review',
  'src/ui/review',
  'worker',
  'vite.worker.config.js',
  'docs/review.md',
  'tests/review-helpers.js',
  'tests/review-protocol.test.js',
  'tests/review-ui.test.js',
  'tests/review-worker.test.js',

  // —— 上游自己的开发夹具：全部围着「假 Puter SDK」转，插件里没有 Puter ——
  'dev',
];

/** 删完之后必须仍然存在的文件（防止手滑把要用的东西删了）。 */
export const keep = [
  'index.html',
  'src/main.js',
  'src/otools/host.js',
  'src/otools/backend.js',
  'src/otools/ui.js',
  'src/storage/backends.js',
  'src/storage/library.js',
  'src/ui/home.js',
  'src/ui/editor.js',
  'src/ui/export-dialog.js',
];

export default drops;

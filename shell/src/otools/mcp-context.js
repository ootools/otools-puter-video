/**
 * 视频插件 MCP 工具共享的「活上下文」与单位/结果小工具。
 * ------------------------------------------------------------------
 * MCP 桥要在首屏之前挂上，而工程库、编辑器都是之后才有的。所以工具不抓实例，
 * 统一从这里取：入口在库就绪后调用 `setVideoMcpContext()` 交进来，工具被调用
 * 时再解析——没就绪就报一句可行动的错，而不是 undefined 崩掉。
 *
 * 上下文形状（由 `shell/overlay/src/main.js` 提供）：
 *
 *   {
 *     library,                        // Library 实例
 *     libraryRoot,                    // 工程目录的绝对路径（浏览器兜底时是空串）
 *     openProject(id),                // 切到编辑器
 *     refreshHome(),                  // 首页在的话刷一下列表
 *     editorContext(),                // 当前编辑器 ctx；不在编辑器里返回 null
 *   }
 *
 * 时间单位：工程内部一律微秒（见 `model/timeline.js` 的 `US`），MCP 对外一律
 * **秒**——AI 和用户都不该看到 `5000000`。所有转换都收在这一个文件里。
 */

/** 工程内部时间单位：微秒。 */
export const US_PER_SECOND = 1_000_000;

let context = null;

/** 由 `main.js` 在工程库就绪后调用；传 null 表示重置（测试用）。 */
export function setVideoMcpContext(next) {
  context = next || null;
}

export function getVideoMcpContext() {
  return context;
}

/** 工程库；还没建好时给出「仍在启动」的说明。 */
export function requireLibrary() {
  const library = context && context.library;
  if (!library) {
    throw new Error(
      'Video Studio is still starting: the project library is not ready yet. Try again in a moment.',
    );
  }
  return library;
}

/** 工程目录的绝对路径；浏览器兜底（没有宿主磁盘）时直接报错。 */
export function requireLibraryRoot() {
  const root = context && context.libraryRoot;
  if (!root) {
    throw new Error(
      'This plugin has no project folder on disk right now, so it cannot read or write files. Open it inside OTools.',
    );
  }
  return root;
}

/** 当前编辑器的 ctx；不在编辑器里（还在首页）时给出可行动的说明。 */
export function requireEditor() {
  const ctx =
    context && typeof context.editorContext === 'function' ? context.editorContext() : null;
  if (!ctx || !ctx.store) {
    throw new Error(
      'No project is open in the editor. Call open_project first (or create_project, then open_project), then retry.',
    );
  }
  return ctx;
}

/* ------------------------------------------------------------ 结果与单位 */

export const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false,
});

/** 微秒 → 秒，保留三位（30fps 一帧 = 0.033s）。 */
export const seconds = (microseconds) =>
  Math.round(((Number(microseconds) || 0) / US_PER_SECOND) * 1000) / 1000;

/** 秒 → 微秒；负数与非数字直接拒，避免把时间线写坏。 */
export function micros(value, what = 'time') {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`A non-negative ${what} in seconds is required.`);
  }
  return Math.round(number * US_PER_SECOND);
}

/** 可选的秒 → 微秒：没传就是 undefined（让上游用自己的默认值）。 */
export function optionalMicros(value, what = 'time') {
  return value === undefined || value === null || value === '' ? undefined : micros(value, what);
}

export function requiredId(value, what = 'id') {
  const id = String(value == null ? '' : value).trim();
  if (!id) throw new Error(`A ${what} is required.`);
  return id;
}

export function optionalNumber(value, what) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${what} must be a number.`);
  return number;
}

/**
 * 把调用方给的相对路径收敛成「相对工程目录的 POSIX 片段」。
 *
 * 与文件工具同一套规则：绝对路径与 `..` 一律拒绝，桥的能力边界就是工程目录。
 */
export function safeRelative(input, { allowEmpty = false } = {}) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('A path inside the project folder is required.');
  }
  if (/^([a-zA-Z]:|[\\/])/.test(raw)) {
    throw new Error('Only paths relative to the project folder are allowed.');
  }
  const segments = raw.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) {
    throw new Error('Only paths inside the project folder are allowed.');
  }
  if (!segments.length) {
    if (allowEmpty) return '';
    throw new Error('A path inside the project folder is required.');
  }
  return segments.join('/');
}

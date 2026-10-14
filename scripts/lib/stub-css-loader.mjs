/**
 * Node 模块加载钩子：把 Vite 专有的导入形式变成空模块。
 * ------------------------------------------------------------------
 * 上游源码里有三种东西浏览器/Vite 认、Node 不认，而爬虫
 * （`scripts/i18n-crawl.mjs`）要直接 import 构建树里的模块：
 *
 *   1. `import '../styles/export.css'`     —— 样式，忽略掉是安全的；
 *   2. `import x from '…/wasm.js?url'`     —— Vite 的 `?url` / `?raw` /
 *      `?worker` 后缀，Node 的包解析直接报 ERR_PACKAGE_PATH_NOT_EXPORTED；
 *   3. 上面这两种路径指向的包（`@mediapipe/tasks-vision`）用 `exports`
 *      挡住了子路径，连解析都不让。
 *
 * 这些导入跟「界面上有哪些文字」无关，一律短路成一个常量模块。
 */

/** 带这些后缀的说明符是 Vite 的导入形式，不是真正的模块。 */
const VITE_SUFFIX = /\?(?:url|raw|inline|worker|worker&(?:url|inline)|no-inline)(?:&|$)/;

const STUB = 'vs-i18n-stub:';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css') || VITE_SUFFIX.test(specifier)) {
    return { url: `${STUB}${encodeURIComponent(specifier)}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith(STUB)) {
    return { format: 'module', source: 'export default "vs-i18n-stub";', shortCircuit: true };
  }
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return next(url, context);
}

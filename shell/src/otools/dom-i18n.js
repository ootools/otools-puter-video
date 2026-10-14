/**
 * DOM 翻译层：把上游界面上出现的英文原文换成当前语言的译文。
 * ------------------------------------------------------------------
 * 上游界面是 60 多个文件里散着的英文字面量，没有 i18n 钩子，也没有集中的
 * 文案表。**不改上游**这条底线之下，只有一条路可走：在运行时把渲染出来的
 * 文本节点换掉。
 *
 * 做法与边界：
 *
 *   - **只做精确匹配**。文本节点去掉首尾空白后必须与词典的键逐字符相同才替换。
 *     没有模糊匹配、没有子串替换——所以动态拼接的文案（`Undo 移动片段`、
 *     `Saved to C:\…`）不会被误伤，用户自己起的名字也不会被改写。
 *   - **用户内容区整棵子树跳过**（时间线片段名、素材文件名、项目名、字幕正文…），
 *     见 SKIP_SELECTORS。跳过是在遍历时剪枝，不是逐节点回溯祖先。
 *   - **只碰文本与几个展示属性**（title / aria-label / placeholder / data-tip / alt），
 *     不碰表单值、不碰 canvas、不碰 svg。
 *   - 记下每个节点/属性的**原文**，所以切语言时重译是幂等的，不会中文套中文。
 *   - MutationObserver 跟新增节点，按帧批处理；自己的写入不会触发二次写入
 *     （写完 nodeValue 已经等于目标值，下一轮算出来还是同一个值，自然收敛）。
 *
 * 覆盖率：`node scripts/i18n-report.mjs`。没翻到的原文保持英文显示——
 * 这是刻意的：露英文比露 key 好。
 */

import { t, onChange, locale, SOURCE_LOCALE } from './i18n.js';

/** 这些标签里面的东西不是界面文案（或者不该被改写）。 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'TEXTAREA', 'INPUT',
  'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'SVG', 'PATH', 'CODE', 'PRE',
]);

/**
 * 用户内容区：这些容器里放的是用户自己的文字（片段名、文件名、项目名、
 * 字幕正文、轨道名…），翻译它们等于改用户的数据。
 */
const SKIP_SELECTORS = [
  '[contenteditable]',
  '[data-i18n-skip]',
  '#vs-i18n-skip',
  // 时间线
  '.tl-clip', '.clip-name', '.clip-type', '.clip-dur', '.tl-cover', '.tl-header-name',
  // 素材与项目
  '.asset-name', '.asset-group-title', '.media-row-name', '.missing-name',
  '.project-card', '.project-name', '.tpl-card', '.tpl-name',
  // 字幕与文本
  '.cap-text', '.tp-text', '.mask-text-input', '.insp-textarea',
  // 各种用户命名
  '.kf-name', '.mask-row-name', '.mc-card-name', '.mc-cut-name', '.nest-label',
  '.look-name', '.sfx-name', '.tr-name', '.applied-filter-name', '.clipfx-name',
  '.player-timeline-name',
];

/** 需要一起翻译的展示属性。 */
const ATTRS = ['title', 'aria-label', 'placeholder', 'data-tip', 'alt'];

/** 文本节点 -> 原文；元素 -> Map(属性名 -> 原文)。 */
const textOriginals = new WeakMap();
const attrOriginals = new WeakMap();

let observer = null;
let enabled = true;
let scheduled = false;
const pending = new Set();
const stats = { nodes: 0, attributes: 0, passes: 0 };
const misses = new Set();

/**
 * 已安装的观察器挂在 globalThis 上，而不是模块作用域。
 *
 * 两个理由：模块被重新求值（HMR、测试里的 resetModules）时不会又挂一个；
 * `disposeDomTranslation()` 也能把**所有**观察器一次收掉。
 */
const REGISTRY = (globalThis.__vsDomI18nObservers ||= new Set());

/* ------------------------------------------------------------------ 工具 */

function skippedElement(el) {
  if (!el || el.nodeType !== 1) return false;
  // SVG / MathML 里的元素 tagName 保持小写（`svg`、`text`），HTML 里是大写，
  // 所以统一成大写再比。
  const tag = el.tagName ? el.tagName.toUpperCase() : '';
  if (SKIP_TAGS.has(tag)) return true;
  for (const selector of SKIP_SELECTORS) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      /* 选择器写错不该让整层挂掉 */
    }
  }
  return false;
}

/** 往上找最近的元素，看是不是落在用户内容区里（只在遍历入口调一次）。 */
function insideSkipped(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el) {
    if (skippedElement(el)) return true;
    el = el.parentElement;
  }
  return false;
}

/** 记下没翻到的原文（只在有词典的语言下记，英文模式下整棵树都是「没翻到」）。 */
function noteMiss(original) {
  if (locale() !== SOURCE_LOCALE) misses.add(original);
}

/** 保留首尾空白地替换文本。调用方保证这个节点不在跳过区里。 */
function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;

  let original = textOriginals.get(node);
  if (original === undefined) {
    original = trimmed;
    textOriginals.set(node, original);
  }
  const want = t(original);
  if (want === original) noteMiss(original);
  // 注意：要拿 `want` 去和**当前**节点值比，而不是和原文比。
  // 切回原文语言时 want === original，此时正是要把译文还原回英文——
  // 早退就会留下中文。
  const at = raw.indexOf(trimmed);
  const next = `${raw.slice(0, at)}${want}${raw.slice(at + trimmed.length)}`;
  if (node.nodeValue !== next) {
    node.nodeValue = next;
    stats.nodes += 1;
  }
}

function translateAttributes(el) {
  if (!el.hasAttributes()) return;
  let map = null;
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    const raw = el.getAttribute(attr);
    if (!raw) continue;
    if (!map) {
      map = attrOriginals.get(el);
      if (!map) {
        map = new Map();
        attrOriginals.set(el, map);
      }
    }
    let original = map.get(attr);
    if (original === undefined) {
      original = raw;
      map.set(attr, original);
    }
    const want = t(original);
    if (want === original) noteMiss(original);
    // 同 translateTextNode：和当前值比，才能在切回原文语言时还原
    if (raw !== want) {
      el.setAttribute(attr, want);
      stats.attributes += 1;
    }
  }
}

/** 遍历一棵已经在非跳过区里的子树（跳过区在子节点处剪枝）。 */
function translateSubtree(el) {
  translateAttributes(el);
  for (const child of el.childNodes) {
    if (child.nodeType === 3) translateTextNode(child);
    else if (child.nodeType === 1 && !skippedElement(child)) translateSubtree(child);
  }
}

/** 翻译任意一个节点（文本或元素），入口处先判断是不是在跳过区里。 */
function translateNode(node) {
  if (!node) return;
  if (node.nodeType === 3) {
    if (!insideSkipped(node)) translateTextNode(node);
    return;
  }
  if (node.nodeType !== 1) return;
  if (insideSkipped(node)) return;
  translateSubtree(node);
}

/* -------------------------------------------------------------- 调度 */

function flush() {
  scheduled = false;
  stats.passes += 1;
  for (const node of pending) {
    if (node.isConnected) translateNode(node);
  }
  pending.clear();
}

function schedule(node) {
  if (!enabled || !node) return;
  pending.add(node);
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function onMutations(records) {
  if (!enabled) return;
  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of record.addedNodes) schedule(node);
    } else if (record.type === 'characterData') {
      // 上游重新渲染了这段文本：忘掉旧原文，按新的重新来
      textOriginals.delete(record.target);
      schedule(record.target);
    } else if (record.type === 'attributes') {
      attrOriginals.get(record.target)?.delete(record.attributeName);
      schedule(record.target);
    }
  }
}

/* ---------------------------------------------------------------- 对外 */

/** 当前语言下没翻到的原文（调试与报告用）。 */
export function missingStrings() {
  return [...misses].sort();
}

export function domStats() {
  return { ...stats, locale: locale(), missing: misses.size };
}

export function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) translateAll();
}

/** 全量重译。切语言后调用；因为记着原文，重译是幂等的。 */
export function translateAll() {
  if (!enabled || typeof document === 'undefined' || !document.body) return;
  pending.clear();
  translateNode(document.body);
}

export function disposeDomTranslation() {
  for (const installed of REGISTRY) installed.disconnect();
  REGISTRY.clear();
  observer = null;
}

/**
 * 装上翻译层。幂等（跨模块实例也幂等）。
 *
 * @param {{root?: Element}} [options] 只翻译这个根（默认 document.body）
 */
export function installDomTranslation({ root } = {}) {
  if (typeof document === 'undefined' || REGISTRY.size) return;
  const target = root || document.body;
  if (!target) return;

  translateNode(target);

  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(onMutations);
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    REGISTRY.add(observer);
  }

  // 宿主切语言 / 用户在本插件里换语言 → 整棵树重译
  onChange(() => translateAll());
}

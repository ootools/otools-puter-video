/**
 * 多语言运行时的测试。
 *
 * 这些用例跑在移植后的构建树上（`node scripts/test.mjs`），与上游的 100 个
 * 测试文件同一个 vitest 进程——所以它们是移植层的回归，不是「另一套测试」。
 *
 * 每个用例都用 `vi.resetModules()` + 动态 import 拿一份全新的模块状态，
 * 免得用例之间互相污染（i18n.js 有模块级状态与监听器）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PREF_KEY = 'otools-video.locale';

/** 拿一份全新的 i18n 模块。 */
async function freshI18n() {
  vi.resetModules();
  return import('../src/otools/i18n.js');
}

/** 模拟宿主注入：宿主在 webview 创建时就会做这几件事。 */
function pushHostLocale(locale) {
  document.documentElement.setAttribute('lang', locale);
  window.__OTOOLS_LOCALE__ = { locale };
  const detail = { locale };
  window.dispatchEvent(new CustomEvent('otools-locale-changed', { detail }));
  document.dispatchEvent(new CustomEvent('otools-locale-changed', { detail }));
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.__OTOOLS_LOCALE__;
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  delete document.documentElement.dataset.vsLocale;
});

afterEach(() => {
  window.localStorage.clear();
  delete window.__OTOOLS_LOCALE__;
});

describe('locale normalization', () => {
  it('maps a language family onto the catalog we ship', async () => {
    const { normalizeLocale } = await freshI18n();
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-CN');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh_Hans_CN')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en-US');
    expect(normalizeLocale('en')).toBe('en-US');
  });

  it('returns nothing for a language we have no catalog for', async () => {
    const { normalizeLocale } = await freshI18n();
    // 宿主支持 8 种语言，我们目前只有中文一份译文；其余一律回退英文原文。
    for (const locale of ['ja-JP', 'ko-KR', 'de-DE', 'ru-RU', 'es-ES', 'ar-SA']) {
      expect(normalizeLocale(locale)).toBe('');
    }
  });
});

describe('translating', () => {
  it('translates a known string and leaves unknown ones alone', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('Cancel')).toBe('取消');
    expect(t('Zoom in')).toBe('放大');
    // 没收录的原文原样返回——界面露英文，不露 key
    expect(t('Some string nobody translated')).toBe('Some string nobody translated');
  });

  it('fills placeholders', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('{name} is in the Trash. Restore it to open it.', { name: '假期' })).toBe('假期 在回收站里，需要先还原才能打开。');
  });

  it('has a report of what is and is not translated', async () => {
    const { has, catalogSize, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(has('Cancel')).toBe(true);
    expect(has('Some string nobody translated')).toBe(false);
    expect(catalogSize()).toBeGreaterThan(1000);
  });
});

describe('following the host', () => {
  it('reads the locale the host injects at webview creation', async () => {
    const i18n = await freshI18n();
    pushHostLocale('zh-CN');
    i18n.installI18n();
    expect(i18n.locale()).toBe('zh-CN');
    expect(i18n.t('Cancel')).toBe('取消');
  });

  it('falls back to the browser language when the host says nothing', async () => {
    const i18n = await freshI18n();
    i18n.installI18n();
    // jsdom 的 navigator.language 是 en-US，也就是我们的原文语言
    expect(i18n.locale()).toBe('en-US');
    expect(i18n.t('Cancel')).toBe('Cancel');
  });

  it('switches live when the host changes language, without a reload', async () => {
    const i18n = await freshI18n();
    pushHostLocale('en-US');
    i18n.installI18n();
    expect(i18n.t('Cancel')).toBe('Cancel');

    // 宿主里改成中文：只推一次事件
    pushHostLocale('zh-CN');
    expect(i18n.locale()).toBe('zh-CN');
    expect(i18n.t('Cancel')).toBe('取消');

    // 再切回去
    pushHostLocale('en-US');
    expect(i18n.locale()).toBe('en-US');
    expect(i18n.t('Cancel')).toBe('Cancel');
  });

  it('notices a host that only rewrites the lang attribute', async () => {
    const i18n = await freshI18n();
    pushHostLocale('en-US');
    i18n.installI18n();
    // 只改属性、不发事件（宿主版本差异）：MutationObserver 兜底
    document.documentElement.setAttribute('lang', 'zh-CN');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(i18n.locale()).toBe('zh-CN');
  });

  it('tells listeners when the language changes', async () => {
    const i18n = await freshI18n();
    pushHostLocale('en-US');
    i18n.installI18n();
    const seen = [];
    const off = i18n.onChange((next, previous) => seen.push([previous, next]));
    pushHostLocale('zh-CN');
    expect(seen).toEqual([['en-US', 'zh-CN']]);
    off();
    pushHostLocale('en-US');
    expect(seen).toHaveLength(1);
  });
});

describe('the user override', () => {
  it('wins over the host until it is set back to auto', async () => {
    const i18n = await freshI18n();
    pushHostLocale('zh-CN');
    i18n.installI18n();
    expect(i18n.t('Cancel')).toBe('取消');

    i18n.setPreference('en-US');
    expect(i18n.preference()).toBe('en-US');
    expect(i18n.t('Cancel')).toBe('Cancel');

    // 宿主再推一次中文也不该盖掉用户的选择
    pushHostLocale('zh-CN');
    expect(i18n.locale()).toBe('en-US');

    i18n.setPreference('auto');
    expect(i18n.locale()).toBe('zh-CN');
    expect(i18n.t('Cancel')).toBe('取消');
  });

  it('remembers the choice', async () => {
    const i18n = await freshI18n();
    i18n.setPreference('zh-CN');
    expect(window.localStorage.getItem(PREF_KEY)).toBe('zh-CN');

    const again = await freshI18n();
    again.installI18n();
    expect(again.locale()).toBe('zh-CN');
  });

  it('offers a menu of what it can actually show', async () => {
    const i18n = await freshI18n();
    i18n.setPreference('zh-CN');
    const pairs = i18n.localeOptionPairs();
    const values = pairs.map(([value]) => value);
    expect(values).toContain('auto');
    expect(values).toContain('zh-CN');
    expect(values).toContain('en-US');
    // 'auto' 的显示名跟着界面语言走，语言名本身用自己的语言写
    expect(pairs.find(([value]) => value === 'auto')[1]).toBe('跟随 OTools');
    expect(pairs.find(([value]) => value === 'zh-CN')[1]).toBe('简体中文');
    expect(pairs.find(([value]) => value === 'en-US')[1]).toBe('English');

    const items = i18n.languageMenuItems();
    expect(items).toHaveLength(pairs.length);
    expect(items.find((item) => item.label === '简体中文').checked).toBe(true);
  });
});

describe('patterns for strings the source builds with interpolation', () => {
  /* 这些文案上游用模板串拼出来，永远不可能成为词典的键，只能按形状认。 */

  it('translates relative time', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('Just now')).toBe('刚刚');
    expect(t('5 min ago')).toBe('5 分钟前');
    expect(t('2 hours ago')).toBe('2 小时前');
    expect(t('1 hour ago')).toBe('1 小时前');
  });

  it('translates the project card readout', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    // `${clock}  ·  ${relTime}`：时长是数据，时间要翻
    expect(t('0:10  ·  2 min ago')).toBe('0:10  ·  2 分钟前');
    // relTime 的兜底分支是 toLocaleDateString 的日期串，已经本地化过，整条别动
    expect(t('03:20  ·  Oct 14, 2026')).toBe('03:20  ·  Oct 14, 2026');
  });

  it('translates the Trash card readout and keeps the project name', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('Deleted 3 min ago  ·  29 days left')).toBe('已删除 3 分钟前  ·  还剩 29 天');
    // 项目名是用户数据，一个字符都不能动
    expect(t('Open Holiday cut, 0:04, edited 2 hours ago')).toBe('打开 Holiday cut（0:04，编辑于 2 小时前）');
    expect(t('More actions for Holiday cut')).toBe('Holiday cut 的更多操作');
  });

  it('keeps user data and translates the chrome around it', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('Add clip.mp4 to timeline')).toBe('把 clip.mp4 添加到时间线');
    expect(t('Back  ·  editing My compound')).toBe('返回  ·  正在编辑 My compound');
    expect(t('Restore Old cut')).toBe('还原 Old cut');
    expect(t('Delete Old cut forever')).toBe('永久删除 Old cut');
  });

  it('translates a control name only when the name itself is known', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    // 'Reset color' 是词典里的完整词条，走精确匹配
    expect(t('Reset color')).toBe('重置颜色');
    // 模式里的捕获组要是词典里没有的控件名，整条放弃——宁可露英文，
    // 也不拼出「重置 Reset all」这种半截中文
    expect(t('Reset some widget we never translated')).toBe('Reset some widget we never translated');
    expect(t('Add a widget we never translated')).toBe('Add a widget we never translated');
  });

  it('splits composite readouts and only commits when every part translates', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    expect(t('2 projects  ·  1 in Trash')).toBe('2 个项目  ·  回收站 1 个');
    expect(t('Social  ·  00:08')).toBe('社交  ·  00:08');
    // 有一段翻不出来就整条放弃：这条看起来像用户自己用 · 拼的名字
    expect(t('Holiday  ·  beach  ·  sky')).toBe('Holiday  ·  beach  ·  sky');
  });

  it('prefers an exact dictionary entry over a pattern', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('zh-CN');
    // 'Add to timeline' 是完整词条；`^Add (.+) to timeline$` 这条模式不该抢在前面
    expect(t('Add to timeline')).toBe('添加到时间线');
    expect(t('Delete clip')).toBe('删除片段');
  });

  it('returns the source language when nothing applies', async () => {
    const { t, setPreference } = await freshI18n();
    setPreference('en-US');
    expect(t('5 min ago')).toBe('5 min ago');
    expect(t('2 projects  ·  1 in Trash')).toBe('2 projects  ·  1 in Trash');
  });

  it('reports how many patterns there are', async () => {
    const { setPreference, patternSize } = await freshI18n();
    setPreference('zh-CN');
    expect(patternSize()).toBeGreaterThan(40);
  });
});

describe('what it writes on the document', () => {
  it('keeps lang in step with what is actually shown', async () => {
    const i18n = await freshI18n();
    pushHostLocale('zh-CN');
    i18n.installI18n();
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.dataset.vsLocale).toBe('zh-CN');

    // 宿主是日语、而我们只有英文：页面实际显示英文，lang 就该是 en-US，
    // 否则字体与断行会按日文来
    pushHostLocale('ja-JP');
    expect(i18n.locale()).toBe('en-US');
    expect(document.documentElement.getAttribute('lang')).toBe('en-US');
  });

  it('does not fight the host over the lang attribute', async () => {
    const i18n = await freshI18n();
    pushHostLocale('zh-CN');
    i18n.installI18n();
    // 我们写完之后再观察几轮，不该出现反复改写（来回打架会无限触发观察器）
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(i18n.locale()).toBe('zh-CN');
  });
});

/**
 * DOM 翻译层的测试。
 *
 * 这一层是「不改上游」与「界面要能变中文」之间唯一的桥，所以它的**边界**
 * 比它的功能更重要：只精确匹配、不碰用户内容、切语言可逆。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** 装上一份全新的 i18n + DOM 翻译层，宿主语言用 locale。 */
async function setup(locale = 'zh-CN') {
  vi.resetModules();
  document.documentElement.setAttribute('lang', locale);
  window.__OTOOLS_LOCALE__ = { locale };
  const i18n = await import('../src/otools/i18n.js');
  const dom = await import('../src/otools/dom-i18n.js');
  i18n.installI18n();
  document.body.replaceChildren();
  dom.installDomTranslation();
  return { i18n, dom };
}

/** 等 DOM 翻译层的按帧批处理跑完。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.__OTOOLS_LOCALE__;
  document.body.replaceChildren();
});

afterEach(async () => {
  const dom = await import('../src/otools/dom-i18n.js');
  dom.disposeDomTranslation();
  document.body.replaceChildren();
  window.localStorage.clear();
  delete window.__OTOOLS_LOCALE__;
  document.documentElement.removeAttribute('lang');
});

describe('text and attributes', () => {
  it('translates text nodes', async () => {
    await setup();
    document.body.innerHTML = '<button>Cancel</button><span>Zoom in</span>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('button').textContent).toBe('取消');
    expect(document.body.querySelector('span').textContent).toBe('放大');
  });

  it('translates the attributes people actually see', async () => {
    await setup();
    document.body.innerHTML = '<button title="Zoom in" aria-label="Zoom out" data-tip="Add marker" alt="Photo frame" placeholder="Search projects">x</button>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    const el = document.body.querySelector('button');
    expect(el.getAttribute('title')).toBe('放大');
    expect(el.getAttribute('aria-label')).toBe('缩小');
    expect(el.getAttribute('data-tip')).toBe('添加标记');
    expect(el.getAttribute('alt')).toBe('照片相框');
    expect(el.getAttribute('placeholder')).toBe('搜索项目');
  });

  it('keeps the surrounding whitespace of a text node', async () => {
    await setup();
    document.body.innerHTML = '<p>  Cancel  </p>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('p').textContent).toBe('  取消  ');
  });

  it('translates newly rendered nodes on its own', async () => {
    await setup();
    const panel = document.createElement('div');
    document.body.append(panel);
    await flush();

    panel.innerHTML = '<button>Cancel</button>';
    await flush();
    expect(panel.querySelector('button').textContent).toBe('取消');
  });
});

describe('what it refuses to touch', () => {
  it('only replaces an exact match', async () => {
    await setup();
    document.body.innerHTML = '<p>Cancel now</p><p>Please Cancel the export</p><p>Canceled.</p>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    const [a, b, c] = document.body.querySelectorAll('p');
    // 动态拼接的文案不匹配，保持原样
    expect(a.textContent).toBe('Cancel now');
    expect(b.textContent).toBe('Please Cancel the export');
    // 整句收录过的才会换
    expect(c.textContent).toBe('已取消。');
  });

  it('leaves user content alone', async () => {
    await setup();
    document.body.innerHTML = [
      '<div class="clip-name">Cancel</div>',
      '<div class="asset-name">Delete</div>',
      '<div class="project-name">Zoom in</div>',
      '<div class="cap-text">Save</div>',
      '<div class="tl-clip"><span>Cancel</span></div>',
      '<div contenteditable="true">Cancel</div>',
      '<div data-i18n-skip>Cancel</div>',
    ].join('');
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('.clip-name').textContent).toBe('Cancel');
    expect(document.body.querySelector('.asset-name').textContent).toBe('Delete');
    expect(document.body.querySelector('.project-name').textContent).toBe('Zoom in');
    expect(document.body.querySelector('.cap-text').textContent).toBe('Save');
    expect(document.body.querySelector('.tl-clip span').textContent).toBe('Cancel');
    expect(document.body.querySelector('[contenteditable]').textContent).toBe('Cancel');
    expect(document.body.querySelector('[data-i18n-skip]').textContent).toBe('Cancel');
  });

  it('skips tags whose text is not interface copy', async () => {
    await setup();
    document.body.innerHTML = '<canvas>Cancel</canvas><svg><text>Cancel</text></svg>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('canvas').textContent).toBe('Cancel');
    expect(document.body.querySelector('svg').textContent).toBe('Cancel');
  });

  it('can be switched off', async () => {
    const dom = await import('../src/otools/dom-i18n.js');
    dom.setEnabled(false);
    document.body.innerHTML = '<button>Cancel</button>';
    await flush();
    expect(document.body.querySelector('button').textContent).toBe('Cancel');
    dom.setEnabled(true);
  });
});

describe('switching language', () => {
  it('re-translates from the original, not on top of the translation', async () => {
    const { i18n } = await setup('zh-CN');
    document.body.innerHTML = '<button>Cancel</button><span>Zoom in</span>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('button').textContent).toBe('取消');

    // 切回英文：从记下的原文还原
    i18n.setPreference('en-US');
    expect(document.body.querySelector('button').textContent).toBe('Cancel');
    expect(document.body.querySelector('span').textContent).toBe('Zoom in');

    // 再切回中文：不是「中文套中文」
    i18n.setPreference('zh-CN');
    expect(document.body.querySelector('button').textContent).toBe('取消');
    expect(document.body.querySelector('span').textContent).toBe('放大');
  });

  it('is idempotent', async () => {
    await setup();
    document.body.innerHTML = '<button>Cancel</button>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    dom.translateAll();
    dom.translateAll();
    expect(document.body.querySelector('button').textContent).toBe('取消');
  });
});

describe('reporting', () => {
  it('collects the strings it could not translate', async () => {
    await setup();
    document.body.innerHTML = '<button>Cancel</button><button>Nudge the widget sideways</button>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(dom.missingStrings()).toContain('Nudge the widget sideways');
    expect(dom.missingStrings()).not.toContain('Cancel');
  });

  it('counts what it rewrote', async () => {
    await setup();
    document.body.innerHTML = '<button>Cancel</button><span>Zoom in</span>';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    const stats = dom.domStats();
    expect(stats.locale).toBe('zh-CN');
    expect(stats.nodes).toBeGreaterThanOrEqual(2);
  });
});

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
      '<div class="media-row-name">Delete</div>',
      '<div class="project-name">Zoom in</div>',
      '<div class="project-title">Zoom in</div>',
      '<div class="cap-text">Save</div>',
      '<div class="tp-text">Save</div>',
      '<div contenteditable="true">Cancel</div>',
      '<div data-i18n-skip>Cancel</div>',
    ].join('');
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('.clip-name').textContent).toBe('Cancel');
    expect(document.body.querySelector('.media-row-name').textContent).toBe('Delete');
    expect(document.body.querySelector('.project-name').textContent).toBe('Zoom in');
    expect(document.body.querySelector('.project-title').textContent).toBe('Zoom in');
    expect(document.body.querySelector('.cap-text').textContent).toBe('Save');
    expect(document.body.querySelector('.tp-text').textContent).toBe('Save');
    expect(document.body.querySelector('[contenteditable]').textContent).toBe('Cancel');
    expect(document.body.querySelector('[data-i18n-skip]').textContent).toBe('Cancel');
  });

  /*
   * 这里修的是一个真 bug。
   *
   * SKIP_SELECTORS 早先写着 `.project-card`、`.tpl-card`、`.tl-clip`、
   * `.nest-label`、`.asset-group-title` 这些**容器**选择器，整棵子树都跳过。
   * 于是项目卡片里的「移入回收站」按钮、模板卡片的分类行、时间线片段的
   * 悬停提示一起都不翻了——界面上长期留着英文，而覆盖率报告显示 95%。
   *
   * 现在跳过只针对**叶子**级的用户内容；容器一律不跳过。
   */
  it('does not skip whole containers, so the chrome inside them still translates', async () => {
    await setup();
    document.body.innerHTML = [
      '<div class="project-card"><button class="trash-action">Move to Trash</button></div>',
      '<div class="tpl-card"><span class="tpl-sub">Social  ·  00:08</span></div>',
      '<div class="tl-clip"><span class="clip-badge" title="Grouped"> </span><span class="clip-name">Cancel</span></div>',
      '<div class="nest-label">Back  ·  editing Scene 1</div>',
    ].join('');
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('.trash-action').textContent).toBe('移入回收站');
    expect(document.body.querySelector('.tpl-sub').textContent).toBe('社交  ·  00:08');
    // 标题属性跟着翻，但片段名字是用户的，一个字不动
    expect(document.body.querySelector('.clip-badge').getAttribute('title')).toBe('已编组');
    expect(document.body.querySelector('.clip-name').textContent).toBe('Cancel');
    expect(document.body.querySelector('.nest-label').textContent).toBe('返回  ·  正在编辑 Scene 1');
  });

  /*
   * 我们目录里的名字（特效、转场、滤镜、音效、模板分类、属性名）**不是**
   * 用户内容——它们本来就是词典里的条目。跳过它们等于界面上永远留着英文：
   * 素材面板的分区标题、检查器里的已应用滤镜、虚拟主播面板的四个分区，
   * 全都是英文。这个用例把这件事钉住。
   */
  it('translates our own catalog labels, which are not user content', async () => {
    await setup();
    document.body.innerHTML = [
      '<h3 class="asset-group-title">Retro</h3>',
      '<span class="applied-filter-name">Vintage</span>',
      '<span class="tr-name">Dissolve</span>',
      '<span class="clipfx-name">Glitch</span>',
      '<span class="look-name">Soft glow</span>',
      '<span class="sfx-name">Applause</span>',
      '<span class="kf-name">Position</span>',
      '<span class="tpl-name">Title intro</span>',
    ].join('');
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.body.querySelector('.asset-group-title').textContent).toBe('复古');
    expect(document.body.querySelector('.applied-filter-name').textContent).toBe('复古');
    expect(document.body.querySelector('.tr-name').textContent).toBe('叠化');
    expect(document.body.querySelector('.clipfx-name').textContent).toBe('故障');
    expect(document.body.querySelector('.look-name').textContent).toBe('柔光');
    expect(document.body.querySelector('.sfx-name').textContent).toBe('掌声');
    expect(document.body.querySelector('.kf-name').textContent).toBe('位置');
    expect(document.body.querySelector('.tpl-name').textContent).toBe('标题开场');
  });

  it('translates the document title, which upstream assigns directly', async () => {
    await setup();
    document.title = 'My cut - Video Studio editor';
    const dom = await import('../src/otools/dom-i18n.js');
    dom.translateAll();
    expect(document.title).toBe('My cut - 视频工作室编辑器');
    // 上游再改一次标题：跟着新的原文重翻，不会把上一次的译文记成原文
    document.title = 'Other cut - Video Studio editor';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe('Other cut - 视频工作室编辑器');
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

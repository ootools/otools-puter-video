/**
 * 移植层：菜单定位（`shell/src/otools/menu-position.js`）。
 *
 * 上游 `tests/menu.test.js` 只覆盖「子菜单在右侧放得下」和「放不下就翻到左边」，
 * 翻到左边之后会不会压住父菜单、菜单比窗口高时会不会盖住标题栏，都没有断言。
 * 这里补上这两类边界——它们正是 OTools 窗口（比浏览器小得多）里最先撞到的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { positionMenu } from '../src/otools/menu-position.js';

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

/** 造一个量出来是 width × height 的菜单（jsdom 不做布局）。 */
function makeMenu(width, height) {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.getBoundingClientRect = () => ({ left: 0, right: width, top: 0, bottom: height, width, height, x: 0, y: 0 });
  document.body.append(menu);
  return menu;
}

/** 菜单项 / 按钮的矩形。 */
function rect(left, top, width, height) {
  return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top };
}

function viewport(width, height) {
  window.innerWidth = width;
  window.innerHeight = height;
}

const px = (value) => parseFloat(value);

beforeEach(() => {
  viewport(1024, 768);
});

afterEach(() => {
  viewport(originalWidth, originalHeight);
  document.body.innerHTML = '';
});

describe('submenu placement', () => {
  it('sits beside the parent item when there is room on the right', () => {
    const menu = makeMenu(240, 200);
    positionMenu(menu, rect(130, 100, 244, 30), { side: 'right' });
    expect(px(menu.style.left)).toBe(376);
    expect(px(menu.style.top)).toBe(96);
  });

  it('flips to the left of the parent menu, not on top of it', () => {
    viewport(860, 700);
    // Parent menu occupies 300..600; the parent item is inset by the menu padding.
    const menu = makeMenu(280, 240);
    positionMenu(menu, rect(304, 120, 292, 30), { side: 'right' });
    const right = px(menu.style.left) + 280;
    expect(right).toBeLessThan(300);
  });

  it('never covers the parent menu when neither side has room', () => {
    viewport(420, 700);
    // Parent menu hugs the left edge: 8..252.
    const menu = makeMenu(240, 200);
    positionMenu(menu, rect(12, 120, 240, 30), { side: 'right' });
    const left = px(menu.style.left);
    const width = px(menu.style.maxWidth) || 240;
    // Either fully to the right of the parent, or squeezed without touching it.
    expect(left).toBeGreaterThanOrEqual(252);
    expect(left + width).toBeLessThanOrEqual(420 - 8);
    expect(px(menu.style.minWidth)).toBe(0);
  });

  it('stays inside the viewport when the submenu is taller than the space below', () => {
    viewport(1000, 320);
    const menu = makeMenu(240, 200);
    positionMenu(menu, rect(130, 260, 244, 30), { side: 'right' });
    expect(px(menu.style.top)).toBe(320 - 8 - 200);
  });
});

describe('tall menus stay clear of their anchor', () => {
  it('shrinks and scrolls instead of covering the title bar', () => {
    viewport(900, 560);
    // The app-menu button lives in the title bar: y 7..37.
    const anchor = rect(8, 7, 100, 30);
    const menu = makeMenu(240, 526);
    positionMenu(menu, anchor, { label: 'Main menu' });

    // Top edge stays below the button — the menu no longer starts at y = 8.
    expect(px(menu.style.top)).toBe(anchor.bottom + 4);
    // Height is capped to the room below, so the menu scrolls inside itself.
    expect(menu.style.maxHeight).toBe(`${560 - 8 - (anchor.bottom + 4)}px`);
    expect(px(menu.style.top) + px(menu.style.maxHeight)).toBe(560 - 8);
  });

  it('flips above the anchor when the menu fits there', () => {
    viewport(900, 400);
    const anchor = rect(400, 300, 120, 30);
    const menu = makeMenu(240, 200);
    positionMenu(menu, anchor, {});
    // 300 - 4 - 200 = 96, and the bottom edge (296) stays above the anchor.
    expect(px(menu.style.top)).toBe(96);
    expect(px(menu.style.top) + 200).toBeLessThanOrEqual(anchor.top - 4);
    expect(menu.style.maxHeight).toBe('');
  });

  it('keeps a short menu below its anchor', () => {
    viewport(900, 560);
    const anchor = rect(8, 7, 100, 30);
    const menu = makeMenu(240, 120);
    positionMenu(menu, anchor, {});
    expect(px(menu.style.top)).toBe(41);
    expect(menu.style.maxHeight).toBe('');
  });
});

describe('horizontal overflow', () => {
  it('pulls an end-aligned menu inside the right edge', () => {
    viewport(600, 700);
    const menu = makeMenu(240, 160);
    positionMenu(menu, rect(560, 100, 32, 30), { align: 'end' });
    expect(px(menu.style.left) + 240).toBeLessThanOrEqual(600 - 8);
  });

  it('narrows a menu that is wider than the viewport', () => {
    viewport(220, 700);
    const menu = makeMenu(320, 160);
    positionMenu(menu, rect(10, 100, 60, 30), {});
    expect(px(menu.style.maxWidth)).toBe(220 - 16);
    expect(px(menu.style.minWidth)).toBe(0);
  });
});

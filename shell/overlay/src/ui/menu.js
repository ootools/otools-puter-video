/**
 * Accessible popup menus (menu button pattern) and context menus.
 *
 * items: [{ label, icon?, shortcut?, onSelect, disabled?, checked?, danger?, submenu? } | 'separator' | { heading }]
 *
 * OTools 移植层覆盖版（`shell/overlay/src/ui/menu.js`）：与上游同文件相比只差
 * 一件事——定位从本地 `position()` 换成了 `../otools/menu-position.js` 的
 * `positionMenu()`。上游那版在「菜单比窗口高」和「子菜单两侧都放不下」时会把
 * 菜单夹到视口边缘，结果盖住标题栏 / 父菜单（见 menu-position.js 的注释）。
 * 其余逻辑（键盘、焦点、关闭链）与上游保持一致，上游更新时按整文件同步即可。
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { shortcutLabel } from '../lib/platform.js';
import { positionMenu } from '../otools/menu-position.js';

let openMenu = null;

export function closeMenus() {
  if (openMenu) openMenu.close();
}

/**
 * Show a menu. anchor is an element (menu button), a rect or a {x, y} point.
 * Returns a handle with close().
 */
export function showMenu(anchor, items, opts = {}) {
  if (openMenu && !opts.nested) openMenu.close();
  const menu = h('div.menu', { role: 'menu', tabindex: '-1', 'aria-label': opts.label || null });
  const entries = [];
  let child = null;
  // Where focus goes back to on close: the menu button, the item that opened a submenu, or
  // for a context menu at a point (right click, Shift+F10) whatever had focus when it opened.
  const byElement = anchor instanceof Element || Boolean(opts.opener);
  const returnTo = anchor instanceof Element ? anchor : opts.opener || (document.activeElement !== document.body ? document.activeElement : null);
  // An element, a rect ({left, right, top, bottom}, e.g. a DOMRect) or a {x, y} point.
  // 子菜单拿到的是打开瞬间的 rect 快照，父菜单一收缩它就过期了；有 opener 元素时
  // 一律现取，重定位才能跟上父菜单的新宽度。
  const resolveAnchor = () => {
    if (opts.opener instanceof Element) return opts.opener.getBoundingClientRect();
    if (anchor instanceof Element) return anchor.getBoundingClientRect();
    return 'right' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  };
  let resizeObserver = null;
  const handle = {
    el: menu,
    // 菜单文案是运行时翻译的（DOM 翻译层在菜单挂上之后才改文本），宽度会跟着变；
    // 宽度一变，子菜单的锚点也就变了。RO 回调里重新摆一遍，避免子菜单错位。
    reposition() {
      positionMenu(menu, resolveAnchor(), opts);
      child?.reposition?.();
    },
    close(returnFocus = true) {
      child?.close(false);
      resizeObserver?.disconnect();
      const hadFocus = menu.contains(document.activeElement);
      menu.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'false');
      if (openMenu === handle) openMenu = null;
      // A context menu only takes focus back if it still had it (focus may have moved on).
      const lost = hadFocus || !document.activeElement || document.activeElement === document.body;
      if (returnFocus && returnTo && document.contains(returnTo) && (byElement || lost)) returnTo.focus({ preventScroll: true });
      opts.onClose?.();
    },
  };
  for (const it of items) {
    if (!it) continue;
    if (it === 'separator') {
      menu.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (it.heading) {
      menu.append(h('div.menu-heading', { role: 'presentation' }, it.heading));
      continue;
    }
    const role = it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox';
    const btn = h(
      `button.menu-item${it.danger ? '.danger' : ''}`,
      {
        type: 'button',
        role,
        tabindex: '-1',
        disabled: it.disabled,
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-checked': it.checked === undefined ? null : String(Boolean(it.checked)),
        'aria-haspopup': it.submenu ? 'menu' : null,
        'aria-expanded': it.submenu ? 'false' : null,
      },
      h('span.menu-check', it.checked ? icon('check', 14) : null),
      it.swatch ? h('span.menu-swatch', { style: { background: it.swatch } }) : it.icon ? icon(it.icon, 16) : null,
      h('span.menu-label', it.label),
      it.shortcut ? h('span.menu-shortcut', shortcutLabel(it.shortcut)) : it.hint ? h('span.menu-shortcut', it.hint) : null,
      it.submenu ? icon('chevronRight', 14, 'menu-sub-arrow') : null,
    );
    const openSub = () => {
      child?.close(false);
      const rect = btn.getBoundingClientRect();
      child = showMenu(rect, typeof it.submenu === 'function' ? it.submenu() : it.submenu, { nested: true, side: 'right', label: it.label, opener: btn, onClose: () => btn.setAttribute('aria-expanded', 'false'), parent: handle });
      btn.setAttribute('aria-expanded', 'true');
      return child;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) {
        openSub().focusFirst();
        return;
      }
      let root = handle;
      while (root.parent) root = root.parent;
      root.close(it.keepFocus !== false && !opts.noReturnFocus);
      it.onSelect?.();
    });
    btn.addEventListener('pointerenter', () => {
      btn.focus({ preventScroll: true });
      if (it.submenu && !it.disabled) openSub();
      else if (child) {
        child.close(false);
        child = null;
      }
    });
    entries.push({ btn, it, openSub });
    menu.append(btn);
  }
  handle.parent = opts.parent || null;
  const focusables = () => entries.filter((e) => !e.it.disabled).map((e) => e.btn);
  handle.focusFirst = () => focusables()[0]?.focus({ preventScroll: true });
  menu.addEventListener('keydown', (e) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close(true);
    } else if (e.key === 'ArrowRight') {
      const entry = entries.find((x) => x.btn === document.activeElement);
      if (entry?.it.submenu) {
        e.preventDefault();
        entry.openSub().focusFirst();
      }
    } else if (e.key === 'ArrowLeft' && handle.parent) {
      e.preventDefault();
      handle.close(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      let root = handle;
      while (root.parent) root = root.parent;
      root.close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const start = i + 1;
      for (let k = 0; k < list.length; k++) {
        const b = list[(start + k) % list.length];
        if (b.textContent.trim().toLowerCase().startsWith(ch)) {
          b.focus();
          break;
        }
      }
    }
  });
  document.body.append(menu);
  // An element, a rect ({left, right, top, bottom}, e.g. a DOMRect) or a {x, y} point.
  positionMenu(menu, resolveAnchor(), opts);
  if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'true');
  // 翻译层改文本 → 菜单宽度变化 → 子菜单锚点变化。ResizeObserver 只在宽度真的
  // 变了的时候重摆一次（高度变化由 positionMenu 自己引起，忽略，否则会打转）。
  let lastWidth = menu.getBoundingClientRect().width;
  let scheduled = false;
  resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!document.contains(menu)) return;
      const width = menu.getBoundingClientRect().width;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      handle.reposition();
      lastWidth = menu.getBoundingClientRect().width;
    });
  });
  resizeObserver?.observe(menu);
  const onOutside = (e) => {
    if (menu.contains(e.target) || (anchor instanceof Element && anchor.contains(e.target))) return;
    let p = handle;
    while (p.parent) p = p.parent;
    let inChain = false;
    for (let m = child; m; m = null) if (m.el.contains(e.target)) inChain = true;
    if (inChain) return;
    if (opts.nested) return;
    handle.close(false);
  };
  const onBlur = () => {
    if (!opts.nested) handle.close(false);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  });
  if (!opts.nested) openMenu = handle;
  if (opts.focus !== false) requestAnimationFrame(() => handle.focusFirst());
  return handle;
}

/** Wire a button as a menu button: click/Enter/Space/ArrowDown open the menu. */
export function menuButton(button, getItems, opts = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  let handle = null;
  const open = () => {
    if (handle && document.contains(handle.el)) {
      handle.close();
      handle = null;
      return;
    }
    handle = showMenu(button, getItems(), { ...opts, onClose: () => (handle = null) });
  };
  button.addEventListener('click', open);
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!handle) open();
    }
  });
  return button;
}

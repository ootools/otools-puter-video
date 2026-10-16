/**
 * 跟随 OTools 的界面主题。
 * ------------------------------------------------------------------
 * 宿主把主题推给每个插件 webview，注入脚本长这样
 * （见宿主 core.rs 的 build_child_webview_theme_script）：
 *
 *     documentElement.classList.toggle('dark' | 'light');
 *     documentElement.dataset.themeMode = 'dark' | 'light' | 'system';
 *     documentElement.dataset.themeAccent = 'classic' | 'violet' | ...;
 *     window.__OTOOLS_THEME__ = { themeMode, themeAccent, resolvedTheme };
 *     window / document 上派发 'otools-theme-changed'
 *
 * 和语言一样：webview 创建时注入一次，之后宿主里改主题会再推一次。
 *
 * 上游自己有主题（`video-studio:theme`，值 dark / light / system，界面里也有
 * Theme 菜单）。两者不能打架，规则是「**我们跟随，直到用户自己选**」：
 *
 *   - 我们跟随宿主时会把值写进 `video-studio:theme`，同时把写过的值记在
 *     `otools-puter-video.theme-followed`；
 *   - 下次如果 `video-studio:theme` 与记下的值不一样，说明是用户在 Theme
 *     菜单里自己选的 → 从此不再跟随；
 *   - 用户在菜单里选回跟宿主一样的值时，跟随会重新生效（无害）。
 */

import { getTheme, setTheme } from '../ui/prefs.js';

/** 上游的主题键。 */
const THEME_KEY = 'video-studio:theme';
/** 我们上次「跟随宿主」写进去的值。 */
const FOLLOWED_KEY = 'otools-puter-video.theme-followed';

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略 */
  }
}

/** 宿主当前解析出来的主题（'dark' | 'light' | ''）。 */
export function hostTheme() {
  try {
    const injected = window.__OTOOLS_THEME__;
    const resolved = injected && typeof injected.resolvedTheme === 'string' ? injected.resolvedTheme : '';
    if (resolved === 'dark' || resolved === 'light') return resolved;
  } catch {
    /* 忽略 */
  }
  const classes = document?.documentElement?.classList;
  if (!classes) return '';
  if (classes.contains('dark')) return 'dark';
  if (classes.contains('light')) return 'light';
  return '';
}

/**
 * 跟随宿主主题。幂等。
 *
 * @returns {() => void} 取消监听
 */
export function installThemeFollow() {
  const apply = () => {
    const theme = hostTheme();
    if (!theme) return;
    const stored = read(THEME_KEY);
    const followed = read(FOLLOWED_KEY);
    // 用户自己选过（当前值不是我们上次跟随写的那个）→ 不再插手
    if (stored && stored !== followed) return;
    if (stored === theme) return;
    setTheme(theme);
    write(FOLLOWED_KEY, theme);
  };

  apply();
  window.addEventListener('otools-theme-changed', apply);
  document.addEventListener('otools-theme-changed', apply);

  return () => {
    window.removeEventListener('otools-theme-changed', apply);
    document.removeEventListener('otools-theme-changed', apply);
  };
}

/**
 * 启动时（首屏渲染之前）把宿主主题落成上游的初始值。
 *
 * 由 `shell/overlay/index.html` 的内联脚本调用——那时还没法 import 模块，
 * 所以这段逻辑必须在 html 里能独立跑；这里再导出一份等价实现，给
 * 「宿主主题在首屏之后才到」的情况兜底（例如 init script 没注入成功）。
 */
export function primeThemeFromHost() {
  const theme = hostTheme();
  if (!theme) return '';
  const stored = read(THEME_KEY);
  const followed = read(FOLLOWED_KEY);
  if (stored && stored !== followed) return stored;
  if (stored !== theme) {
    write(THEME_KEY, theme);
    write(FOLLOWED_KEY, theme);
  }
  return theme;
}

export { THEME_KEY, FOLLOWED_KEY, getTheme };

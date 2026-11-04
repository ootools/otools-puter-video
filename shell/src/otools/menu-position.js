/**
 * 弹出菜单的定位（移植层覆盖上游 `src/ui/menu.js` 里的 `position()`）。
 *
 * 上游只做了「放不下就翻面，翻不过去就夹到 8px」这一档处理，两个边界都会
 * 让菜单盖住它该让开的东西：
 *
 *   1. **垂直**：菜单比窗口还高时（编辑器的「编辑」菜单四十多项、左上角「菜单」
 *      二十来项），`Math.max(8, anchorRect.top - h - 4)` 会把整块菜单夹到 y=8，
 *      于是它从窗口最顶上铺下来，把标题栏——也就是打开它的那个「菜单」按钮所在
 *      的那一条——整个盖住。看起来就是「菜单把一级菜单挡住了」。
 *   2. **水平**：子菜单在右侧放不下、翻到父项左侧后，如果父菜单贴着窗口左边
 *      （左上角的「菜单」、左侧面板里的右键菜单），`Math.max(8, x)` 会把它夹到
 *      x=8，子菜单于是整块压在父菜单上。
 *
 * 这里的规则换成「先翻面，翻不过去就收缩 + 自己滚动，任何情况下都不覆盖锚点」：
 *
 *   - 垂直（side = bottom/top）：优先放在锚点下方；下方不够且上方放得下就翻到上方；
 *     两边都放不下就留在空间大的一侧，用 max-height 收住高度让它内部滚动。
 *     菜单的上/下边缘始终留在锚点之外，不会再压住标题栏或菜单按钮。
 *   - 水平（side = right，即子菜单）：优先父项右侧；放不下翻到父项左侧；
 *     两侧都不够时贴边并把宽度收到可用空间，保证与父菜单之间仍有间隙。
 *
 * 间距常量（与锚点 4px、子菜单向右 2px）和上游一致，所以上游
 * `tests/menu.test.js` 里断言的 376 / 96 / 8px 依旧成立。
 */

/** 与视口边缘的最小距离。 */
const EDGE = 8;
/** 菜单与锚点之间的间隙。 */
const GAP = 4;
/** 收缩时的宽度下限；再窄就只剩图标，没有意义了。 */
const MIN_WIDTH = 120;
/** 收缩时的高度下限；低于这个高度连两三项都放不下。 */
const MIN_HEIGHT = 120;

/**
 * 把已经挂到文档里的菜单摆到锚点旁边。
 *
 * @param {HTMLElement} menu        菜单根节点（.menu，position: fixed）
 * @param {{left:number,right:number,top:number,bottom:number}} anchorRect 锚点矩形
 * @param {{align?: 'start'|'end', side?: 'bottom'|'top'|'right'}} [opts]
 */
export function positionMenu(menu, anchorRect, { align = 'start', side = 'bottom' } = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 先归零再量：上一次收缩留下的 max-width / max-height 会让这次量到的尺寸失真。
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.minWidth = '';
  menu.style.maxWidth = '';
  menu.style.maxHeight = '';

  const measured = menu.getBoundingClientRect();
  let width = measured.width;
  let height = measured.height;

  // ---------------------------------------------------------------- 水平
  let x = align === 'end' ? anchorRect.right - width : anchorRect.left;
  if (side === 'right') x = anchorRect.right + 2;

  if (x + width > vw - EDGE) {
    if (side === 'right') {
      // 父菜单有 4px 内边距，子菜单要让开它，否则会压在父菜单的边框上。
      const flipped = anchorRect.left - GAP - width - 2;
      const roomLeft = anchorRect.left - GAP - EDGE;
      const roomRight = vw - EDGE - (anchorRect.right + 2);
      if (flipped >= EDGE) {
        x = flipped;
      } else if (roomLeft >= roomRight) {
        // 两侧都放不下：贴左边距，把宽度收到可用空间——宁可窄，也不盖住父菜单。
        width = Math.min(width, Math.max(MIN_WIDTH, roomLeft));
        menu.style.minWidth = '0';
        menu.style.maxWidth = `${width}px`;
        x = EDGE;
      } else {
        width = Math.min(width, Math.max(MIN_WIDTH, roomRight));
        menu.style.minWidth = '0';
        menu.style.maxWidth = `${width}px`;
        x = anchorRect.right + 2;
      }
    } else {
      x = vw - width - EDGE;
    }
  }

  // 菜单比视口还宽（align: 'end' 的窄窗口）：收窄到能放下的宽度。
  if (width > vw - 2 * EDGE) {
    width = vw - 2 * EDGE;
    menu.style.minWidth = '0';
    menu.style.maxWidth = `${width}px`;
    x = Math.min(x, vw - width - EDGE);
  }

  // ---------------------------------------------------------------- 垂直
  let y;
  if (side === 'top') y = anchorRect.top - height - GAP;
  else if (side === 'right') y = anchorRect.top - GAP;
  else y = anchorRect.bottom + GAP;

  if (y + height > vh - EDGE) {
    if (side === 'right') {
      // 子菜单跟着父项走，压到底边即可；水平方向已经和父菜单分开了。
      y = vh - EDGE - height;
    } else {
      const below = Math.max(0, vh - EDGE - (anchorRect.bottom + GAP));
      const above = Math.max(0, anchorRect.top - GAP - EDGE);
      if (side === 'bottom' && above >= height) {
        y = anchorRect.top - GAP - height;
      } else if (side === 'top' && below >= height) {
        y = anchorRect.bottom + GAP;
      } else if (above > below) {
        height = Math.min(height, Math.max(MIN_HEIGHT, above));
        menu.style.maxHeight = `${height}px`;
        y = anchorRect.top - GAP - height;
      } else {
        height = Math.min(height, Math.max(MIN_HEIGHT, below));
        menu.style.maxHeight = `${height}px`;
        y = anchorRect.bottom + GAP;
      }
    }
  }

  menu.style.left = `${Math.max(EDGE, x)}px`;
  menu.style.top = `${Math.max(EDGE, y)}px`;
  menu.style.visibility = '';
}

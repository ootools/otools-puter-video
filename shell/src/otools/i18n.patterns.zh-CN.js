/**
 * 简体中文的**模式表**：给带插值的文案用的。
 * ------------------------------------------------------------------
 * 上游有一部分界面文案是模板串拼出来的，永远不可能成为词典的键：
 *
 *     `Open ${p.name}, ${clock(p.duration)}, edited ${relTime(p.modified)}`
 *     `${clock(p.duration)}  ·  ${relTime(p.modified)}`
 *     `Add ${item.label} to timeline`
 *     `Back  ·  editing ${store.compoundName}`
 *
 * 这些只能按形状认。`t()` 的顺序是「精确词条 → 模式 → 原文」，所以：
 *
 *   - 模式一律**锚定**（`^…$`）。不锚定就会去改用户的素材名。
 *   - 模式**不带 `g`**，避免 lastIndex 在调用之间残留。
 *   - 替换函数返回**空串**表示「这条不适用」，`t()` 会继续往下试。
 *     这是防呆：宁可保持英文，也不要拼出半截中文。
 *
 * 两类捕获组，处理方式不同：
 *
 *   - **用户数据**（项目名、文件名、片段名）→ 原样保留，别翻。
 *   - **界面文案**（控件名、分类名）→ 递归再翻一次；翻不出来就整条放弃，
 *     否则会拼出「重置 Reset all」这种半成品。用 `label()` 包一下就有这个守卫。
 *
 * 维护：改完跑 `node scripts/i18n-crawl.mjs` 看屏幕上还剩哪些英文。
 */

/**
 * 相对时间（上游 `ui/home.js` 的 `relTime`）。
 * 最后那个分支是 `toLocaleDateString` 的日期串，本身已经按浏览器语言本地化，
 * 这里返回 null 表示「不处理」。
 */
function relTime(value) {
  if (value === 'Just now') return '刚刚';
  let m = /^(\d+) min ago$/.exec(value);
  if (m) return `${m[1]} 分钟前`;
  m = /^(\d+) hours? ago$/.exec(value);
  if (m) return `${m[1]} 小时前`;
  return null;
}

/**
 * 「动词 + 控件名」型：捕获组是界面文案，要递归再翻。
 * 内层翻不出来（说明它本身不是词典里的词）就返回空串放弃，
 * 让这条文案保持英文并出现在缺口报告里——比半截中文好排查。
 *
 * @param {(inner: string, match: RegExpExecArray) => string} build
 */
const label = (build) => (match, t) => {
  const inner = t(match[1]);
  return inner === match[1] ? '' : build(inner, match);
};

export const patterns = [
  /* ══════════════════════════════ 相对时间 ══════════════════════════════ */

  [/^(\d+) min ago$/, '$1 分钟前'],
  [/^(\d+) hours? ago$/, '$1 小时前'],

  /* ═══════════════════════════ 首页：项目卡片 ═══════════════════════════ */
  // 副标题：`${clock}  ·  ${relTime}`；是日期串时 relTime 返回 null，整条放弃
  [
    /^(\d+:\d+(?::\d+)?)  ·  (.+)$/,
    (m) => {
      const rel = relTime(m[2]);
      return rel ? `${m[1]}  ·  ${rel}` : '';
    },
  ],
  // 回收站卡片副标题：`Deleted ${relTime}  ·  ${left} day(s) left`
  [
    /^Deleted (.+)  ·  (\d+) days? left$/,
    (m) => `已删除 ${relTime(m[1]) || m[1]}  ·  还剩 ${m[2]} 天`,
  ],
  // 卡片上那行「打开」的无障碍标签：项目名是用户数据，原样保留
  [
    /^Open (.+), (\d+:\d+(?::\d+)?), edited (.+)$/,
    (m) => `打开 ${m[1]}（${m[2]}，编辑于 ${relTime(m[3]) || m[3]}）`,
  ],
  [/^More actions for (.+)$/, (m) => `${m[1]} 的更多操作`],
  [/^Restore (.+)$/, (m) => `还原 ${m[1]}`],
  [/^Delete (.+) forever$/, (m) => `永久删除 ${m[1]}`],
  [/^(\d+) projects? removed from the Trash after (\d+) days$/, (m) => `已从回收站清除 ${m[1]} 个项目（超过 ${m[2]} 天）`],
  // 回收站说明句：天数来自 `TRASH_DAYS` 常量
  [
    /^Projects in the Trash are deleted for good after (\d+) days\. Media files stay in your storage\.$/,
    (m) => `回收站里的项目会在 ${m[1]} 天后被永久删除。素材文件会留在你的存储里。`,
  ],
  // 存储用量读数：上游是把几段用 `  ·  ` 拼起来的
  [/^(\d+) projects?$/, (m) => `${m[1]} 个项目`],
  [/^(.+) of media$/, (m) => `${m[1]} 素材`],
  [/^(.+) used$/, (m) => `已用 ${m[1]}`],
  [/^(\d+) in Trash$/, (m) => `回收站 ${m[1]} 个`],

  /* ══════════════════════════ 首页：模板卡片 ══════════════════════════ */
  // `${分类}  ·  ${时长}  ·  ${n} slots`
  [
    /^(.+)  ·  (\d+:\d+(?::\d+)?)  ·  (\d+) slots?$/,
    label((cat, m) => `${cat}  ·  ${m[2]}  ·  ${m[3]} 处占位`),
  ],
  // `${分类}  ·  ${时长}`（没有占位数的模板）
  [/^(.+)  ·  (\d+:\d+(?::\d+)?)$/, label((cat, m) => `${cat}  ·  ${m[2]}`)],
  [/^(\d+) placeholders? to replace with your own media$/, (m) => `${m[1]} 处占位，替换成你自己的素材`],

  /* ═══════════════════════════ 时间线 ═══════════════════════════ */
  // 复合片段返回条：`Back  ·  editing ${name}`（名字是用户数据）
  [/^Back  ·  editing (.+)$/, (m) => `返回  ·  正在编辑 ${m[1]}`],
  [/^Back to the outer timeline\. Editing (.+)$/, (m) => `返回外层时间线。正在编辑 ${m[1]}`],
  // 片段上的徽标提示：`${n} clip effect(s)`
  [/^(\d+) clip effects?$/, (m) => `${m[1]} 个片段特效`],
  // 蒙版行：`${i+1}. ${形状名}`——形状名要翻，翻不出来就整条放弃
  [/^(\d+)\. (.+)$/, label((shape, m) => `${m[1]}. ${shape}`)],
  // 撤销 / 重做的悬停提示：`Undo ${历史标签}`。
  // 历史标签本身是「Add track」这类英文（见词典里的编辑动作标签），
  // 只有它整条能翻时才拼中文，否则保持英文。
  [/^Undo (.+)$/, label((what) => `撤销${what}`)],
  [/^Redo (.+)$/, label((what) => `重做${what}`)],

  /* ═══════════════════════ 面板与检查器：控件 ═══════════════════════ */
  // 「把 X 添加到时间线」：X 是素材名（用户数据），原样保留
  [/^Add (.+) to timeline$/, (m) => `把 ${m[1]} 添加到时间线`],
  [/^Add (.+) to clip$/, label((what) => `把${what}添加到片段`)],
  [/^Add keyframe for (.+)$/, label((what) => `为${what}添加关键帧`)],
  [/^Previous (.+) keyframe$/, label((what) => `上一个${what}关键帧`)],
  [/^Next (.+) keyframe$/, label((what) => `下一个${what}关键帧`)],
  [/^Search (.+)$/, label((what) => `搜索${what}`)],
  [/^Turn on (.+)$/, label((what) => `打开${what}`)],
  [/^Turn off (.+)$/, label((what) => `关闭${what}`)],
  [/^Reset (.+)$/, label((what) => `重置${what}`)],
  [/^Apply (.+)$/, label((what) => `应用${what}`)],
  [/^Remove (.+)$/, label((what) => `移除${what}`)],
  [/^Delete (.+)$/, label((what) => `删除${what}`)],
  [/^Go to (.+)$/, label((what) => `跳到${what}`)],
  [/^Stop (.+) preview$/, label((what) => `停止${what}预览`)],
  [/^Preview (.+)$/, label((what) => `预览${what}`)],
  [/^Keyframe: (.+)$/, label((what) => `关键帧：${what}`)],
  [/^(.+) brightness$/, label((what) => `${what}亮度`)],
  [/^(.+) hex value$/, label((what) => `${what}的十六进制值`)],
  [/^(.+) applied to clip$/, label((what) => `已把${what}应用到片段`)],
  [/^(.+) added$/, label((what) => `已添加${what}`)],
  [/^(.+) removed$/, label((what) => `已移除${what}`)],
  [/^(.+) selected$/, label((what) => `已选${what}`)],
  // 这些捕获组是数据（文件/文件夹/机位/时间），不翻
  [/^Folder (.+)$/, (m) => `文件夹 ${m[1]}`],
  [/^Opened (.+)$/, (m) => `已打开 ${m[1]}`],
  [/^Marker at (.+)$/, (m) => `标记在 ${m[1]}`],
  [/^Switch to angle (\d+)$/, (m) => `切换到机位 ${m[1]}`],

  /* ══════════════════════════ 计数与上限 ══════════════════════════ */
  [/^Selected clips \((\d+)\)$/, (m) => `已选 ${m[1]} 个片段`],
  [/^Delete (\d+) items$/, (m) => `删除 ${m[1]} 项`],
  [/^(\d+) clips? selected$/, (m) => `已选 ${m[1]} 个片段`],
  [/^(\d+) clips?$/, (m) => `${m[1]} 个片段`],
  [/^A clip can have up to (\d+) effects\. Remove one to add another\.$/, (m) => `一个片段最多可以有 ${m[1]} 个特效。想再加一个，先移除一个。`],
  [/^A clip can have up to (\d+) masks?\.$/, (m) => `一个片段最多可以有 ${m[1]} 个蒙版。`],
  [/^A clip can have up to (\d+) regions?\.$/, (m) => `一个片段最多可以有 ${m[1]} 个区域。`],
  [/^A project can hold up to (\d+) timelines?\.$/, (m) => `一个项目最多可以有 ${m[1]} 条时间线。`],
  [/^(\d+) times$/, (m) => `${m[1]} 倍`],
  [/^Smooth slow motion: (.+)$/, (m) => `平滑慢动作：${m[1]}`],
  [/^(\d+) wpm$/, (m) => `${m[1]} 词/分`],

  /* ══════════════════════ 短暂提示（toast / 播报） ══════════════════════ */
  [/^Add (\d+) clips$/, (m) => `添加 ${m[1]} 个片段`],
  [/^Added (\d+) clips$/, (m) => `已添加 ${m[1]} 个片段`],
  [/^Import (\d+) files$/, (m) => `导入 ${m[1]} 个文件`],
  [/^Imported (\d+) files$/, (m) => `已导入 ${m[1]} 个文件`],
  [/^Make (\d+) clips?$/, (m) => `制作 ${m[1]} 个片段`],
  [/^(\d+) clips split$/, (m) => `已拆分 ${m[1]} 个片段`],
  [/^(\d+) clips deleted$/, (m) => `已删除 ${m[1]} 个片段`],
  [/^Copied (\d+) clips$/, (m) => `已复制 ${m[1]} 个片段`],
  [/^(\d+) transition added$/, (m) => `已添加 ${m[1]} 个转场`],
  [/^(\d+) highlights found$/, (m) => `找到 ${m[1]} 个亮点`],
  [/^Add (\d+) highlights$/, (m) => `添加 ${m[1]} 个亮点`],
  [/^(\d+) matches? in (\d+) clips?$/, (m) => `在 ${m[2]} 个片段里找到 ${m[1]} 处匹配`],
  [/^Replaced (\d+) matches?$/, (m) => `已替换 ${m[1]} 处匹配`],
  [/^Added (.+) to the timeline\.$/, (m) => `已把 ${m[1]} 添加到时间线。`],
  [/^(\d+) moments? found\. Untick any you do not want, and edit the titles if you like\.$/, (m) => `找到 ${m[1]} 个可成片的时刻。不想要的可以取消勾选，标题也能改。`],
  [/^(\d+) angles?\.$/, (m) => `${m[1]} 个机位。`],

  /* ══════════════════════════ 画面比例与帧率（项目设置） ══════════════════════════ */

  // `${r.label}  ${r.hint}`：比例是数据，提示名要翻
  [/^(\d+:\d+)  (.+)$/, (m, t) => `${m[1]}  ${t(m[2])}`],
  // `${f} fps`
  [/^(\d+) fps$/, (m) => `${m[1]} 帧/秒`],
  // 顶栏保存状态：`${label}: ${时间}`
  [/^(Auto saved|Saved in this browser): (.+)$/, (m, t) => `${t(m[1])}：${m[2]}`],

  /* ══════════════════════════ 导出对话框读数 ══════════════════════════ */

  [/^Estimated size (.+)$/, (m) => `预计大小 ${m[1]}`],
  [/^Length (.+)$/, (m) => `时长 ${m[1]}`],
  // 导出结果状态行：`Saved to /path/to/file.mp4`（路径是数据，原样保留）
  [/^Saved to (.+)$/, (m) => `已保存到 ${m[1]}`],
  // `${w} x ${h}  ${fps} fps`
  [/^(\d+) x (\d+)  (\d+) fps$/, (m) => `${m[1]} x ${m[2]}  ${m[3]} 帧/秒`],
  // `${w} x ${h}, ${比例}, ${fps} fps`
  [/^(\d+) x (\d+), (\d+:\d+), (\d+) fps$/, (m) => `${m[1]} x ${m[2]}，${m[3]}，${m[4]} 帧/秒`],
  // `${w} x ${h}, ${编码}, about X Mbps`
  [/^(\d+) x (\d+), (.+), about (.+) Mbps$/, (m, t) => `${m[1]} x ${m[2]}，${t(m[3])}，约 ${m[4]} Mbps`],
  // `${w} x ${h}, ${n} frames. GIFs are large; keep them short.`
  [/^(\d+) x (\d+), (\d+) frames\. GIFs are large; keep them short\.$/, (m) => `${m[1]} x ${m[2]}，${m[3]} 帧。GIF 文件很大，别做太长。`],
  // GIF 宽度预设：`${w} px`（GIF_WIDTHS = 240/320/480/640/800/1080）
  [/^(\d+) px$/, (m) => `${m[1]} 像素`],
  // 关键帧面板的标题：`Keyframes: ${片段名}`（名字是用户数据）
  [/^Keyframes: (.+)$/, (m) => `关键帧：${m[1]}`],
  // 时间线默认名：`Timeline 1` 这类是程序自动起的名，翻成「时间线 1」更统一；
  // 用户改名后的「My Timeline」不会被这条命中（只认 `Timeline N` 这种默认格式）
  [/^Timeline (\d+)$/, (m) => `时间线 ${m[1]}`],

  /* ══════════════════════════ 窗口标题 ══════════════════════════ */
  [/^(.+) - Video Studio editor$/, (m) => `${m[1]} - 视频工作室编辑器`],
  // 首页视图标题：`Templates - Video Studio` / `Trash - Video Studio`。
  // 视图名（Templates/Trash）要翻；产品名按界面统一叫「视频工作室」。
  [/^(.+) - Video Studio$/, (m, t) => `${t(m[1])} - 视频工作室`],

  /*
   * 最后一条：「用 `  ·  ` 拼起来的复合文案」。
   *
   * 上游有好几处是这样拼的——首页存储读数把「N 个项目」「12.3 MB 素材」
   * 「1 个回收站」用 `  ·  ` join 起来；模板卡片副标题是「分类  ·  时长  ·  占位」。
   * 逐段分开翻，比给每种组合写一条模式现实得多。
   *
   * **必须放在最后**，而且要求**每一段都翻得出来**：有一段翻不出来就整条放弃。
   * 这条守卫是为了不碰用户自己用 `·` 拼的名字——那种字符串的段落必然
   * 翻不出来，于是原样保留。宁可少翻，不要改错。
   */
  [
    /^(?=.*  ·  ).+$/,
    (match, t) => {
      const parts = match[0].split('  ·  ');
      const out = parts.map((part) => t(part));
      return out.every((part, i) => part !== parts[i]) ? out.join('  ·  ') : '';
    },
  ],
];

export default patterns;

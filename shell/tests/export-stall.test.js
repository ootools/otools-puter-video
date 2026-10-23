/**
 * 导出卡 0% 的处理（移植层自己的回归）。
 * ------------------------------------------------------------------
 * 某些 webview（macOS 上的 WKWebView 尤其常见）里，WebCodecs 对 H.264 / HEVC
 * 的 isConfigSupported() 说支持，真正开始编码却**静默挂起**：不抛错、也不回调
 * 进度，导出就永远停在 0%。处理原则是：
 *
 *   1. 默认导出格式改成 VP9 / WebM（软件编码，这些环境里跑得完）——只改默认值；
 *   2. 用户一旦自己选过就以他的选择为准：编码卡住时**不自动换格式**，而是明确
 *      报错并指出该改哪一项。悄悄把用户选好的 MP4 换成 WebM 是不能接受的。
 *
 * 这两条都不在上游的代码里，所以测试也跟着放在这里（`shell/tests/` 会被拷进
 * `.build/tests/`，和上游套件在同一个 vitest 进程里跑）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { US } from '../src/lib/time.js';
import { createProject, makeClip } from '../src/model/project.js';

// 上游的 exportProject 换成可控的假货；其余（reconcile、VIDEO_CODECS…）保持真的。
vi.mock('../src/engine/exporter.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    detectCapabilities: vi.fn(async () => ({ video: ['avc', 'vp9'], audio: ['aac', 'opus'], audioFormats: ['wav', 'm4a', 'ogg'] })),
    renderStill: vi.fn(async () => null),
    exportProject: vi.fn(),
  };
});

// 卡住时的「编码探测」是后台裸 WebCodecs 探测；换成可控假货，好验证探测结论会被
// **就地补到报错里**（真探测要真的 WebCodecs，行为本身在 codec-probe.test.js 里测）。
vi.mock('../src/otools/codec-probe.js', () => ({
  probeCodecs: vi.fn(async () => [{ codec: 'avc', label: 'H.264', supported: true, frames: 0, error: '' }]),
  summarizeProbes: vi.fn(() => 'H.264 说支持但不出帧'),
}));

const { openExportDialog } = await import('../src/ui/export-dialog.js');
const { exportProject, detectCapabilities, DEFAULT_SETTINGS } = await import('../src/engine/exporter.js');

function ctxWith(project) {
  return { store: { project, time: 0 }, library: { backend: { kind: 'opfs' } }, account: { user: null } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 一个有时长、能导出（Export 按钮可用）的工程。 */
function projectWithClip() {
  const p = createProject({ name: 'Trip' });
  p.tracks[0].clips.push(makeClip('image', { assetId: 'a', duration: 2 * US }));
  p.assets.a = { id: 'a', kind: 'image', width: 100, height: 100 };
  return p;
}

const ALL_CAPS = { video: ['avc', 'vp9'], audio: ['aac', 'opus'], audioFormats: ['wav', 'm4a', 'ogg'] };

// jsdom 没有真正的 2D 画布（没装 node-canvas），getContext('2d') 会返回 null，
// 而 start() 一开始就要把静帧画到进度画布上。给一个够用的假 context。
const fakeCtx = {
  drawImage: () => {},
  clearRect: () => {},
  fillRect: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  scale: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData: () => {},
};

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx);
  detectCapabilities.mockImplementation(async () => ALL_CAPS);
});

afterEach(() => {
  vi.useRealTimers();
  exportProject.mockReset();
  vi.restoreAllMocks();
});

describe('默认导出格式', () => {
  it('默认是 H.264 / MP4（用户要求 H.264 必须支持；不可用时由导出对话框协助安装依赖）', () => {
    expect(DEFAULT_SETTINGS.codec).toBe('avc');
    expect(DEFAULT_SETTINGS.format).toBe('mp4');
  });
});

describe('导出卡 0%', () => {
  it('编码器卡住时明确报错，并指出该改用 VP9 / WebM', async () => {
    const d = openExportDialog(ctxWith(projectWithClip()));
    await flush();

    // 手动选回 H.264 / MP4：模拟老偏好（DEFAULT_SETTINGS 只决定第一次）。
    const selects = [...d.el.querySelectorAll('select')];
    const codec = selects.find((s) => [...s.options].some((o) => o.value === 'avc'));
    codec.value = 'avc';
    codec.dispatchEvent(new Event('change'));

    const seen = [];
    exportProject.mockImplementation(async (_project, _library, settings) => {
      seen.push({ codec: settings.codec, format: settings.format });
      // 模拟 WebCodecs 静默挂起：不抛错、也不回调进度。
      return new Promise(() => {});
    });

    vi.useFakeTimers();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    btn.click();

    // 首帧前的宽限期是 20s，越过它看门狗就该动。
    await vi.advanceTimersByTimeAsync(21_000);
    expect(d.el.textContent).toContain('导出卡住');
    expect(d.el.textContent).toContain('H.264');
    expect(d.el.textContent).toContain('VP9 / WebM');
    // 诊断：按真实导出参数的探测结论就地补到报错里（多段报错结构渲染成功）。
    // 真实参数来自 currentExportParams()，mock 掉 exportProject 时为空→显示 '?×?'。
    expect(d.el.textContent).toContain('按当前导出参数探测');
    expect(d.el.textContent).toContain('H.264 说支持但不出帧');
    d.close();
  });

  it('卡住时不偷偷换格式：用户选的 MP4 还是 MP4', async () => {
    const d = openExportDialog(ctxWith(projectWithClip()));
    await flush();
    const selects = [...d.el.querySelectorAll('select')];
    const codec = selects.find((s) => [...s.options].some((o) => o.value === 'avc'));
    codec.value = 'avc';
    codec.dispatchEvent(new Event('change'));

    const seen = [];
    exportProject.mockImplementation(async (_project, _library, settings) => {
      seen.push({ codec: settings.codec, format: settings.format });
      return new Promise(() => {});
    });

    vi.useFakeTimers();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    btn.click();
    await vi.advanceTimersByTimeAsync(21_000);
    // 再等两个宽限期也只尝试过一次：不重试、不改格式。
    await vi.advanceTimersByTimeAsync(50_000);

    expect(seen).toEqual([{ codec: 'avc', format: 'mp4' }]);
    // 偏好里也仍然是用户选的那个，没有被悄悄写成 VP9 / WebM。
    const saved = JSON.parse(localStorage.getItem('video-studio:prefs') || '{}').exportSettings;
    expect(saved).toMatchObject({ codec: 'avc', format: 'mp4' });
    d.close();
  });

  it('已经是 VP9 还卡住时，不再建议换 VP9', async () => {
    const d = openExportDialog(ctxWith(projectWithClip()));
    await flush();
    // prefs 模块按文件缓存，前面的用例已经把偏好写成 H.264 了，这里显式选回 VP9。
    const selects = [...d.el.querySelectorAll('select')];
    const codec = selects.find((s) => [...s.options].some((o) => o.value === 'vp9'));
    codec.value = 'vp9';
    codec.dispatchEvent(new Event('change'));

    exportProject.mockImplementation(async () => new Promise(() => {}));
    vi.useFakeTimers();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    btn.click();
    await vi.advanceTimersByTimeAsync(21_000);

    expect(d.el.textContent).toContain('导出卡住');
    expect(d.el.textContent).not.toContain('VP9 / WebM');
    d.close();
  });
});

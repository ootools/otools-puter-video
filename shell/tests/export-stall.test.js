/**
 * 导出卡 0% 的两道防线（移植层自己的回归）。
 * ------------------------------------------------------------------
 * 某些 webview（macOS 上的 WKWebView 尤其常见）里，WebCodecs 对 H.264 / HEVC
 * 的 isConfigSupported() 说支持，真正开始编码却**静默挂起**：不抛错、也不回调
 * 进度，导出就永远停在 0%。两道防线是：
 *
 *   1. 默认导出格式改成 VP9 / WebM（软件编码，这些环境里跑得完）；
 *   2. 编码器卡住时自动改用 VP9 / WebM 重试一次——因为默认值只决定「第一次」，
 *      之后每次都从 prefs 里读，已经存过 H.264 偏好的机器必须能自愈。
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
  it('默认是 VP9 / WebM，不是 H.264 / MP4', () => {
    // H.264 / HEVC 走的是系统（硬件）编码器，在部分 webview 里会静默挂起。
    expect(DEFAULT_SETTINGS.codec).toBe('vp9');
    expect(DEFAULT_SETTINGS.format).toBe('webm');
  });
});

describe('导出卡 0%', () => {
  it('编码器卡住时自动改用 VP9 / WebM 重试一次', async () => {
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
    expect(seen).toEqual([
      { codec: 'avc', format: 'mp4' },
      { codec: 'vp9', format: 'webm' },
    ]);
    expect(d.el.textContent).toContain('已改用 VP9 / WebM 重试');

    // 重试只做一次：再等一个宽限期也不会无限循环，而是明确报错。
    await vi.advanceTimersByTimeAsync(25_000);
    expect(seen).toHaveLength(2);
    expect(d.el.textContent).toContain('导出卡住');
    d.close();
  });

  it('VP9 本身就没被支持时不重试，直接给出明确报错', async () => {
    // 浏览器只会 H.264：换成 VP9 只是从一个坑跳进另一个坑，不如直接说清楚。
    detectCapabilities.mockImplementation(async () => ({ video: ['avc'], audio: ['aac'], audioFormats: ['wav'] }));
    const d = openExportDialog(ctxWith(projectWithClip()));
    await flush();

    const seen = [];
    exportProject.mockImplementation(async (_project, _library, settings) => {
      seen.push(settings.codec);
      return new Promise(() => {});
    });

    vi.useFakeTimers();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    btn.click();
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(seen).toEqual(['avc']);
    expect(d.el.textContent).toContain('导出卡住');
    d.close();
  });

  it('把 VP9 写进偏好，下一次导出不用再试错', async () => {
    const d = openExportDialog(ctxWith(projectWithClip()));
    await flush();
    const selects = [...d.el.querySelectorAll('select')];
    const codec = selects.find((s) => [...s.options].some((o) => o.value === 'avc'));
    codec.value = 'avc';
    codec.dispatchEvent(new Event('change'));

    exportProject.mockImplementation(async () => new Promise(() => {}));
    vi.useFakeTimers();
    const btn = [...d.el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export');
    btn.click();
    await vi.advanceTimersByTimeAsync(21_000);

    const saved = JSON.parse(localStorage.getItem('video-studio:prefs') || '{}').exportSettings;
    expect(saved).toMatchObject({ codec: 'vp9', format: 'webm' });
    d.close();
  });
});

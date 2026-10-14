/**
 * 裸 WebCodecs 编码能力探测（诊断用）。
 * ------------------------------------------------------------------
 * 为什么需要它：`VideoEncoder.isConfigSupported()` 会骗人。WebKit 上它会真的
 * 实例化一次编码器再返回 true，但「能创建」不等于「能出帧」——某些 webview
 * （macOS 上嵌在宿主里的 WKWebView）里 H.264 创建成功、真正开始编码却可能在中途
 * （比如第 8 帧）静默挂起。所以判断一个编码能不能用，唯一可靠的办法是**真的编
 * 若干帧出来看看**。
 *
 * 它绕开了 mediabunny、绕开了渲染管线，只用浏览器自己的 VideoEncoder。但探测参数
 * **必须贴近真实导出**：
 *   - 分辨率/码率取真实导出的 width/height/bitrate（否则拿 320×180 编 3 帧，
 *     会漏掉「1080p 下第 8 帧才卡」这种规模相关的挂起，误判成「可用」）。
 *   - 帧数给够（默认 40+），要能跨过中途卡死。
 * 于是同样的探测能回答两种完全不同的根因：
 *   - 真实参数下 H.264 WebCodecs 也卡      → 是编码器/GPU 进程的问题（Branch A）。
 *   - 真实参数下 H.264 WebCodecs 能编完    → 卡的是上面的 mediabunny（Branch B）。
 */

export const CODEC_LABELS = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' };

/**
 * 按分辨率挑一个「浏览器大概率认、且能装下这个分辨率」的编码串。
 * isConfigSupported 会看分辨率/等级，串选小了（比如拿 baseline@3.1 去问 1080p）
 * 会被判 false，那是个假阴性，会误导诊断。所以按高度选一串够用的。
 */
function codecStringFor(codec, height) {
  switch (codec) {
    case 'avc':
      return height > 720 ? 'avc1.640028' : 'avc1.42001f'; // High@4.0（覆盖 1080p）/ Baseline@3.1
    case 'hevc':
      return height > 1080 ? 'hvc1.2.4.L150.90' : 'hvc1.1.40.L120.90'; // 8-bit Main(Tier)
    case 'vp9':
      return height > 1080 ? 'vp09.00.60.08' : 'vp09.00.40.08'; // VP9 level 4（覆盖 1080p）
    case 'av1':
      return 'av01.0.08M.08'; // Main 8-bit，1080p 够用
    default:
      return codec;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { code: 'probe-timeout' }));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  return canvas;
}

async function probeOne(codec, cfg, timeoutMs) {
  const out = { codec, label: CODEC_LABELS[codec] || codec, supported: false, frames: 0, ms: 0, error: '' };
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    out.error = 'no-webcodecs';
    return out;
  }
  const fps = cfg.framerate || 30;
  const config = {
    codec: codecStringFor(codec, cfg.height),
    width: cfg.width,
    height: cfg.height,
    bitrate: cfg.bitrate,
    framerate: fps,
  };
  // 只想复刻真实导出时，把它用过的硬件偏好带回去（对 H.264 的 GPU 进程路径没影响，
  // 但 VP9 会据此决定进程内软编/别处）。
  if (cfg.hardware && cfg.hardware !== 'no-preference') config.hardwareAcceleration = cfg.hardware;

  let supported = false;
  try {
    const res = await withTimeout(VideoEncoder.isConfigSupported(config), timeoutMs);
    supported = Boolean(res && res.supported);
  } catch (err) {
    out.error = err?.code === 'probe-timeout' ? 'isConfigSupported 超时' : String(err?.message || err);
    return out;
  }
  out.supported = supported;
  if (!supported) return out;

  // 关键一步：真的编 frames 帧（复用一个画布，够用就行，内容不重要）。
  let encoder = null;
  const started = Date.now();
  try {
    const frames = await withTimeout(new Promise((resolve, reject) => {
      let n = 0;
      encoder = new VideoEncoder({
        output: () => { n += 1; },
        error: (e) => reject(e instanceof Error ? e : new Error(String(e?.message || e))),
      });
      encoder.configure(config);
      const canvas = makeCanvas(cfg.width, cfg.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('无法创建画布');
      for (let i = 0; i < cfg.frames; i++) {
        g.fillStyle = i % 2 ? '#3366aa' : '#aa3366';
        g.fillRect(0, 0, cfg.width, cfg.height);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps) });
        encoder.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      encoder.flush().then(() => resolve(n), reject);
    }), timeoutMs);
    out.frames = frames;
  } catch (err) {
    out.error = err?.code === 'probe-timeout' ? '创建成功但编不出/编不完（超时）' : String(err?.message || err);
  } finally {
    out.ms = Date.now() - started;
    try { encoder?.close?.(); } catch { /* 已经卡死的编码器可能关不掉 */ }
  }
  return out;
}

/**
 * 并行探测若干编码，返回 [{ codec, label, supported, frames, ms, error }]。
 * cfg = { width, height, bitrate, hardware, framerate, frames }；不传时退化成
 * 320×180 / 3 帧的玩具配置（仅够确认「浏览器有没有 WebCodecs」）。
 */
export async function probeCodecs({
  codecs = ['avc', 'vp9'],
  width = 320, height = 180,
  bitrate = 1_000_000,
  hardware = 'no-preference',
  framerate = 30,
  frames = 3,
  timeoutMs = 2500,
} = {}) {
  const cfg = { width, height, bitrate, hardware, framerate, frames };
  const list = await Promise.all(codecs.map((c) => probeOne(c, cfg, timeoutMs).catch((err) => ({
    codec: c, label: CODEC_LABELS[c] || c, supported: false, frames: 0, ms: 0, error: String(err?.message || err),
  }))));
  return list;
}

/** 把探测结果压成一句人话，塞进报错里给用户看。 */
export function summarizeProbes(probes = []) {
  if (!probes.length) return '';
  return probes
    .filter((p) => p && p.error !== 'no-webcodecs')
    .map((p) => {
      const name = p.label || CODEC_LABELS[p.codec] || p.codec;
      if (p.frames > 0) return `${name} 可用`;
      if (p.supported) return `${name} 说支持但不出帧`;
      return `${name} 不可用`;
    })
    .join('；');
}

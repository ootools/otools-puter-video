/**
 * 裸 WebCodecs 编码能力探测（诊断用）。
 * ------------------------------------------------------------------
 * 为什么需要它：`VideoEncoder.isConfigSupported()` 会骗人。WebKit 上它会真的
 * 实例化一次编码器再返回 true，但「能创建」不等于「能出帧」——某些 webview
 * （macOS 上嵌在宿主里的 WKWebView）里 H.264 创建成功、编码时却静默挂起。
 * 所以判断一个编码能不能用，唯一可靠的办法是**真的编几帧出来看看**。
 *
 * 它绕开了 mediabunny、绕开了渲染管线，只用浏览器自己的 VideoEncoder，
 * 所以探测结果可以明确区分：
 *   - 浏览器根本不支持这个编码（isConfigSupported = false）
 *   - 说支持，但编不出帧（就是「卡 0%」那种）
 *   - 真能用（顺便给出帧率量级）
 */

/** 各编码的探测串，写成各浏览器真正认的形式（与 exporter.js 的 VIDEO_CODECS 对齐）。 */
const CODEC_STRINGS = {
  avc: 'avc1.42001f',
  hevc: 'hvc1.1.6.L120.90',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
};

export const CODEC_LABELS = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1' };

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 3;

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

/** 画一帧纯色画面（内容不重要，只要求编码器真的产出数据）。 */
function makeFrame(timestamp) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(WIDTH, HEIGHT)
    : Object.assign(document.createElement('canvas'), { width: WIDTH, height: HEIGHT });
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = timestamp ? '#3366aa' : '#aa3366';
  g.fillRect(0, 0, WIDTH, HEIGHT);
  return new VideoFrame(canvas, { timestamp });
}

async function probeOne(codec, timeoutMs) {
  const out = { codec, label: CODEC_LABELS[codec] || codec, supported: false, frames: 0, ms: 0, error: '' };
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    out.error = 'no-webcodecs';
    return out;
  }
  const config = { codec: CODEC_STRINGS[codec] || codec, width: WIDTH, height: HEIGHT, bitrate: 1_000_000, framerate: 30 };

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

  // 关键一步：真的编几帧。
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
      for (let i = 0; i < FRAMES; i++) {
        const frame = makeFrame(Math.round((i * 1e6) / 30));
        if (!frame) throw new Error('无法创建 VideoFrame（画布不可用）');
        encoder.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      encoder.flush().then(() => resolve(n), reject);
    }), timeoutMs);
    out.frames = frames;
  } catch (err) {
    out.error = err?.code === 'probe-timeout' ? '创建成功但不出帧（超时）' : String(err?.message || err);
  } finally {
    out.ms = Date.now() - started;
    try { encoder?.close?.(); } catch { /* 已经卡死的编码器可能关不掉 */ }
  }
  return out;
}

/**
 * 并行探测若干编码，返回 [{ codec, label, supported, frames, ms, error }]。
 * 每个编码最多等 timeoutMs；编不出帧就是「说支持但不出帧」。
 */
export async function probeCodecs({ codecs = ['avc', 'vp9'], timeoutMs = 2500 } = {}) {
  const list = await Promise.all(codecs.map((c) => probeOne(c, timeoutMs).catch((err) => ({
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

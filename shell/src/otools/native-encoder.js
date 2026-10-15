/**
 * 宿主原生 H.264/MP4 导出（video-only MVP）。
 * ------------------------------------------------------------------
 * 为什么存在：浏览器 WebCodecs 的 H.264 在部分 webview（用户实测 macOS WKWebView
 * 1080p）编码到中途会静默挂死——`isConfigSupported()` 还说支持。VP9（软件 libvpx）
 * 能编完但慢。只有宿主的 **Apple 硬件 H.264（VideoToolbox，经 ffmpeg 的
 * h264_videotoolbox）** 又快又稳。
 *
 * 数据流：调用方逐帧渲染成 canvas → 这里编成 JPEG(base64) → host.writeFile 落到临时
 * 目录的 `%06d.jpg` → 调原生 `encode_h264` 让 ffmpeg 一次性编成 H.264/MP4 → readFile
 * 读回成 blob（交给既有保存流程）。临时目录用完即删。
 *
 * 这是移植层自己的模块，宿主不在 / 非 mac / 没装 ffmpeg 时 `nativeH264Available()`
 * 返回 false，上游导出管线**原样回落**到 WebCodecs（VP9/WebM），行为与从前一致。
 */
import {
  available, channel, env, knownPath, joinPath, createDir, removeEntry,
  writeFile, readFile, base64ToBlob, invokeNative, diag,
} from './host.js';

/** 进程内缓存探测结果（null=还没探）。H.264 导入只会稳定地「可用/不可用」。 */
let availableCache = null;
/** 最近一次探测的结论原因，供导出报错时告诉用户「原生 H.264 为什么没走」。 */
let lastReason = 'not-probed';

/** 仅测试用：清掉探测缓存。 */
export function _resetNativeH264Availability() {
  availableCache = null;
  lastReason = 'not-probed';
}

/**
 * 一键安装 ffmpeg（宿主原生方法，brew 安装）。给导出界面里的「安装 ffmpeg」按钮用。
 * 安装可能耗时较久，但宿主把 invoke 投到 blocking 线程，不会卡 UI。
 * 返回结构化结果 `{ success, command, stdout, stderr }`，失败抛错（走回落逻辑）。
 * 宿主不在 / 非 mac / 包装没接 invokeNative —— 直接抛错，让 UI 提示手动安装。
 */
export async function installFfmpeg() {
  return invokeNative('install_ffmpeg', {});
}

/**
 * 装完 ffmpeg 后强制重新探测一次原生 H.264 是否可用（清掉缓存再探）。
 * 返回最新的 `nativeH264Available()`；UI 装完按钮后据此刷新提示与推选状态。
 */
export async function reprobeNativeH264() {
  availableCache = null;
  lastReason = 'not-probed';
  return nativeH264Available();
}

/** 最近一次 nativeH264Available() 为什么可用/不可用（同步读取；没探过返回 'not-probed'）。 */
export function nativeH264Reason() {
  return lastReason;
}

/** 宿主环境自报的平台；认不出来时返回 ''，交给后面的调用成败兜底。 */
function hostPlatform() {
  return String((env() || {}).platform || (env() || {}).os || (env() || {}).osName || '').toLowerCase();
}

function looksLikeMac() {
  const plat = hostPlatform();
  // 认不出就不武断否决——Windows/Linux 没打包对应 .dylib，invoke 会失败、同样回落。
  if (!plat) return true;
  return plat.includes('darwin') || plat.includes('mac') || plat.includes('apple');
}

/**
 * H.264/MP4 能否走宿主原生硬件编码：宿主可用 + 形似 mac + 原生插件探活
 * （ffmpeg 装了、且带 h264_videotoolbox 编码器）。探测一次后缓存，避免每次导入都
 * 触发原生加载往返。
 */
export async function nativeH264Available() {
  if (availableCache !== null) return availableCache;
  availableCache = false;
  const settle = (reason) => { lastReason = reason; return availableCache; };
  try {
    if (!available() || channel() === 'none') {
      diag({ nativeH264: false, nativeWhy: 'host-unavailable' });
      return settle('host-unavailable');
    }
    if (!looksLikeMac()) {
      diag({ nativeH264: false, nativeWhy: `not-mac:${hostPlatform() || 'unknown'}` });
      return settle(`not-mac:${hostPlatform() || 'unknown'}`);
    }
    let probe;
    try {
      probe = await invokeNative('ffmpeg_probe', {});
    } catch (err) {
      // 原生库缺失 / 走包装失败 / 宿主没这条命令 / 权限拒绝——记下来，别吞。
      diag({ nativeH264: false, nativeWhy: 'invoke-failed', nativeErr: String(err?.message || err) });
      return settle('invoke-failed');
    }
    diag({ ffmpegProbe: probe });
    if (probe && probe.installed && probe.videoToolbox) {
      availableCache = true;
      lastReason = 'ok';
      diag({ nativeH264: true });
      return availableCache;
    }
    diag({ nativeH264: false, nativeWhy: 'ffmpeg-missing-or-no-videotoolbox', ffmpegProbe: probe });
    return settle('ffmpeg-missing-or-no-videotoolbox');
  } catch (err) {
    diag({ nativeH264: false, nativeWhy: 'exception', nativeErr: String(err?.message || err) });
    return settle('exception');
  }
}

/** 建一个本次导出专用的临时目录（宿主 cache/appData/home 下）。 */
async function makeScratchDir(label) {
  const base = knownPath('cache') || knownPath('appData') || knownPath('home');
  if (!base) throw new Error('找不到可写的临时目录');
  const dir = await joinPath(base, 'otools-video', 'encode', `${label}-${Date.now()}`);
  await createDir(dir);
  return dir;
}

function canvasToJpegBase64(canvas, quality) {
  const url = canvas.toDataURL('image/jpeg', quality);
  const comma = url.indexOf(',');
  return comma >= 0 ? url.slice(comma + 1) : '';
}

const pad = (n, w) => String(n).padStart(w, '0');
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/**
 * 逐帧渲染 → JPEG 落盘 → ffmpeg(H.264) → MP4 blob。
 *
 * @param {object}   o
 * @param {number}   o.width
 * @param {number}   o.height
 * @param {number}   o.fps
 * @param {number}   o.bitrate     目标码率（bit/s）
 * @param {number}   o.total       总帧数
 * @param {number}   o.duration    时长（秒）
 * @param {string}   o.name        输出文件名（不含扩展名）
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.onProgress] 与 upstream 管线同形：{ phase, done, total, fraction, elapsed, remaining, preview? }
 * @param {(i:number)=>Promise<HTMLCanvasElement>} o.renderFrame 渲染第 i 帧并返回画布
 */
export async function exportVideoNativeH264({
  width, height, fps, bitrate, total, duration, name,
  signal, onProgress, renderFrame,
}) {
  const root = await makeScratchDir('native-h264');
  const framesDir = await joinPath(root, 'frames');
  await createDir(framesDir);
  const outputName = `${name || 'export'}.mp4`;
  const outputPath = await joinPath(root, outputName);
  const started = performance.now();
  try {
    let lastPreview = 0;
    let lastReport = 0;
    let lastYield = started;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      const canvas = await renderFrame(i);
      const base64 = canvasToJpegBase64(canvas, 0.95);
      if (!base64) throw new Error('无法把帧编码成 JPEG');
      await writeFile(await joinPath(framesDir, `${pad(i + 1, 6)}.jpg`), base64);
      const now = performance.now();
      if (onProgress && (now - lastReport > 100 || i === total - 1)) {
        lastReport = now;
        const elapsed = (now - started) / 1000;
        const done = i + 1;
        const progress = {
          phase: 'video', done, total, fraction: done / total, elapsed,
          remaining: (elapsed / done) * (total - done), fps: done / Math.max(0.001, elapsed),
        };
        // 每 ~0.5s 给个缩略图，让进度视图的预览窗活着（与 upstream 管线一致；宿主没有
        // createImageBitmap 时静默跳过）。
        if ((now - lastPreview > 500 || i === 0) && typeof createImageBitmap === 'function') {
          lastPreview = now;
          try { progress.preview = await createImageBitmap(canvas); } catch { /* 忽略 */ }
        }
        onProgress(progress);
      }
      if (now - lastYield > 12) {
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }
    onProgress?.({ phase: 'finalizing', done: total, total, fraction: 1, elapsed: (performance.now() - started) / 1000, remaining: 0 });
    await invokeNative('encode_h264', { framesDir, fps, width, height, bitrate, outputPath });
    const file = await readFile(outputPath);
    if (!file || !file.dataBase64) throw new Error('编码完成但读回失败');
    const blob = base64ToBlob(file.dataBase64, 'video/mp4');
    const elapsed = (performance.now() - started) / 1000;
    return {
      kind: 'video', blob, release() {},
      fileName: outputName, mimeType: 'video/mp4',
      width, height, frames: total, duration,
      elapsed, fps: total / Math.max(0.001, elapsed),
      codec: 'avc', hardware: true, native: true,
    };
  } finally {
    // 帧目录 + 中间产物用完即删（几十上百个 JPEG，不该留在磁盘上）。
    await removeEntry(root).catch(() => {});
  }
}

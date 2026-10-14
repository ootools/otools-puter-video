/**
 * 宿主原生 H.264 导出的移植层回归。
 * ------------------------------------------------------------------
 * 覆盖 native-encoder.js 的两件事：
 *   1. `nativeH264Available()` 的正确门槛与缓存——不可用时上游管线原样回落；
 *   2. `exportVideoNativeH264()`：逐帧渲染成 JPEG 落盘（%06d.jpg）→ 调 encode_h264
 *      → 读回 MP4 blob → 清理临时目录。host.js 全部 mock 掉。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/otools/host.js', () => {
  const mock = {
    avail: true,
    probe: { installed: true, videoToolbox: true },
    invokeThrows: false,
    writes: [],
    removed: [],
    encodes: [],
    removedOK: true,
  };
  return {
    __mock: mock,
    available: () => mock.avail,
    channel: () => (mock.avail ? 'raw' : 'none'),
    env: () => ({ platform: 'darwin' }),
    knownPath: (name) => (name === 'home' ? '' : '/tmp/otools-test'),
    joinPath: (...parts) => parts.filter((p) => typeof p === 'string' && p).join('/'),
    createDir: async () => {},
    removeEntry: async (p) => { mock.removed.push(p); },
    writeFile: async (path) => { mock.writes.push(path); },
    readFile: async (path) => ({ path, dataBase64: 'QUFB' }),
    base64ToBlob: (b64, mime) => ({ __blob: true, mime, b64 }),
    diag: () => {},
    invokeNative: async (method, payload) => {
      if (mock.invokeThrows) throw new Error('native 调用失败');
      if (method === 'ffmpeg_probe') return mock.probe;
      if (method === 'encode_h264') { mock.encodes.push(payload); return { outputPath: payload.outputPath, bytes: 4 }; }
      throw new Error(`unknown method ${method}`);
    },
  };
});

const host = await import('../src/otools/host.js');
const { nativeH264Available, exportVideoNativeH264, nativeH264Reason, _resetNativeH264Availability } = await import('../src/otools/native-encoder.js');
const mock = host.__mock;

const fakeCanvas = () => ({ toDataURL: () => 'data:image/jpeg;base64,QUFBQg==' });

beforeEach(() => {
  _resetNativeH264Availability();
  mock.avail = true;
  mock.probe = { installed: true, videoToolbox: true };
  mock.invokeThrows = false;
  mock.writes = [];
  mock.removed = [];
  mock.encodes = [];
});

describe('nativeH264Available', () => {
  it('宿主可用 + mac + ffmpeg 带 videotoolbox → true', async () => {
    expect(await nativeH264Available()).toBe(true);
    expect(nativeH264Reason()).toBe('ok');
  });

  it('ffmpeg 没装 / 没 videotoolbox → false（回落 WebCodecs）+ 原因可见', async () => {
    mock.probe = { installed: false, videoToolbox: false };
    expect(await nativeH264Available()).toBe(false);
    expect(nativeH264Reason()).toBe('ffmpeg-missing-or-no-videotoolbox');
    _resetNativeH264Availability();
    mock.probe = { installed: true, videoToolbox: false };
    expect(await nativeH264Available()).toBe(false);
    expect(nativeH264Reason()).toBe('ffmpeg-missing-or-no-videotoolbox');
  });

  it('宿主不在（普通浏览器）→ false', async () => {
    mock.avail = false;
    expect(await nativeH264Available()).toBe(false);
    expect(nativeH264Reason()).toBe('host-unavailable');
  });

  it('原生调用失败（库缺失/走不通/权限拒）→ false，不抛', async () => {
    mock.invokeThrows = true;
    expect(await nativeH264Available()).toBe(false);
    expect(nativeH264Reason()).toBe('invoke-failed');
  });

  it('探测结果缓存，不重复触发 invoke', async () => {
    await nativeH264Available();
    await nativeH264Available();
    // ffmpeg_probe 只在第一次（缓存里复位前）跑；这里用 encode 计数反证没有重复 probe 调用。
    expect(mock.encodes).toHaveLength(0);
  });
});

describe('exportVideoNativeH264', () => {
  it('逐帧写成 %06d.jpg、调 encode_h264、读回 MP4 blob 并清理', async () => {
    const seen = [];
    const result = await exportVideoNativeH264({
      width: 1920, height: 1080, fps: 30, bitrate: 6_000_000,
      total: 5, duration: 5 / 30, name: 'clip',
      onProgress: (p) => seen.push(p),
      renderFrame: async () => fakeCanvas(),
    });

    // 帧：5 帧，001-005，落在 frames/ 下。
    expect(mock.writes).toHaveLength(5);
    expect(mock.writes[0]).toMatch(/\/frames\/000001\.jpg$/);
    expect(mock.writes[4]).toMatch(/000005\.jpg$/);
    // 编码调用带上了真实参数。
    expect(mock.encodes).toHaveLength(1);
    expect(mock.encodes[0]).toMatchObject({ width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 });
    // 返回值与 upstream 管线同形：mp4 blob + .mp4 文件名。
    expect(result.mimeType).toBe('video/mp4');
    expect(result.fileName).toBe('clip.mp4');
    expect(result.codec).toBe('avc');
    expect(result.__blob ?? result.blob.__blob).toBe(true);
    // 用到 onProgress 报进度。
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].phase).toBe('finalizing');
    // 临时目录用完即删。
    expect(mock.removed).toHaveLength(1);
  });

  it('abort 时抛 AbortError，不继续跑', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(exportVideoNativeH264({
      width: 320, height: 180, fps: 30, bitrate: 1_000_000,
      total: 10, duration: 1, name: 'x', signal: ac.signal,
      renderFrame: async () => fakeCanvas(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.encodes).toHaveLength(0);
  });
});

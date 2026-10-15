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
    blobs: [],
    removed: [],
    encodes: [],
    removedOK: true,
    installResult: { success: true, command: 'brew install ffmpeg', stdout: 'ok', stderr: '' },
    installThrows: false,
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
    writeBlob: async (path) => { mock.blobs.push(path); },
    readFile: async (path) => ({ path, dataBase64: 'QUFB' }),
    base64ToBlob: (b64, mime) => ({ __blob: true, mime, b64 }),
    bytesToBase64: (bytes) => 'QUJD',
    diag: () => {},
    invokeNative: async (method, payload) => {
      if (mock.invokeThrows) throw new Error('native 调用失败');
      if (method === 'ffmpeg_probe') return mock.probe;
      if (method === 'encode_h264') { mock.encodes.push(payload); return { outputPath: payload.outputPath, bytes: 4 }; }
      if (method === 'install_ffmpeg') {
        if (mock.installThrows) throw new Error('native 调用失败');
        return mock.installResult;
      }
      throw new Error(`unknown method ${method}`);
    },
  };
});

// 上游的离线混音很重（mediabunny + worklet）；这里只验证「有音轨时把 WAV 交给 ffmpeg」，
// 所以把混音和可听片段判定都 mock 掉。
vi.mock('../src/engine/audio-mix.js', () => {
  const mock = {
    channels: [new Float32Array(4), new Float32Array(4)],
    throws: false,
    calls: [],
  };
  return {
    __audioMock: mock,
    renderAudio: async (_project, _library, opts) => {
      if (mock.throws) throw new Error('混音失败');
      mock.calls.push(opts);
      return { sampleRate: (opts && opts.sampleRate) || 48000, channels: mock.channels };
    },
    encodeWav: (planar, sampleRate) => ({ __wav: true, planar, sampleRate }),
  };
});

vi.mock('../src/engine/scene.js', () => {
  const mock = { audible: [{ id: 'clip1' }] };
  return { __sceneMock: mock, audibleClips: () => mock.audible };
});

const host = await import('../src/otools/host.js');
const { nativeH264Available, exportVideoNativeH264, nativeH264Reason, installFfmpeg, reprobeNativeH264, _resetNativeH264Availability } = await import('../src/otools/native-encoder.js');
const mock = host.__mock;
const audioMock = (await import('../src/engine/audio-mix.js')).__audioMock;
const sceneMock = (await import('../src/engine/scene.js')).__sceneMock;

const fakeCanvas = () => ({ toDataURL: () => 'data:image/jpeg;base64,QUFBQg==' });

// 上游 makeCanvas 在 WKWebView 里产出 OffscreenCanvas——它没有 toDataURL，
// 只能 convertToBlob。这条路径必须也能落帧，否则真机报「e.toDataURL is not a function」。
const fakeOffscreenCanvas = () => ({
  width: 100, height: 100,
  convertToBlob: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]) }),
});

beforeEach(() => {
  _resetNativeH264Availability();
  mock.avail = true;
  mock.probe = { installed: true, videoToolbox: true };
  mock.invokeThrows = false;
  mock.writes = [];
  mock.blobs = [];
  mock.removed = [];
  mock.encodes = [];
  mock.installResult = { success: true, command: 'brew install ffmpeg', stdout: 'ok', stderr: '' };
  mock.installThrows = false;
  audioMock.throws = false;
  audioMock.calls = [];
  sceneMock.audible = [{ id: 'clip1' }];
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

  it('OffscreenCanvas（无 toDataURL）也能落帧：走 convertToBlob', async () => {
    const result = await exportVideoNativeH264({
      width: 640, height: 360, fps: 30, bitrate: 4_000_000,
      total: 3, duration: 0.1, name: 'off',
      onProgress: () => {},
      renderFrame: async () => fakeOffscreenCanvas(),
    });
    // 帧照常写成 3 个 jpg；编码调用带真实参数。
    expect(mock.writes).toHaveLength(3);
    expect(mock.writes[0]).toMatch(/\/frames\/000001\.jpg$/);
    expect(mock.encodes).toHaveLength(1);
    expect(result.mimeType).toBe('video/mp4');
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

describe('exportVideoNativeH264 · 音轨', () => {
  it('有可听片段时：混音成 WAV 落盘，并把 audioPath 交给 ffmpeg', async () => {
    const result = await exportVideoNativeH264({
      width: 640, height: 360, fps: 30, bitrate: 4_000_000,
      total: 3, duration: 3_000_000, name: 'with-audio',
      renderFrame: async () => fakeCanvas(),
      audio: { project: {}, library: {} },
    });
    // 混音跑了一次，输出 WAV 写到 audio.wav。
    expect(audioMock.calls).toHaveLength(1);
    expect(mock.blobs).toHaveLength(1);
    expect(mock.blobs[0]).toMatch(/\/audio\.wav$/);
    // 编码调用带上了音轨路径，且读回结果标注了 aac 音轨。
    expect(mock.encodes).toHaveLength(1);
    expect(mock.encodes[0].audioPath).toMatch(/\/audio\.wav$/);
    expect(result.audioCodec).toBe('aac');
  });

  it('工程无音轨（audibleClips 为空）→ 不加音轨，导出无声视频', async () => {
    sceneMock.audible = [];
    const result = await exportVideoNativeH264({
      width: 640, height: 360, fps: 30, bitrate: 4_000_000,
      total: 3, duration: 3_000_000, name: 'silent',
      renderFrame: async () => fakeCanvas(),
      audio: { project: {}, library: {} },
    });
    expect(audioMock.calls).toHaveLength(0);
    expect(mock.blobs).toHaveLength(0);
    expect(mock.encodes[0].audioPath).toBeUndefined();
    expect(result.audioCodec).toBeNull();
  });

  it('混音失败不毁整次导出：降级为无声视频', async () => {
    audioMock.throws = true;
    const result = await exportVideoNativeH264({
      width: 640, height: 360, fps: 30, bitrate: 4_000_000,
      total: 3, duration: 3_000_000, name: 'mix-fail',
      renderFrame: async () => fakeCanvas(),
      audio: { project: {}, library: {} },
    });
    expect(mock.blobs).toHaveLength(0);
    expect(mock.encodes).toHaveLength(1);
    expect(mock.encodes[0].audioPath).toBeUndefined();
    expect(result.mimeType).toBe('video/mp4');
    expect(result.audioCodec).toBeNull();
  });

  it('没传 audio（未勾选音频）→ 不混音、不加音轨', async () => {
    const result = await exportVideoNativeH264({
      width: 640, height: 360, fps: 30, bitrate: 4_000_000,
      total: 3, duration: 3_000_000, name: 'no-audio-opt',
      renderFrame: async () => fakeCanvas(),
    });
    expect(audioMock.calls).toHaveLength(0);
    expect(mock.encodes[0].audioPath).toBeUndefined();
    expect(result.audioCodec).toBeNull();
  });
});

describe('installFfmpeg / reprobeNativeH264', () => {
  it('installFfmpeg 返回结构化安装结果', async () => {
    const r = await installFfmpeg();
    expect(r).toMatchObject({ success: true, command: 'brew install ffmpeg' });
  });

  it('原生调用失败 → installFfmpeg 抛错（交 UI 提示手动安装）', async () => {
    mock.installThrows = true;
    await expect(installFfmpeg()).rejects.toThrow();
  });

  it('安装失败（success:false）→ installFfmpeg 仍返回结果，UI 读 success 判断', async () => {
    mock.installResult = { success: false, command: 'brew install ffmpeg', stdout: '', stderr: 'already installed' };
    const r = await installFfmpeg();
    expect(r.success).toBe(false);
    expect(String(r.stderr)).toContain('already installed');
  });

  it('reprobeNativeH264 清掉缓存并重探：装好后从 false 变 true', async () => {
    mock.probe = { installed: false, videoToolbox: false };
    expect(await nativeH264Available()).toBe(false);
    // 模拟「装好了 ffmpeg」：改探测结果，再强制重探。
    mock.probe = { installed: true, videoToolbox: true };
    const ok = await reprobeNativeH264();
    expect(ok).toBe(true);
    expect(nativeH264Reason()).toBe('ok');
  });
});

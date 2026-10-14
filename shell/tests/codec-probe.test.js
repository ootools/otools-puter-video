/**
 * 裸 WebCodecs 编码能力探测（移植层自己的回归）。
 * ------------------------------------------------------------------
 * `isConfigSupported()` 会骗人——WebKit 上它真的实例化一次编码器再返回 true，
 * 但「能创建」不等于「能出帧」。所以判断一个编码能不能用，唯一可靠的办法是
 * **真的编几帧出来看看**（见 src/otools/codec-probe.js）。这里测它压成报错的
 * `summarizeProbes()`，以及「浏览器没有 WebCodecs」时探测不抛错、给不出结论。
 */
import { describe, it, expect } from 'vitest';
import { summarizeProbes, probeCodecs } from '../src/otools/codec-probe.js';

describe('summarizeProbes', () => {
  it('区分「可用」「说支持但不出帧」「不可用」', () => {
    const probes = [
      { codec: 'avc', label: 'H.264', supported: true, frames: 0, error: '' },
      { codec: 'vp9', label: 'VP9', supported: true, frames: 3, error: '' },
      { codec: 'av1', label: 'AV1', supported: false, frames: 0, error: '' },
    ];
    // 说支持但真编不出帧的，就是「卡 0%」那种：要和老实的「不可用」区分开。
    expect(summarizeProbes(probes)).toBe('H.264 说支持但不出帧；VP9 可用；AV1 不可用');
  });

  it('浏览器没有 WebCodecs 时给不出结论，返回空串', () => {
    expect(summarizeProbes([
      { codec: 'avc', label: 'H.264', supported: false, frames: 0, error: 'no-webcodecs' },
      { codec: 'vp9', label: 'VP9', supported: false, frames: 0, error: 'no-webcodecs' },
    ])).toBe('');
  });

  it('空数组返回空串', () => {
    expect(summarizeProbes([])).toBe('');
  });
});

describe('probeCodecs 在无 WebCodecs 环境', () => {
  it('不抛错，把每项标成 no-webcodecs，且得不出可用结论', async () => {
    // jsdom 没有 VideoEncoder/VideoFrame：探测应优雅降级而不是崩。
    const probes = await probeCodecs({ codecs: ['avc', 'vp9'], timeoutMs: 500 });
    expect(probes).toHaveLength(2);
    for (const p of probes) {
      expect(p.error).toBe('no-webcodecs');
      expect(p.frames).toBe(0);
    }
    expect(summarizeProbes(probes)).toBe('');
  });
});

/**
 * 编译宿主原生编码库并放到插件根 lib/ 下（宿主按平台加载 lib/<platform>.dylib）。
 * ------------------------------------------------------------------
 * 用途：浏览器 WebCodecs 的 H.264 在部分 WKWebView 环境（实测 macOS 1080p）编码到
 * 中途静默挂死，只有宿主侧的 ffmpeg(h264_videotoolbox)=Apple 硬件 H.264 能又快又稳。
 * 本脚本把 native/ 这个 Rust cdylib 编成 lib/macOS.dylib；宿主 native_plugins 会
 * 找到它并用 plugin.json 的 native.libDir 加载。见 native/src/lib.rs。
 *
 *   node scripts/build-native.mjs       编译并落到 lib/
 *
 * 只在 macOS 有意义（h264_videotoolbox 是 Apple 独占）。非 macOS 或无 cargo 时跳过并
 * 警告，不阻断前端构建——js 侧有 VP9/WebM 作为通用回退，原生 H.264 只是快路径。
 * 发布前需显式跑本脚本，再由 scripts/pack-plugin.mjs 打进 .oplg。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');
const CRATE_DYLIB = 'libotools_puter_video_native.dylib';

function main() {
  if (process.platform !== 'darwin') {
    console.log(`[build-native] 跳过：原生 H.264 编码只在 macOS 提供（当前 ${process.platform}）。`);
    return;
  }
  if (!fs.existsSync(path.join(nativeDir, 'Cargo.toml'))) {
    console.log('[build-native] 跳过：native/ 里没有 crate。');
    return;
  }

  console.log('[build-native] cargo build --release（native/）');
  execFileSync('cargo', ['build', '--release', '--manifest-path', path.join(nativeDir, 'Cargo.toml')], {
    stdio: 'inherit',
    cwd: root,
  });

  const built = path.join(nativeDir, 'target', 'release', CRATE_DYLIB);
  if (!fs.existsSync(built)) {
    throw new Error(`原生构建未产出预期文件：${built}`);
  }
  const libDir = path.join(root, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  // 宿主在 macOS 上找固定名 macOS.dylib（见宿主 platform_lib_name()）。
  const dest = path.join(libDir, 'macOS.dylib');
  fs.copyFileSync(built, dest);
  const sizeMb = (fs.statSync(dest).size / 1048576).toFixed(2);
  console.log(`[build-native] 已生成 lib/macOS.dylib（${sizeMb} MB）。下一步：node scripts/pack-plugin.mjs`);
}

try {
  main();
} catch (error) {
  console.error(`[build-native] 失败：${error.message}`);
  process.exit(1);
}

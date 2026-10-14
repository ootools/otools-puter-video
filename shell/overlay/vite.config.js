import { defineConfig } from 'vite';

/**
 * OTools 插件版的 Vite 配置（覆盖上游同名文件）。
 *
 * 与上游 `vite.config.js` 的两处差别：
 *   1. **不再引入 `../../dev/puter-localhost.mjs`**。上游那个插件把开发服务器
 *      挂在 `<name>.puter.localhost` 上，是因为 Puter 的应用沙箱按子域名区分账号；
 *      插件版没有 Puter，直接跑 `127.0.0.1` 即可。
 *   2. **产物落到仓库根的 `dist/`**（`plugin.json` 的 `entry: dist/index.html`）。
 *      构建根目录是 `.build/`（upstream + 移植层的合成树，见 `scripts/build.mjs`），
 *      所以这里写 `../dist`。
 *
 * `base: './'` 保持不变：宿主用 `otools-plugin://<uuid>/dist/index.html` 提供插件，
 * 相对路径是唯一能同时适配「宿主加载」和「dist 拖进浏览器」的写法。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari16',
    chunkSizeWarningLimit: 900,
    outDir: '../dist',
    // dist/ 的清扫交给 scripts/tree.mjs 的 sweepDist()：按上一次的产物清单删差集，
    // 只删几个带哈希的旧 chunk，而不是把整个目录（几百个字体/模型文件）删掉重来。
    emptyOutDir: false,
    // 产物是插件的一部分，体积直接决定安装包大小；关掉 sourcemap。
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5517,
    strictPort: true,
    fs: {
      // 构建根是 `.build/`，而 node_modules 在仓库根（上一级）。不显式放行的话，
      // dev / vitest 会以 `Denied ID …/node_modules/…?url` 拒掉 @mediapipe 这类
      // 包内资源（生产构建不走这条路径，所以只在 dev/test 上炸）。
      allow: ['..'],
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Accessibility scans of whole panels and the audio and optical flow
    // renders take a few seconds each; leave room on busy machines.
    testTimeout: 20_000,
  },
});

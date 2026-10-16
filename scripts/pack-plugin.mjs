/**
 * 打包插件为 .oplg（与 otools/scripts/plugin_pack.py 的产物格式一致）。
 * ------------------------------------------------------------------
 * `.oplg` 是一个 ZIP，内含 plugin.json、logo.svg 与 dist/。宿主用
 * `park_install_offline_plugin`（插件仓库里的「本地安装」）装它：
 * 拷到下载目录 → 解包 → `detect_effective_plugin_root` 读 plugin.json。
 * 扁平结构（plugin.json 在 ZIP 根）与「单一顶层目录」两种布局宿主都认，
 * 这里用扁平。
 *
 * 本插件是**纯前端**插件（没有 native cdylib），所以：
 *   - 不校验 lib/；
 *   - 用 `productionManifest` 去掉开发期配置（devUrl / quickDev），
 *     否则 OTools 的正式包校验会以「正式包不能启用开发模式」拒收。
 *
 * 用法：node scripts/pack-plugin.mjs [--out dist-pack] [--version 0.1.0]
 */
import { deflateRawSync, crc32 } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 分平台包（--platform）对应的宿主标准库名（与宿主 platform_lib_name 一致）
const PLATFORM_PACK_LIB = { windows: 'Windows.dll', macos: 'macOS.dylib', linux: 'Linux.so' };

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** 递归收集目录下的文件（返回包内相对路径，统一用 / 分隔） */
function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`打包目录不能包含符号链接：${full}`);
    if (stat.isDirectory()) out.push(...walk(full, base));
    else if (stat.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** DOS 时间戳（ZIP 规范要求） */
function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/** 手写 ZIP（不引第三方库，CI 只要有 node 就能打包） */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(now.time, 12);
    dir.writeUInt16LE(now.day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * 生产清单：去掉开发期配置。
 *
 * OTools 的正式包校验会拒收带 `devUrl` 或 `quickDev` 的包，理由就是
 * 「正式包不能启用开发模式」。源仓库里的 plugin.json 保留它们
 * （本地 `node scripts/dev.mjs` 调试要用），打进 .oplg 时换成这一份。
 */
export function productionManifest(manifest, version = '') {
  const next = version || String(manifest.version || '').trim();
  const entry = manifest.entry;
  if (typeof entry !== 'string' || !entry || entry.startsWith('/') || entry.includes('\\') || entry.includes(':')) {
    throw new Error('插件 entry 必须是包内相对路径');
  }
  if (entry.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error(`插件 entry 含非法路径段：${entry}`);
  }
  const result = { ...manifest, version: next };
  delete result.devUrl;
  delete result.quickDev;
  // 本插件没有 native；若将来加了，autoReload 是开发期热重载开关，同样要关掉。
  if (result.native && typeof result.native === 'object') {
    result.native = { ...result.native, autoReload: false };
  }
  return result;
}

function main() {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const manifest = productionManifest(source, arg('version', source.version));
  const { version, packid } = manifest;

  const outDir = path.join(root, arg('out', 'dist-pack'));
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 包内 plugin.json（生产清单，版本号与文件名一致）
  const entries = [{ name: 'plugin.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }];

  // 2) 图标：插件市场/插件仓库要求根目录有 logo.svg
  for (const logo of ['logo.svg', 'logo.png']) {
    const full = path.join(root, logo);
    if (fs.existsSync(full)) entries.push({ name: logo, data: fs.readFileSync(full) });
  }

  // 3) 前端产物 dist/ 与原生编码库 lib/（lib/ 由 scripts/build-native.mjs 生成；
  // macOS 上是 lib/macOS.dylib，宿主按 plugin.json 的 native.libDir 加载）。
  for (const name of ['dist', 'lib']) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    for (const relative of walk(dir)) {
      entries.push({ name: `${name}/${relative}`, data: fs.readFileSync(path.join(dir, relative)) });
    }
  }

  // 分平台包：lib/ 只保留本平台的标准库，剔除另外两个平台的库
  // （其余 lib/ 文件保留，避免打断依赖同目录库的插件）。
  const platform = String(arg('platform', '') || '').trim().toLowerCase();
  if (platform) {
    if (!PLATFORM_PACK_LIB[platform]) {
      throw new Error(`未知平台：${platform}（应为 ${Object.keys(PLATFORM_PACK_LIB).join(' / ')}）`);
    }
    const keep = `lib/${PLATFORM_PACK_LIB[platform]}`;
    if (!entries.some((item) => item.name === keep)) {
      throw new Error(`分平台打包缺少 ${platform} 平台库：${keep} 不存在（lib/ 由 scripts/build-native.mjs 生成）`);
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const name = entries[index].name;
      if (name.startsWith('lib/') && name !== keep && Object.values(PLATFORM_PACK_LIB).includes(path.posix.basename(name))) {
        entries.splice(index, 1);
      }
    }
  }

  // 4) 自检：entry 指向的文件必须真的在包里
  const entryFile = String(manifest.entry || '').replace(/^\.?\//, '');
  if (!entries.some((item) => item.name === entryFile)) {
    throw new Error(`manifest.entry 指向的文件不在包内：${entryFile}（请先执行 node scripts/build.mjs）`);
  }
  if (!entries.some((item) => item.name === 'logo.svg')) {
    throw new Error('插件根目录必须提供 logo.svg');
  }

  const outputName = platform ? `${packid}-${version}-${platform}.oplg` : `${packid}-${version}.oplg`;
  const output = path.join(outDir, outputName);
  fs.writeFileSync(output, zip(entries));

  // 发布目录统一扁平结构：oplg + plugin.json + logo.svg + 摘要 + 元信息
  // 分平台包不重写 plugin.json / logo.svg（合包步骤已写入），摘要行追加到 SHA256SUMS。
  if (!platform) {
    fs.writeFileSync(path.join(outDir, 'plugin.json'), entries[0].data);
    fs.copyFileSync(path.join(root, 'logo.svg'), path.join(outDir, 'logo.svg'));
  }
  const sumsPath = path.join(outDir, 'SHA256SUMS');
  if (platform && fs.existsSync(sumsPath)) {
    const digest = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    fs.appendFileSync(sumsPath, `${digest}  ${outputName}\n`);
  } else {
    const releaseFiles = [outputName, 'plugin.json', 'logo.svg'];
    const sums = releaseFiles.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex')}  ${name}`);
    fs.writeFileSync(sumsPath, `${sums.join('\n')}\n`);
  }
  const meta = {
    packid,
    uuid: manifest.uuid,
    version,
    output,
    entries: entries.length,
    totalBytes: entries.reduce((sum, item) => sum + item.data.length, 0),
    nativeLibs: entries.map((item) => item.name).filter((name) => name.startsWith('lib/')),
    platform: platform || 'merged',
  };
  fs.writeFileSync(path.join(outDir, platform ? `meta-${platform}.json` : 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

// 构建便携版：一个不用安装、不依赖项目目录和机器上 Node 的单个 exe。
//
// 步骤：
//   1. 构建前端（web/dist）
//   2. 用 esbuild 把后端打成单个 ESM 文件
//   3. 把 node.exe（当前运行这个脚本的 Node）、后端、前端和许可证文本打成 tar，再用 brotli 压缩成 payload
//   4. 用独立的 target 目录（desktop/src-tauri/target-portable）编译开启 portable 特性的桌面壳，
//      payload 通过 include_bytes! 嵌进 exe。不会碰平时 desktop:build 的 target/release
//   5. 成品拷到 release/agentree-portable.exe，打印大小和 SHA256
//
// 环境变量：
//   AGENTREE_NODE_LICENSE  Node.js 许可证文本的本地路径。不设时从 GitHub 下载对应版本的 LICENSE 并缓存
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(root, 'desktop', 'src-tauri');
const targetDir = join(tauriDir, 'target-portable');
const payloadDir = join(targetDir, 'payload');
const stageDir = join(targetDir, 'stage');
const cacheDir = join(targetDir, 'cache');
const releaseDir = join(root, 'release');
const output = join(releaseDir, 'agentree-portable.exe');

const log = (msg) => console.log(`[portable] ${msg}`);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${[cmd, ...args].join(' ')} 失败，退出码 ${code}`))));
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// tar（ustar）写入：只需要普通文件，目录由解压方按路径自动创建
// ---------------------------------------------------------------------------

function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar：超过 100 字节的路径拆成 prefix（最多 155）+ name（最多 100）
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`路径太长，无法写入 tar：${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, off, len) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
  put(base, 0, 100);
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(0, 136, 12); // 固定的修改时间，保证同样的输入得到同样的 payload（哈希不变就不用重新解压）
  h.fill(0x20, 148, 156); // 计算校验和时校验和字段按空格算
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function buildTar(files) {
  const parts = [];
  for (const { name, data } of files) {
    parts.push(tarHeader(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 各个步骤
// ---------------------------------------------------------------------------

async function buildWeb() {
  log('构建前端');
  await run(process.execPath, [join(root, 'scripts', 'run.mjs'), 'build'], { cwd: root });
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('前端构建后没有找到 web/dist/index.html');
}

async function bundleServer() {
  log('打包后端（esbuild）');
  const require = createRequire(join(root, 'server', 'package.json'));
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    throw new Error('没有找到 esbuild，请先执行 npm run setup（server 的依赖里包含 esbuild）');
  }
  const outfile = join(stageDir, 'server', 'index.mjs');
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(root, 'server', 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // 有的依赖（如 jsonc-parser）的 main 是 UMD，优先用它们的 ESM 版本
    mainFields: ['module', 'main'],
    legalComments: 'eof',
    logLevel: 'warning',
    metafile: true,
  });
  const code = readFileSync(outfile, 'utf8');
  if (/\b__require\(/.test(code)) {
    throw new Error('打包结果里有动态 require，ESM 下运行会失败，请检查新增的依赖');
  }
  // 从打包输入里找出内联进来的第三方包：包名 → 包目录
  const pkgs = new Map();
  for (const f of Object.keys(result.metafile.inputs)) {
    const m = f.replace(/\\/g, '/').match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (m) pkgs.set(m[2], join(root, m[1]));
  }
  const names = [...pkgs.keys()].sort();
  log(`后端打包完成：${mb(Buffer.byteLength(code))}，内联的第三方包：${names.join('、') || '无'}`);
  return names.map((name) => ({ name, dir: pkgs.get(name) }));
}

async function nodeLicense() {
  const override = process.env.AGENTREE_NODE_LICENSE?.trim();
  if (override) return readFileSync(override);
  const cached = join(cacheDir, `node-${process.version}-LICENSE`);
  if (existsSync(cached)) return readFileSync(cached);
  const url = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  log(`下载 Node.js ${process.version} 的许可证文本：${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`下载 Node.js 许可证失败（${e.message}）。可以手动下载后用 AGENTREE_NODE_LICENSE 指定本地文件`);
  }
  if (!res.ok) throw new Error(`下载 Node.js 许可证失败：HTTP ${res.status}。可以用 AGENTREE_NODE_LICENSE 指定本地文件`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, buf);
  return buf;
}

function thirdPartyLicenses(pkgs) {
  const chunks = ['agentree 后端打包进 server/index.mjs 的第三方包及其许可证。\n'];
  for (const { name, dir } of pkgs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((f) => /^licen[sc]e(\.|$)/i.test(f));
    chunks.push(`\n==== ${name}@${pkg.version}（${pkg.license ?? '未注明'}）====\n`);
    chunks.push(file ? readFileSync(join(dir, file), 'utf8') : '（包里没有许可证文件）\n');
  }
  return Buffer.from(chunks.join(''), 'utf8');
}

async function buildPayload(pkgs) {
  log('生成 payload');
  const files = [];
  const add = (name, data) => files.push({ name, data });

  add('node.exe', readFileSync(process.execPath));
  add('server/index.mjs', readFileSync(join(stageDir, 'server', 'index.mjs')));
  const webDist = join(root, 'web', 'dist');
  for (const f of walk(webDist)) {
    add(`web/${relative(webDist, f).split(sep).join('/')}`, readFileSync(f));
  }
  add('LICENSES/node.txt', await nodeLicense());
  add('LICENSES/server-third-party.txt', thirdPartyLicenses(pkgs));
  const agentreeLicense = join(root, 'LICENSE');
  if (existsSync(agentreeLicense)) add('LICENSES/agentree.txt', readFileSync(agentreeLicense));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  add('payload.json', Buffer.from(JSON.stringify({ agentree: version, node: process.version }, null, 2) + '\n'));

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tar = buildTar(files);
  const t0 = Date.now();
  const br = zlib.brotliCompressSync(tar, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: tar.length,
    },
  });
  const id = createHash('sha256').update(br).digest('hex').slice(0, 16);
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(join(payloadDir, 'payload.tar.br'), br);
  writeFileSync(join(payloadDir, 'payload.id'), id + '\n');
  log(`payload：${files.length} 个文件，tar ${mb(tar.length)}，压缩后 ${mb(br.length)}（${((Date.now() - t0) / 1000).toFixed(1)} 秒），哈希 ${id}`);
}

async function buildShell() {
  log(`编译便携版桌面壳（target 目录：${relative(root, targetDir)}）`);
  // 依赖库的报错信息里会带上源文件的完整路径（C:\Users\<用户名>\.cargo\registry\...），原样编进 exe 会把
  // 构建者的用户名带出去。成品是要发给别人的，所以把用户目录、cargo 目录和项目目录重映射成固定的名字。
  // 用 CARGO_ENCODED_RUSTFLAGS（分隔符 \x1f）是为了路径里有空格时也不会被拆开；后面的规则优先
  const remaps = [
    [homedir(), 'home'],
    [process.env.CARGO_HOME || join(homedir(), '.cargo'), 'cargo'],
    [root, 'agentree'],
  ].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  const existing = (process.env.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  await run(process.execPath, [join(root, 'desktop', 'scripts', 'tauri.mjs'), 'build', '--no-bundle', '--features', 'portable'], {
    cwd: join(root, 'desktop'),
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_ENCODED_RUSTFLAGS: [...existing, ...remaps].join('\x1f') },
  });
  const exe = join(targetDir, 'release', 'agentree.exe');
  if (!existsSync(exe)) throw new Error(`编译后没有找到 ${exe}`);
  mkdirSync(releaseDir, { recursive: true });
  copyFileSync(exe, output);
  const buf = readFileSync(output);
  const sha = createHash('sha256').update(buf).digest('hex');
  log(`完成：${output}`);
  log(`大小：${mb(buf.length)}（${statSync(output).size} 字节）`);
  log(`SHA256：${sha}`);
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('便携版目前只支持在 Windows x64 上构建（payload 里的 node.exe 取自当前运行的 Node）');
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`需要 Node 24 或更高版本来构建（当前 ${process.version}），后端依赖 node:sqlite`);
  rmSync(stageDir, { recursive: true, force: true });
  await buildWeb();
  const pkgs = await bundleServer();
  await buildPayload(pkgs);
  await buildShell();
}

main().catch((err) => {
  console.error(`[portable] ${err.message}`);
  process.exit(1);
});

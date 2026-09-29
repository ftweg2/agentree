// 根目录的启动脚本：server/ 和 web/ 各自是独立的包，这里负责把它们串起来。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.AGENTREE_PORT || '4777';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(dir, args, extraEnv = {}) {
  const child = spawn(npm, args, {
    cwd: join(root, dir),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  return child;
}

function wait(child, label) {
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败，退出码 ${code}`));
    });
    child.on('error', reject);
  });
}

function openBrowser(url) {
  if (process.env.AGENTREE_NO_OPEN) return;
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/live`);
      if (res.ok) return true;
    } catch {
      // 后端还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function superviseAll(children) {
  const stop = () => {
    for (const c of children) {
      if (c.exitCode !== null) continue;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        c.kill('SIGTERM');
      }
    }
  };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  for (const c of children) {
    c.on('exit', (code) => {
      stop();
      process.exit(code ?? 0);
    });
  }
}

async function setup() {
  for (const dir of ['server', 'web']) {
    console.log(`[agentree] 安装 ${dir} 的依赖`);
    await wait(run(dir, ['install']), `${dir} 依赖安装`);
  }
}

async function ensureInstalled() {
  const missing = ['server', 'web'].filter((d) => !existsSync(join(root, d, 'node_modules')));
  if (missing.length === 0) return;
  console.log(`[agentree] 首次运行，安装依赖：${missing.join('、')}`);
  for (const dir of missing) {
    await wait(run(dir, ['install']), `${dir} 依赖安装`);
  }
}

async function build() {
  await ensureInstalled();
  await wait(run('web', ['run', 'build']), '前端构建');
}

async function dev() {
  await ensureInstalled();
  const server = run('server', ['run', 'dev']);
  const web = run('web', ['run', 'dev']);
  superviseAll([server, web]);
  if (await waitForServer()) openBrowser('http://127.0.0.1:5173');
}

async function start() {
  await ensureInstalled();
  if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
    console.log('[agentree] 没有找到前端构建产物，先构建一次');
    await wait(run('web', ['run', 'build']), '前端构建');
  }
  const server = run('server', ['run', 'start']);
  superviseAll([server]);
  if (await waitForServer()) {
    console.log(`[agentree] 已启动：http://127.0.0.1:${port}`);
    openBrowser(`http://127.0.0.1:${port}`);
  } else {
    console.error('[agentree] 后端 60 秒内没有就绪');
  }
}

const commands = { setup, dev, build, start };
const name = process.argv[2];
if (!commands[name]) {
  console.error(`用法：node scripts/run.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}
commands[name]().catch((err) => {
  console.error(`[agentree] ${err.message}`);
  process.exit(1);
});

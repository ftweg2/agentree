// 调用本地安装的 @tauri-apps/cli。
// 只在子进程的环境里把 ~/.cargo/bin 放到 PATH 前面，不修改用户或系统的 PATH。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(desktopDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

if (!existsSync(cli)) {
  console.error('[agentree-desktop] 没有找到 @tauri-apps/cli，请先在 desktop/ 目录执行 npm install');
  process.exit(1);
}

const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const cargoBin = join(cargoHome, 'bin');
if (!existsSync(join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  console.warn(`[agentree-desktop] 警告：${cargoBin} 下没有找到 cargo，将依赖 PATH 中已有的 cargo`);
}

// Windows 上环境变量名不区分大小写，但 process.env 展开后可能是 Path 或 PATH，统一处理
const env = { ...process.env };
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const current = env[pathKey] || '';
for (const k of Object.keys(env)) {
  if (k.toUpperCase() === 'PATH' && k !== pathKey) delete env[k];
}
env[pathKey] = current.split(delimiter).includes(cargoBin) ? current : `${cargoBin}${delimiter}${current}`;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: 'inherit',
  env,
});

const forward = (sig) => () => {
  if (child.exitCode === null) child.kill(sig);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on('error', (err) => {
  console.error(`[agentree-desktop] 启动 tauri 命令行失败：${err.message}`);
  process.exit(1);
});

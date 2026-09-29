// 路径与运行参数。所有 Claude Code 目录只读；agentree 自己的数据放在 ~/.agentree。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Claude Code 配置目录列表：CLAUDE_CONFIG_DIR 可逗号分隔多个，否则 ~/.claude */
export function claudeConfigDirs(): string[] {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  if (raw && raw.trim()) {
    const dirs = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.resolve(s));
    if (dirs.length) return [...new Set(dirs)];
  }
  // 取用户目录用 os.homedir()，不读 HOME（Git Bash 可能注入错误值）
  return [path.join(os.homedir(), '.claude')];
}

/** agentree 自己的数据目录。AGENTREE_HOME 仅用于测试隔离 */
export function agentreeHome(): string {
  const override = process.env.AGENTREE_HOME;
  const dir = override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.agentree');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 桌面版数据目录 %APPDATA%\Claude；设置了 CLAUDE_CONFIG_DIR 做隔离测试时可用 AGENTREE_DESKTOP_DIR 覆盖 */
export function desktopDir(): string | null {
  const override = process.env.AGENTREE_DESKTOP_DIR;
  if (override !== undefined) return override.trim() ? path.resolve(override) : null;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  return path.join(os.homedir(), '.config', 'Claude');
}

export function port(): number {
  const p = Number(process.env.AGENTREE_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 4777;
}

export const HOST = '127.0.0.1';

/** 最近多少毫秒内有写入算活跃 / 运行中 */
export const ACTIVE_WINDOW_MS = 120_000;
export const FAST_TICK_MS = 2_000;
export const FULL_SCAN_MS = 30_000;

export const BUILTIN_AGENT_TYPES = [
  'general-purpose',
  'Explore',
  'Plan',
  'claude-code-guide',
  'statusline-setup',
  'claude',
  'output-style-setup',
];

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

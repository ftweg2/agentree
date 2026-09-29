const nf = new Intl.NumberFormat('zh-CN');

/** 完整数字，带千分位 */
export function fullNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return nf.format(n);
}

/** token 缩写：K / M / B */
export function shortNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10_000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'K';
  if (abs < 1_000_000) return (n / 1000).toFixed(abs < 100_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1).replace(/\.?0+$/, '') + 'M';
  return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B';
}

export function formatCost(c: number | null | undefined): string {
  if (c == null || Number.isNaN(c)) return '—';
  if (c === 0) return '$0';
  if (c < 0.01) return '<$0.01';
  if (c < 100) return '$' + c.toFixed(2);
  return '$' + nf.format(Math.round(c));
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** 紧凑的耗时：12s / 3m20s / 1h05m */
export function shortDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** 本地时间：同一年省略年份 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

export function formatFullDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 5 天前 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, now - t) / 1000;
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${Math.floor(diff)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return formatDateTime(iso);
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(digits) + '%';
}

/**
 * 工具名的短写法。MCP 工具的全名是 mcp__服务名__工具名，界面上只显示工具名，
 * 服务名放在悬停提示里。
 */
export function toolLabel(name: string | null | undefined): { short: string; full: string } | null {
  if (!name) return null;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return { short: name, full: name };
  return { short: m[2], full: `${m[2]}（MCP 服务：${m[1].replace(/_/g, ' ')}）` };
}

export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** 项目目录名如 C--Users-you-Desktop-agentree，优先用 cwd 的最后一段 */
export function projectLabel(projectDir: string, cwd: string | null | undefined): string {
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const parts = projectDir.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : projectDir;
}

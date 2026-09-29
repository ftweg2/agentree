// 桌面版数据（只读）：会话元数据（标题等）和额度历史。
import fs from 'node:fs/promises';
import path from 'node:path';
import { desktopDir } from './config.ts';
import type { QuotaInfo, QuotaSample } from '../../shared/types.ts';

export interface DesktopSession {
  cliSessionId: string;
  title: string | null;
  model: string | null;
  effort: string | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  isArchived: boolean;
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth - 1, out);
    else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) out.push(p);
  }
}

export class Desktop {
  sessions = new Map<string, DesktopSession>();
  version = 0;
  private fingerprint = '';

  async refresh(): Promise<void> {
    const base = desktopDir();
    if (!base) return;
    const files: string[] = [];
    await walk(path.join(base, 'claude-code-sessions'), 4, files);
    const next = new Map<string, DesktopSession>();
    const fp: string[] = [];
    for (const f of files) {
      try {
        const st = await fs.stat(f);
        fp.push(`${f}:${st.mtimeMs}:${st.size}`);
        const o = JSON.parse(await fs.readFile(f, 'utf8'));
        if (!o || typeof o.cliSessionId !== 'string') continue;
        const s: DesktopSession = {
          cliSessionId: o.cliSessionId,
          title: typeof o.title === 'string' && o.title.trim() ? o.title : null,
          model: typeof o.model === 'string' ? o.model : null,
          effort: typeof o.effort === 'string' ? o.effort : null,
          createdAt: typeof o.createdAt === 'number' ? o.createdAt : null,
          lastActivityAt: typeof o.lastActivityAt === 'number' ? o.lastActivityAt : null,
          isArchived: o.isArchived === true,
        };
        const prev = next.get(s.cliSessionId);
        if (!prev || (s.lastActivityAt ?? 0) > (prev.lastActivityAt ?? 0)) next.set(s.cliSessionId, s);
      } catch {
        // 单个文件坏了不影响其他
      }
    }
    const f = fp.sort().join('|');
    if (f !== this.fingerprint) {
      this.fingerprint = f;
      this.sessions = next;
      this.version++;
    }
  }

  async quota(): Promise<QuotaInfo | null> {
    const base = desktopDir();
    if (!base) return null;
    const file = path.join(base, 'plan-usage-history.json');
    let data: any;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
    if (!data || !Array.isArray(data.samples)) return null;
    const raw = data.samples.filter(
      (s: any) => s && typeof s.t === 'number' && s.u && typeof s.u === 'object',
    ) as Array<{ t: number; org?: string; u: { fh?: number; sd?: number } }>;
    raw.sort((a, b) => a.t - b.t);
    // 多个组织时只取最近一次采样所属的组织
    const lastOrg = raw.length ? raw[raw.length - 1].org : undefined;
    const samples: QuotaSample[] = raw
      .filter((s) => s.org === lastOrg)
      .map((s) => ({
        t: s.t,
        fiveHourPct: typeof s.u.fh === 'number' ? s.u.fh : 0,
        sevenDayPct: typeof s.u.sd === 'number' ? s.u.sd : 0,
      }));
    return { source: file, latest: samples.length ? samples[samples.length - 1] : null, samples };
  }
}

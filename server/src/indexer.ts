// 发现日志文件、增量解析、定时检查。启动时后台扫描，不阻塞接口。
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IndexStatus } from '../../shared/types.ts';
import { claudeConfigDirs, FAST_TICK_MS, FULL_SCAN_MS } from './config.ts';
import type { FileRow, MetaRow, Store } from './db.ts';
import { LineBatch, parsePending } from './parser.ts';
import { readLines } from './reader.ts';

export interface LogFile {
  path: string;
  sessionId: string;
  projectDir: string;
  /** 'main' 或子 agent id */
  agent: string;
  /** 所在目录，用于在活跃会话里快速发现新文件 */
  subagentDir: string | null;
}

export interface MetaFile {
  path: string;
  sessionId: string;
  agentId: string;
}

const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;
const META_FILE_RE = /^agent-(.+)\.meta\.json$/;
/** 超过这个时间没写入的文件，末尾缺换行的完整 JSON 行也处理 */
const TRAILING_GRACE_MS = 60_000;
/** 快速检查覆盖最近多久内有写入的文件 */
const RECENT_MS = 10 * 60_000;

async function readdirSafe(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 扫描一个 subagents 目录（以及其下 workflows/wf_*） */
async function scanSubagentDir(dir: string, sessionId: string, projectDir: string, files: LogFile[], metas: MetaFile[]) {
  for (const e of await readdirSafe(dir)) {
    if (e.isFile()) {
      if (e.name === 'journal.jsonl') continue;
      const m = AGENT_FILE_RE.exec(e.name);
      if (m && !e.name.endsWith('.meta.json')) {
        files.push({ path: path.join(dir, e.name), sessionId, projectDir, agent: m[1], subagentDir: dir });
        continue;
      }
      const mm = META_FILE_RE.exec(e.name);
      if (mm) metas.push({ path: path.join(dir, e.name), sessionId, agentId: mm[1] });
    } else if (e.isDirectory() && e.name === 'workflows') {
      for (const wf of await readdirSafe(path.join(dir, 'workflows'))) {
        if (wf.isDirectory()) await scanSubagentDir(path.join(dir, 'workflows', wf.name), sessionId, projectDir, files, metas);
      }
    }
  }
}

// 固定深度扫描：主会话、subagents/、subagents/workflows/wf_<id>/
export async function discover(configDirs = claudeConfigDirs()): Promise<{ files: LogFile[]; metas: MetaFile[] }> {
  const files: LogFile[] = [];
  const metas: MetaFile[] = [];
  for (const cfg of configDirs) {
    const projects = path.join(cfg, 'projects');
    for (const p of await readdirSafe(projects)) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(projects, p.name);
      for (const e of await readdirSafe(projDir)) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          files.push({ path: path.join(projDir, e.name), sessionId: e.name.slice(0, -6), projectDir: p.name, agent: 'main', subagentDir: null });
        } else if (e.isDirectory()) {
          const sub = path.join(projDir, e.name, 'subagents');
          await scanSubagentDir(sub, e.name, p.name, files, metas);
        }
      }
    }
  }
  return { files, metas };
}

interface Known extends LogFile {
  mtimeMs: number;
  /** 本进程观察到文件变大的时间。Windows 上持续追加时修改时间可能不更新，用它兜底 */
  observedMs: number;
  size: number;
}

export class Indexer {
  private store: Store;
  private known = new Map<string, Known>();
  private metaStamp = new Map<string, string>();
  private busy = false;
  private pendingFull = false;
  private timers: NodeJS.Timeout[] = [];
  /** 每个会话的数据版本号，有新数据就加一，供上层缓存失效 */
  readonly sessionVersions = new Map<string, number>();
  status: IndexStatus = { state: 'idle', filesTotal: 0, filesIndexed: 0, lastIndexedAt: null, skippedLines: 0 };
  lastFullScanMs: number | null = null;
  onFullScanDone: ((ms: number) => void) | null = null;

  constructor(store: Store) {
    this.store = store;
    this.status.skippedLines = this.totalSkipped();
  }

  private totalSkipped(): number {
    const r = this.store.db.prepare('SELECT COALESCE(SUM(skipped), 0) AS n FROM files').get() as { n: number };
    return Number(r.n);
  }

  private bump(sessionId: string) {
    this.sessionVersions.set(sessionId, (this.sessionVersions.get(sessionId) ?? 0) + 1);
  }

  /** 文件的最近写入时间（毫秒），用于判断活跃 */
  mtimeOf(filePath: string): number | null {
    const k = this.known.get(filePath);
    return k ? Math.max(k.mtimeMs, k.observedMs) : null;
  }

  start(): void {
    void this.fullScan();
    this.timers.push(setInterval(() => void this.fastTick(), FAST_TICK_MS));
    this.timers.push(setInterval(() => void this.fullScan(), FULL_SCAN_MS));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** 触发一次全量增量扫描（不等待完成） */
  requestFullScan(): void {
    void this.fullScan();
  }

  async fullScan(): Promise<void> {
    if (this.busy) {
      this.pendingFull = true;
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    this.status.state = 'indexing';
    this.status.filesIndexed = 0;
    try {
      const { files, metas } = await discover();
      this.status.filesTotal = files.length;
      const stats = await Promise.all(
        files.map(async (f) => {
          try {
            return { f, st: await fs.stat(f.path) };
          } catch {
            return { f, st: null };
          }
        }),
      );
      // 最近写入的文件先处理，实时视图更快可用
      stats.sort((a, b) => (b.st?.mtimeMs ?? 0) - (a.st?.mtimeMs ?? 0));
      const seen = new Set<string>();
      for (const { f, st } of stats) {
        seen.add(f.path);
        if (st) await this.processFile(f, st.size, st.mtimeMs);
        this.status.filesIndexed++;
      }
      for (const m of metas) await this.processMeta(m);
      // 已被 Claude Code 清理的文件：只标记，不删数据
      for (const row of this.store.allFiles()) {
        if (!seen.has(row.path) && row.present) {
          this.store.markMissing(row.path);
          this.known.delete(row.path);
        }
      }
      this.status.lastIndexedAt = new Date().toISOString();
      this.status.skippedLines = this.totalSkipped();
    } catch (e) {
      console.error('[agentree] 扫描出错', e);
    } finally {
      this.status.state = 'idle';
      this.busy = false;
      const ms = performance.now() - t0;
      this.lastFullScanMs = ms;
      this.onFullScanDone?.(ms);
      this.onFullScanDone = null;
    }
    if (this.pendingFull) {
      this.pendingFull = false;
      await this.fullScan();
    }
  }

  /** 每 2 秒：检查最近活跃的文件、活跃会话里新出现的子 agent 文件、新出现的主会话文件 */
  async fastTick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      const candidates = new Map<string, LogFile>();
      const activeSubDirs = new Map<string, { sessionId: string; projectDir: string }>();
      for (const k of this.known.values()) {
        if (now - Math.max(k.mtimeMs, k.observedMs) < RECENT_MS) {
          candidates.set(k.path, k);
          const sessionRoot = k.agent === 'main' ? k.path.slice(0, -6) : null;
          const sub = k.subagentDir ?? (sessionRoot ? path.join(sessionRoot, 'subagents') : null);
          if (sub) activeSubDirs.set(sub, { sessionId: k.sessionId, projectDir: k.projectDir });
        }
      }
      // 新的主会话文件：列出各项目目录（只看顶层，开销很小）
      for (const cfg of claudeConfigDirs()) {
        const projects = path.join(cfg, 'projects');
        for (const p of await readdirSafe(projects)) {
          if (!p.isDirectory()) continue;
          for (const e of await readdirSafe(path.join(projects, p.name))) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const fp = path.join(projects, p.name, e.name);
            if (!this.known.has(fp)) {
              candidates.set(fp, { path: fp, sessionId: e.name.slice(0, -6), projectDir: p.name, agent: 'main', subagentDir: null });
              activeSubDirs.set(path.join(projects, p.name, e.name.slice(0, -6), 'subagents'), { sessionId: e.name.slice(0, -6), projectDir: p.name });
            }
          }
        }
      }
      // 活跃会话里新派发的子 agent
      for (const [dir, s] of activeSubDirs) {
        const files: LogFile[] = [];
        const metas: MetaFile[] = [];
        await scanSubagentDir(dir, s.sessionId, s.projectDir, files, metas);
        for (const f of files) if (!this.known.has(f.path) || candidates.has(f.path)) candidates.set(f.path, f);
        for (const m of metas) await this.processMeta(m);
      }
      for (const f of candidates.values()) {
        let st;
        try {
          st = await fs.stat(f.path);
        } catch {
          continue;
        }
        await this.processFile(f, st.size, st.mtimeMs);
      }
      if (this.status.state === 'idle') {
        this.status.filesTotal = Math.max(this.status.filesTotal, this.known.size);
        this.status.filesIndexed = this.status.filesTotal;
      }
    } catch (e) {
      console.error('[agentree] 快速检查出错', e);
    } finally {
      this.busy = false;
    }
  }

  private async processMeta(m: MetaFile): Promise<void> {
    let st;
    try {
      st = await fs.stat(m.path);
    } catch {
      return;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (this.metaStamp.get(m.path) === stamp) return;
    let o: any;
    try {
      o = JSON.parse(await fs.readFile(m.path, 'utf8'));
    } catch {
      return; // 可能正在写，下次再读
    }
    this.metaStamp.set(m.path, stamp);
    if (!o || typeof o !== 'object') return;
    const meta: MetaRow = {
      agentType: typeof o.agentType === 'string' ? o.agentType : null,
      description: typeof o.description === 'string' ? o.description : null,
      toolUseId: typeof o.toolUseId === 'string' ? o.toolUseId : null,
      spawnDepth: typeof o.spawnDepth === 'number' ? o.spawnDepth : null,
      model: typeof o.model === 'string' ? o.model : null,
      requestShape: typeof o.requestShape === 'string' ? o.requestShape : null,
    };
    const prev = this.store.getMeta(m.sessionId, m.agentId);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(meta)) {
      this.store.upsertMeta(m.sessionId, m.agentId, meta);
      this.bump(m.sessionId);
    }
  }

  /** 增量解析一个文件。返回是否读到了新数据 */
  async processFile(f: LogFile, size: number, mtimeMs: number): Promise<boolean> {
    const row = this.store.getFile(f.path);
    const prevKnown = this.known.get(f.path);
    const observedMs = prevKnown && prevKnown.size !== size ? Date.now() : (prevKnown?.observedMs ?? 0);
    this.known.set(f.path, { ...f, size, mtimeMs, observedMs });
    // 同时看修改时间和大小
    if (row && row.size === size && row.mtime_ms === mtimeMs) return false;

    let start = row?.offset ?? 0;
    let skipped = row?.skipped ?? 0;
    let firstTs = row?.first_ts ?? null;
    let lastTs = row?.last_ts ?? null;
    let fingerprint = row?.fingerprint ?? '';
    if (row) {
      if (size < row.offset) {
        // 文件变小：被截断或重写，从头解析，靠去重键保证不重复
        start = 0;
      } else if (row.offset > 0 && row.fingerprint) {
        let ok = true;
        try {
          ok = await this.checkFingerprint(f.path, row.offset, row.fingerprint);
        } catch {
          return false; // 文件暂时读不了，下次再试
        }
        if (!ok) start = 0; // 原地重写
      }
      if (start === 0) skipped = 0;
    }
    let pending = start === 0 ? parsePending(null) : parsePending(row?.pending_tools);
    if (start >= size) {
      this.store.touchFile(f.path, size, mtimeMs);
      return false;
    }
    const isMain = f.agent === 'main';
    let changed = false;
    const acceptTrailing = Date.now() - mtimeMs > TRAILING_GRACE_MS;
    try {
      await readLines(
        f.path,
        start,
        size,
        (lines, offsetAfter, tail) => {
          const batch = new LineBatch(isMain, pending);
          for (const l of lines) batch.addLine(l);
          pending = batch.pending;
          skipped += batch.badLines;
          if (batch.minTs && (!firstTs || batch.minTs < firstTs)) firstTs = batch.minTs;
          if (batch.maxTs && (!lastTs || batch.maxTs > lastTs)) lastTs = batch.maxTs;
          fingerprint = tail;
          const fileRow: Omit<FileRow, 'present'> = {
            path: f.path,
            session_id: f.sessionId,
            project_dir: f.projectDir,
            agent: f.agent,
            // 中途的批次不写真实大小，崩溃后下次会继续读
            size: -1,
            mtime_ms: -1,
            offset: offsetAfter,
            fingerprint,
            skipped,
            first_ts: firstTs,
            last_ts: lastTs,
            pending_tools: JSON.stringify(pending),
          };
          this.store.commitBatch(fileRow, batch);
          if (!batch.isEmpty) changed = true;
        },
        { acceptTrailing },
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EBUSY') console.error(`[agentree] 读取失败 ${f.path}`, e);
      return changed;
    }
    // 全部读完（剩下的半行留到下次）才记录真实的大小和修改时间
    if (!this.store.getFile(f.path)) {
      this.store.commitBatch(
        { path: f.path, session_id: f.sessionId, project_dir: f.projectDir, agent: f.agent, size, mtime_ms: mtimeMs, offset: start, fingerprint, skipped, first_ts: firstTs, last_ts: lastTs, pending_tools: JSON.stringify(pending) },
        new LineBatch(isMain, pending),
      );
    } else {
      this.store.touchFile(f.path, size, mtimeMs);
    }
    if (changed || !row) this.bump(f.sessionId);
    return changed;
  }

  private async checkFingerprint(filePath: string, offset: number, fp: string): Promise<boolean> {
    const sep = fp.indexOf(':');
    const len = Number(fp.slice(0, sep));
    const expect = fp.slice(sep + 1);
    if (!len) return true;
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset - len);
      return bytesRead === len && buf.toString('base64') === expect;
    } finally {
      await fh.close();
    }
  }
}

// SQLite 持久化（node:sqlite）。数据只增不删：日志被清理后已入库的数据保留。
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { agentreeHome } from './config.ts';
import type { LineBatch } from './parser.ts';

export const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  agent TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  skipped INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  pending_tools TEXT
);
CREATE INDEX IF NOT EXISTS files_session ON files(session_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  cwd TEXT,
  entrypoint TEXT,
  version TEXT,
  git_branch TEXT,
  custom_title TEXT,
  ai_title TEXT,
  first_prompt TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  ts TEXT,
  day TEXT,
  effort TEXT,
  advisor_model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  cw5m INTEGER NOT NULL DEFAULT 0,
  cw1h INTEGER NOT NULL DEFAULT 0,
  advisor_calls INTEGER NOT NULL DEFAULT 0,
  -- 回复计时（v6）：prompt_ts 是这次回复第一块之前最近的一条用户记录或上一次回复的时间，end_ts 是最后一块完成的时间。
  -- end_ts - prompt_ts 是整次回复的耗时。max_gap_ms 是这次回复里最长的一段没有输出的时间（起点到第一块、相邻两块之间的最大间隔），
  -- gap_ts 是结束这段沉默的那一块的时间
  prompt_ts TEXT,
  end_ts TEXT,
  max_gap_ms INTEGER,
  gap_ts TEXT,
  PRIMARY KEY (session_id, key)
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_session_agent ON requests(session_id, agent);

CREATE TABLE IF NOT EXISTS advisor_usage (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  cw5m INTEGER NOT NULL DEFAULT 0,
  cw1h INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, key, idx)
);

CREATE TABLE IF NOT EXISTS tool_uses (
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  ts TEXT,
  subagent_type TEXT,
  description TEXT,
  model TEXT,
  background INTEGER,
  PRIMARY KEY (session_id, agent, id)
);
CREATE INDEX IF NOT EXISTS tool_uses_id ON tool_uses(session_id, id);

CREATE TABLE IF NOT EXISTS agent_results (
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT,
  is_async INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL,
  resolved_model TEXT,
  agent_type TEXT,
  description TEXT,
  ts TEXT,
  PRIMARY KEY (session_id, tool_use_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  ts TEXT,
  PRIMARY KEY (session_id, task_id, status)
);

CREATE TABLE IF NOT EXISTS agent_meta (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_type TEXT,
  description TEXT,
  tool_use_id TEXT,
  spawn_depth INTEGER,
  model TEXT,
  request_shape TEXT,
  PRIMARY KEY (session_id, agent_id)
);

-- 会话可用的 agent 类型清单（日志里的 agent_listing_delta，主会话和子 agent 的日志都算）。
-- 一个会话里某个类型只要加入过就算这个会话加载过它；removed_at 是之后被移除的时间（再次加入时清空）
CREATE TABLE IF NOT EXISTS agent_listings (
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  first_added_at TEXT,
  last_added_at TEXT,
  removed_at TEXT,
  PRIMARY KEY (session_id, agent_type)
);

-- 上下文压缩（日志里的 compact_boundary 记录）。agent 是发生压缩的对话：'main' 或子 agent id；
-- trigger 为 auto / manual / unknown，pre_tokens 是压缩前的上下文 token 数（不知道为 NULL）
CREATE TABLE IF NOT EXISTS compactions (
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  key TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'unknown',
  pre_tokens INTEGER,
  ts TEXT,
  PRIMARY KEY (session_id, agent, key)
);

-- 用户按中断的标记（type 为 user、内容为 [Request interrupted by user...] 的记录）。只记时间，不存内容。
-- wait_ms 是中断前已经等了多久：中断标记的时间 - 它之前最近的一条用户记录或回复块的时间
CREATE TABLE IF NOT EXISTS interrupts (
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  key TEXT NOT NULL,
  ts TEXT,
  wait_ms INTEGER,
  PRIMARY KEY (session_id, agent, key)
);
`;

export interface FileRow {
  path: string;
  session_id: string;
  project_dir: string;
  agent: string;
  size: number;
  mtime_ms: number;
  offset: number;
  fingerprint: string;
  skipped: number;
  first_ts: string | null;
  last_ts: string | null;
  present: number;
  /** 文件末尾还在等结果的 tool_use（JSON，见 parser.PendingTools） */
  pending_tools: string | null;
}

export interface MetaRow {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  model: string | null;
  requestShape: string | null;
}

function localDay(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export class Store {
  readonly db: DatabaseSync;
  private st: Record<string, StatementSync> = {};

  constructor(dbPath = path.join(agentreeHome(), 'agentree.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    const ver = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (ver >= 1 && ver <= 6) {
      // v5 -> v6：requests 增加回复计时的四列（interrupts 表由下面的 SCHEMA 建）。v1 到 v5 的各分支都会重置读取进度，重读时补上。
      // v6 在开发过程中改过（加了 max_gap_ms、gap_ts 和 interrupts.wait_ms）：缺列的开发版 v6 库补列后同样从头重读
      const colsOf = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      let added = false;
      const cols = colsOf('requests');
      for (const [c, type] of [['prompt_ts', 'TEXT'], ['end_ts', 'TEXT'], ['max_gap_ms', 'INTEGER'], ['gap_ts', 'TEXT']]) {
        if (!cols.includes(c)) {
          this.db.exec(`ALTER TABLE requests ADD COLUMN ${c} ${type};`);
          added = true;
        }
      }
      const icols = colsOf('interrupts');
      if (icols.length > 0 && !icols.includes('wait_ms')) {
        this.db.exec('ALTER TABLE interrupts ADD COLUMN wait_ms INTEGER;');
        added = true;
      }
      if (ver === 6 && added) this.db.exec(`UPDATE files SET offset = 0, size = -1, mtime_ms = -1, fingerprint = '' WHERE present = 1;`);
    }
    if (ver === 1 || ver === 2) {
      if (ver === 1) {
        // v1 -> v2：files 增加 pending_tools。已有文件需要从头重读一遍才能得到这个状态；
        // 只重置读取进度，不删已入库的数据（去重键保证重读不会重复计数）
        this.db.exec('ALTER TABLE files ADD COLUMN pending_tools TEXT;');
      }
      // v2 -> v3：sessions.cwd 的含义从"最后一次的目录"改为"会话开始时的目录"。
      // 日志还在的会话清掉旧值后重读；日志已经被清理的会话没法重读，保留旧值，总比没有好
      this.db.exec(`UPDATE sessions SET cwd = NULL
          WHERE session_id IN (SELECT session_id FROM files WHERE present = 1 AND agent = 'main');
        UPDATE files SET offset = 0, size = -1, mtime_ms = -1, fingerprint = '' WHERE present = 1;`);
      // （这里的重读同时补上 v4 的 agent_listings、v5 的 compactions 和 v6 的回复计时、中断）
    } else if (ver === 3 || ver === 4 || ver === 5) {
      // v3 -> v4：新增 agent_listings；v4 -> v5：新增 compactions；v5 -> v6：回复计时和中断。日志还在的文件重置读取进度，从头重读一遍补上这些表；
      // 已入库的数据不删（去重键保证重读不会重复计数），日志已经被清理的文件（present = 0）不动，它们的统计原样保留
      this.db.exec(`UPDATE files SET offset = 0, size = -1, mtime_ms = -1, fingerprint = '' WHERE present = 1;`);
    } else if (ver !== 0 && ver !== SCHEMA_VERSION) {
      // 不认识的版本：重建
      for (const t of ['files', 'sessions', 'requests', 'advisor_usage', 'tool_uses', 'agent_results', 'notifications', 'agent_meta', 'agent_listings', 'compactions', 'interrupts']) {
        this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      }
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.prepare();
  }

  private prepare() {
    const p = (k: string, sql: string) => (this.st[k] = this.db.prepare(sql));
    p('getFile', 'SELECT * FROM files WHERE path = ?');
    p(
      'upsertFile',
      `INSERT INTO files (path, session_id, project_dir, agent, size, mtime_ms, offset, fingerprint, skipped, first_ts, last_ts, present, pending_tools)
       VALUES (@path, @session_id, @project_dir, @agent, @size, @mtime_ms, @offset, @fingerprint, @skipped, @first_ts, @last_ts, 1, @pending_tools)
       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, offset=excluded.offset,
         fingerprint=excluded.fingerprint, skipped=excluded.skipped, first_ts=excluded.first_ts, last_ts=excluded.last_ts, present=1,
         pending_tools=excluded.pending_tools`,
    );
    p('touchFile', 'UPDATE files SET size = ?, mtime_ms = ?, present = 1 WHERE path = ?');
    p('markMissing', 'UPDATE files SET present = 0 WHERE path = ?');
    p(
      'upsertSession',
      `INSERT INTO sessions (session_id, project_dir, cwd, entrypoint, version, git_branch, custom_title, ai_title, first_prompt)
       VALUES (@session_id, @project_dir, @cwd, @entrypoint, @version, @git_branch, @custom_title, @ai_title, @first_prompt)
       ON CONFLICT(session_id) DO UPDATE SET
         project_dir = excluded.project_dir,
         cwd = COALESCE(sessions.cwd, excluded.cwd),
         entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint),
         version = COALESCE(excluded.version, sessions.version),
         git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
         custom_title = COALESCE(excluded.custom_title, sessions.custom_title),
         ai_title = COALESCE(excluded.ai_title, sessions.ai_title),
         first_prompt = COALESCE(sessions.first_prompt, excluded.first_prompt)`,
    );
    p('ensureSession', `INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`);
    // 去重：同一会话同一去重键逐字段取最大值；主文件优先拥有该请求
    p(
      'upsertRequest',
      `INSERT INTO requests (session_id, key, agent, model, ts, day, effort, advisor_model, input, output, cache_read, cache_create, cw5m, cw1h, advisor_calls, prompt_ts, end_ts, max_gap_ms, gap_ts)
       VALUES (@session_id, @key, @agent, @model, @ts, @day, @effort, @advisor_model, @input, @output, @cache_read, @cache_create, @cw5m, @cw1h, @advisor_calls, @prompt_ts, @end_ts, @max_gap_ms, @gap_ts)
       ON CONFLICT(session_id, key) DO UPDATE SET
         agent = CASE WHEN excluded.agent = 'main' THEN 'main' ELSE requests.agent END,
         model = CASE WHEN requests.model IS NULL OR (requests.model = '<synthetic>' AND excluded.model IS NOT NULL) THEN excluded.model ELSE requests.model END,
         ts = CASE WHEN requests.ts IS NULL OR (excluded.ts IS NOT NULL AND excluded.ts < requests.ts) THEN excluded.ts ELSE requests.ts END,
         day = CASE WHEN requests.ts IS NULL OR (excluded.ts IS NOT NULL AND excluded.ts < requests.ts) THEN excluded.day ELSE requests.day END,
         effort = COALESCE(requests.effort, excluded.effort),
         advisor_model = COALESCE(requests.advisor_model, excluded.advisor_model),
         input = MAX(requests.input, excluded.input),
         output = MAX(requests.output, excluded.output),
         cache_read = MAX(requests.cache_read, excluded.cache_read),
         cache_create = MAX(requests.cache_create, excluded.cache_create),
         cw5m = MAX(requests.cw5m, excluded.cw5m),
         cw1h = MAX(requests.cw1h, excluded.cw1h),
         advisor_calls = MAX(requests.advisor_calls, excluded.advisor_calls),
         prompt_ts = CASE WHEN requests.prompt_ts IS NULL OR (excluded.prompt_ts IS NOT NULL AND excluded.prompt_ts < requests.prompt_ts) THEN excluded.prompt_ts ELSE requests.prompt_ts END,
         end_ts = CASE WHEN requests.end_ts IS NULL OR (excluded.end_ts IS NOT NULL AND excluded.end_ts > requests.end_ts) THEN excluded.end_ts ELSE requests.end_ts END,
         gap_ts = CASE WHEN excluded.max_gap_ms IS NOT NULL AND (requests.max_gap_ms IS NULL OR excluded.max_gap_ms > requests.max_gap_ms) THEN excluded.gap_ts ELSE requests.gap_ts END,
         max_gap_ms = CASE WHEN excluded.max_gap_ms IS NOT NULL AND (requests.max_gap_ms IS NULL OR excluded.max_gap_ms > requests.max_gap_ms) THEN excluded.max_gap_ms ELSE requests.max_gap_ms END`,
    );
    p(
      'upsertAdvisor',
      `INSERT INTO advisor_usage (session_id, key, idx, model, input, output, cache_read, cache_create, cw5m, cw1h)
       VALUES (@session_id, @key, @idx, @model, @input, @output, @cache_read, @cache_create, @cw5m, @cw1h)
       ON CONFLICT(session_id, key, idx) DO UPDATE SET
         model = COALESCE(advisor_usage.model, excluded.model),
         input = MAX(advisor_usage.input, excluded.input),
         output = MAX(advisor_usage.output, excluded.output),
         cache_read = MAX(advisor_usage.cache_read, excluded.cache_read),
         cache_create = MAX(advisor_usage.cache_create, excluded.cache_create),
         cw5m = MAX(advisor_usage.cw5m, excluded.cw5m),
         cw1h = MAX(advisor_usage.cw1h, excluded.cw1h)`,
    );
    p(
      'upsertToolUse',
      `INSERT OR IGNORE INTO tool_uses (session_id, agent, id, name, ts, subagent_type, description, model, background)
       VALUES (@session_id, @agent, @id, @name, @ts, @subagent_type, @description, @model, @background)`,
    );
    p(
      'upsertResult',
      `INSERT INTO agent_results (session_id, agent, tool_use_id, agent_id, status, is_async, duration_ms, resolved_model, agent_type, description, ts)
       VALUES (@session_id, @agent, @tool_use_id, @agent_id, @status, @is_async, @duration_ms, @resolved_model, @agent_type, @description, @ts)
       ON CONFLICT(session_id, tool_use_id) DO UPDATE SET agent=excluded.agent, agent_id=excluded.agent_id, status=excluded.status,
         is_async=excluded.is_async, duration_ms=excluded.duration_ms, resolved_model=COALESCE(excluded.resolved_model, agent_results.resolved_model),
         agent_type=COALESCE(excluded.agent_type, agent_results.agent_type), description=COALESCE(excluded.description, agent_results.description), ts=excluded.ts`,
    );
    p(
      'upsertNotification',
      `INSERT INTO notifications (session_id, agent, task_id, status, ts) VALUES (@session_id, @agent, @task_id, @status, @ts)
       ON CONFLICT(session_id, task_id, status) DO UPDATE SET ts = CASE WHEN notifications.ts IS NULL OR excluded.ts > notifications.ts THEN excluded.ts ELSE notifications.ts END`,
    );
    p(
      'upsertMeta',
      `INSERT INTO agent_meta (session_id, agent_id, agent_type, description, tool_use_id, spawn_depth, model, request_shape)
       VALUES (@session_id, @agent_id, @agent_type, @description, @tool_use_id, @spawn_depth, @model, @request_shape)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET agent_type=excluded.agent_type, description=excluded.description,
         tool_use_id=excluded.tool_use_id, spawn_depth=excluded.spawn_depth, model=excluded.model, request_shape=excluded.request_shape`,
    );
    // 清单：加入取最早 / 最晚时间；晚于上次移除的加入会清掉移除标记。重读同样的记录结果不变
    p(
      'listingAdd',
      `INSERT INTO agent_listings (session_id, agent_type, first_added_at, last_added_at, removed_at) VALUES (@session_id, @agent_type, @ts, @ts, NULL)
       ON CONFLICT(session_id, agent_type) DO UPDATE SET
         first_added_at = CASE WHEN agent_listings.first_added_at IS NULL OR (excluded.first_added_at IS NOT NULL AND excluded.first_added_at < agent_listings.first_added_at) THEN excluded.first_added_at ELSE agent_listings.first_added_at END,
         last_added_at = CASE WHEN agent_listings.last_added_at IS NULL OR (excluded.last_added_at IS NOT NULL AND excluded.last_added_at > agent_listings.last_added_at) THEN excluded.last_added_at ELSE agent_listings.last_added_at END,
         removed_at = CASE WHEN agent_listings.removed_at IS NOT NULL AND excluded.last_added_at IS NOT NULL AND excluded.last_added_at > agent_listings.removed_at THEN NULL ELSE agent_listings.removed_at END`,
    );
    // 压缩：重读同一条记录时，已知的触发方式和 token 数不被 unknown / NULL 覆盖
    p(
      'upsertCompaction',
      `INSERT INTO compactions (session_id, agent, key, trigger, pre_tokens, ts) VALUES (@session_id, @agent, @key, @trigger, @pre_tokens, @ts)
       ON CONFLICT(session_id, agent, key) DO UPDATE SET
         trigger = CASE WHEN compactions.trigger = 'unknown' THEN excluded.trigger ELSE compactions.trigger END,
         pre_tokens = COALESCE(compactions.pre_tokens, excluded.pre_tokens),
         ts = COALESCE(compactions.ts, excluded.ts)`,
    );
    // 中断：同一条记录重读不重复计数
    p(
      'upsertInterrupt',
      `INSERT INTO interrupts (session_id, agent, key, ts, wait_ms) VALUES (@session_id, @agent, @key, @ts, @wait_ms)
       ON CONFLICT(session_id, agent, key) DO UPDATE SET ts = COALESCE(interrupts.ts, excluded.ts), wait_ms = COALESCE(interrupts.wait_ms, excluded.wait_ms)`,
    );
    // 移除：只记在加入之后的移除；没加入过的类型不记
    p(
      'listingRemove',
      `UPDATE agent_listings SET removed_at = @ts
       WHERE session_id = @session_id AND agent_type = @agent_type AND @ts IS NOT NULL
         AND (removed_at IS NULL OR removed_at < @ts) AND (last_added_at IS NULL OR last_added_at <= @ts)`,
    );
  }

  getFile(filePath: string): FileRow | undefined {
    return this.st.getFile.get(filePath) as unknown as FileRow | undefined;
  }

  touchFile(filePath: string, size: number, mtimeMs: number) {
    this.st.touchFile.run(size, mtimeMs, filePath);
  }

  markMissing(filePath: string) {
    this.st.markMissing.run(filePath);
  }

  allFiles(): FileRow[] {
    return this.db.prepare('SELECT * FROM files').all() as unknown as FileRow[];
  }

  upsertMeta(sessionId: string, agentId: string, m: MetaRow) {
    this.st.upsertMeta.run({
      session_id: sessionId,
      agent_id: agentId,
      agent_type: m.agentType,
      description: m.description,
      tool_use_id: m.toolUseId,
      spawn_depth: m.spawnDepth,
      model: m.model,
      request_shape: m.requestShape,
    });
  }

  getMeta(sessionId: string, agentId: string): MetaRow | undefined {
    const r = this.db
      .prepare('SELECT agent_type, description, tool_use_id, spawn_depth, model, request_shape FROM agent_meta WHERE session_id = ? AND agent_id = ?')
      .get(sessionId, agentId) as any;
    if (!r) return undefined;
    return {
      agentType: r.agent_type,
      description: r.description,
      toolUseId: r.tool_use_id,
      spawnDepth: r.spawn_depth,
      model: r.model,
      requestShape: r.request_shape,
    };
  }

  /** 一批解析结果和新的文件状态在同一个事务里落库，保证偏移量与数据一致 */
  commitBatch(file: Omit<FileRow, 'present'>, batch: LineBatch) {
    const sid = file.session_id;
    const agent = file.agent;
    this.db.exec('BEGIN');
    try {
      this.st.ensureSession.run(sid, file.project_dir);
      if (batch.isMain) {
        const s = batch.session;
        this.st.upsertSession.run({
          session_id: sid,
          project_dir: file.project_dir,
          cwd: s.cwd,
          entrypoint: s.entrypoint,
          version: s.version,
          git_branch: s.gitBranch,
          custom_title: s.customTitle,
          ai_title: s.aiTitle,
          first_prompt: s.firstPrompt,
        });
      }
      for (const r of batch.requests.values()) {
        this.st.upsertRequest.run({
          session_id: sid,
          key: r.key,
          agent,
          model: r.model,
          ts: r.ts,
          day: localDay(r.ts),
          effort: r.effort,
          advisor_model: r.advisorModel,
          input: r.usage.input,
          output: r.usage.output,
          cache_read: r.usage.cacheRead,
          cache_create: r.usage.cacheCreate,
          cw5m: r.usage.cw5m,
          cw1h: r.usage.cw1h,
          advisor_calls: r.advisor.length,
          prompt_ts: r.promptTs,
          end_ts: r.endTs,
          max_gap_ms: r.maxGapMs,
          gap_ts: r.gapTs,
        });
        for (const a of r.advisor) {
          this.st.upsertAdvisor.run({
            session_id: sid,
            key: r.key,
            idx: a.idx,
            model: a.model,
            input: a.usage.input,
            output: a.usage.output,
            cache_read: a.usage.cacheRead,
            cache_create: a.usage.cacheCreate,
            cw5m: a.usage.cw5m,
            cw1h: a.usage.cw1h,
          });
        }
      }
      for (const t of batch.toolUses.values()) {
        this.st.upsertToolUse.run({
          session_id: sid,
          agent,
          id: t.id,
          name: t.name,
          ts: t.ts,
          subagent_type: t.subagentType,
          description: t.description,
          model: t.model,
          background: t.background === null ? null : t.background ? 1 : 0,
        });
      }
      for (const r of batch.results.values()) {
        this.st.upsertResult.run({
          session_id: sid,
          agent,
          tool_use_id: r.toolUseId,
          agent_id: r.agentId,
          status: r.status,
          is_async: r.isAsync ? 1 : 0,
          duration_ms: r.durationMs,
          resolved_model: r.resolvedModel,
          agent_type: r.agentType,
          description: r.description,
          ts: r.ts,
        });
      }
      for (const n of batch.notifications) {
        this.st.upsertNotification.run({ session_id: sid, agent, task_id: n.taskId, status: n.status, ts: n.ts });
      }
      for (const l of batch.listings) {
        for (const t of l.added) this.st.listingAdd.run({ session_id: sid, agent_type: t, ts: l.ts });
        for (const t of l.removed) this.st.listingRemove.run({ session_id: sid, agent_type: t, ts: l.ts });
      }
      for (const c of batch.compactions) {
        this.st.upsertCompaction.run({ session_id: sid, agent, key: c.key, trigger: c.trigger, pre_tokens: c.preTokens, ts: c.ts });
      }
      for (const x of batch.interrupts) {
        this.st.upsertInterrupt.run({ session_id: sid, agent, key: x.key, ts: x.ts, wait_ms: x.waitMs });
      }
      this.st.upsertFile.run({ ...file });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

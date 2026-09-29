// 从数据库还原会话：agent 树、按 agent / 模型统计、状态、一致性。接口不返回任何消息正文。
import type {
  AgentNode,
  AgentStatus,
  AgentTypeUsage,
  ConformanceCheck,
  ConformanceVerdict,
  DailyPoint,
  LiveAgent,
  LiveSession,
  LiveState,
  ModelUsage,
  Overview,
  SessionDetail,
  SessionSummary,
  TokenTotals,
} from '../../shared/types.ts';
import { ACTIVE_WINDOW_MS } from './config.ts';
import { mainConformance, sessionChecks, subagentConformance } from './conformance.ts';
import type { MetaRow, Store } from './db.ts';
import type { Desktop } from './desktop.ts';
import type { Indexer } from './indexer.ts';
import { AGENT_TOOL_NAMES, parsePending } from './parser.ts';
import { agentStatus, isLive, PENDING_TOOL_WINDOW_MS } from './status.ts';
import type { PresetStore } from './preset.ts';
import type { Pricing } from './pricing.ts';
import { resolveTree, type LinkMethod, type ResultLoc, type ToolUseLoc } from './tree.ts';
import { addTokens, CostAcc, makeTokens, mergeModelUsages, sortModels, zeroTokens } from './tokens.ts';

/** 请求被计入的条件：四项 token 任一大于 0，且不是 <synthetic> */
const COUNTED = `(model IS NULL OR model <> '<synthetic>') AND (input + output + cache_read + cache_create) > 0`;
const UNKNOWN_MODEL = '(unknown)';

interface AgentExtra {
  lastModel: string | null;
  lastEffort: string | null;
  currentTool: string | null;
  lastActivityMs: number | null;
  /** 文件最后一条记录是否是还没拿到结果的 tool_use */
  pendingTool: boolean;
  link: LinkMethod | null;
}

interface Computed {
  detail: SessionDetail;
  extras: Map<string, AgentExtra>;
  /** 各 agent 的类型，用于总览按类型汇总 */
  types: Map<string, string>;
  computedAt: number;
  validUntil: number;
  key: string;
}

function tsMs(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class Analyzer {
  private cache = new Map<string, Computed>();

  constructor(
    private store: Store,
    private indexer: Indexer,
    readonly pricing: Pricing,
    private desktop: Desktop,
    private presets: PresetStore,
  ) {}

  private costOf = (model: string, t: TokenTotals) => this.pricing.cost(model, t);

  private cacheKey(sid: string): string {
    return `${this.indexer.sessionVersions.get(sid) ?? 0}|${this.presets.version}|${this.pricing.version}|${this.desktop.version}`;
  }

  sessionIds(): string[] {
    return (this.store.db.prepare('SELECT session_id FROM sessions').all() as Array<{ session_id: string }>).map((r) => r.session_id);
  }

  private computed(sid: string, now = Date.now()): Computed | null {
    const key = this.cacheKey(sid);
    const c = this.cache.get(sid);
    if (c && c.key === key && now < c.validUntil) return c;
    const fresh = this.compute(sid, now);
    if (fresh) this.cache.set(sid, { ...fresh, key });
    else this.cache.delete(sid);
    return fresh ? { ...fresh, key } : null;
  }

  sessionDetail(sid: string): SessionDetail | null {
    return this.computed(sid)?.detail ?? null;
  }

  private compute(sid: string, now: number): Omit<Computed, 'key'> | null {
    const db = this.store.db;
    const sess = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid) as any;
    if (!sess) return null;
    // 会话按哪份方案检查：属于某个项目方案时用项目方案叠在全局方案上的结果
    const { ref: scheme, preset } = this.presets.schemeFor(sess.cwd ?? null);

    // ---------- 文件：活跃时间与时间范围 ----------
    const fileRows = db
      .prepare('SELECT path, agent, mtime_ms, first_ts, last_ts, pending_tools FROM files WHERE session_id = ?')
      .all(sid) as Array<{ path: string; agent: string; mtime_ms: number; first_ts: string | null; last_ts: string | null; pending_tools: string | null }>;
    const fileInfo = new Map<string, { mtime: number | null; first: string | null; last: string | null; pending: boolean }>();
    for (const f of fileRows) {
      // 最近写入时间：文件修改时间、本进程观察到文件变大的时间、最后一条记录的时间戳，取最大
      let m = this.indexer.mtimeOf(f.path) ?? (f.mtime_ms > 0 ? f.mtime_ms : null);
      const lastRec = tsMs(f.last_ts);
      if (lastRec !== null && (m === null || lastRec > m)) m = Math.min(lastRec, now);
      const pending = parsePending(f.pending_tools).ids.length > 0;
      const prev = fileInfo.get(f.agent);
      if (!prev) fileInfo.set(f.agent, { mtime: m, first: f.first_ts, last: f.last_ts, pending });
      else {
        if (m !== null && (prev.mtime === null || m > prev.mtime)) {
          prev.mtime = m;
          prev.pending = pending;
        }
        if (f.first_ts && (!prev.first || f.first_ts < prev.first)) prev.first = f.first_ts;
        if (f.last_ts && (!prev.last || f.last_ts > prev.last)) prev.last = f.last_ts;
      }
    }

    // ---------- 请求：按 agent × 模型 ----------
    const reqRows = db
      .prepare(
        `SELECT agent, model, COUNT(*) AS n, SUM(input) AS i, SUM(output) AS o, SUM(cache_read) AS cr, SUM(cw5m) AS c5, SUM(cw1h) AS c1
         FROM requests WHERE session_id = ? AND ${COUNTED} GROUP BY agent, model`,
      )
      .all(sid) as Array<{ agent: string; model: string | null; n: number; i: number; o: number; cr: number; c5: number; c1: number }>;
    const advRows = db
      .prepare(
        `SELECT r.agent AS agent, a.model AS model, COUNT(*) AS n, SUM(a.input) AS i, SUM(a.output) AS o, SUM(a.cache_read) AS cr, SUM(a.cw5m) AS c5, SUM(a.cw1h) AS c1
         FROM advisor_usage a JOIN requests r ON r.session_id = a.session_id AND r.key = a.key
         WHERE a.session_id = ? GROUP BY r.agent, a.model`,
      )
      .all(sid) as Array<{ agent: string; model: string | null; n: number; i: number; o: number; cr: number; c5: number; c1: number }>;
    const effRows = db
      .prepare(
        `SELECT agent, effort, MIN(ts) AS t FROM requests WHERE session_id = ? AND effort IS NOT NULL GROUP BY agent, effort ORDER BY t`,
      )
      .all(sid) as Array<{ agent: string; effort: string }>;
    const lastRows = db
      .prepare(
        `SELECT agent, model, effort, MAX(ts) AS t FROM requests WHERE session_id = ? AND ${COUNTED} GROUP BY agent`,
      )
      .all(sid) as Array<{ agent: string; model: string | null; effort: string | null; t: string | null }>;
    const advModelRows = db
      .prepare(
        `SELECT agent, advisor_model, MAX(ts) AS t FROM requests WHERE session_id = ? AND advisor_model IS NOT NULL GROUP BY agent`,
      )
      .all(sid) as Array<{ agent: string; advisor_model: string }>;
    const toolCountRows = db
      .prepare(`SELECT agent, COUNT(*) AS n FROM tool_uses WHERE session_id = ? GROUP BY agent`)
      .all(sid) as Array<{ agent: string; n: number }>;
    const lastToolRows = db
      .prepare(`SELECT agent, name, MAX(ts) AS t FROM tool_uses WHERE session_id = ? GROUP BY agent`)
      .all(sid) as Array<{ agent: string; name: string }>;
    const agentToolRows = db
      .prepare(`SELECT * FROM tool_uses WHERE session_id = ? AND name IN ('Agent', 'Task')`)
      .all(sid) as any[];
    const resultRows = db.prepare(`SELECT * FROM agent_results WHERE session_id = ?`).all(sid) as any[];
    const notifRows = db
      .prepare(`SELECT task_id, status, MAX(ts) AS ts FROM notifications WHERE session_id = ? GROUP BY task_id, status`)
      .all(sid) as Array<{ task_id: string; status: string; ts: string | null }>;
    const metaRows = db.prepare(`SELECT * FROM agent_meta WHERE session_id = ?`).all(sid) as any[];

    // ---------- 建树输入 ----------
    const toolUses = new Map<string, ToolUseLoc>();
    const addToolUse = (r: any) => {
      const loc: ToolUseLoc = {
        agent: r.agent,
        id: r.id,
        name: r.name,
        ts: r.ts,
        subagentType: r.subagent_type,
        description: r.description,
        model: r.model,
        background: r.background === null ? null : r.background === 1,
      };
      const prev = toolUses.get(r.id);
      // 同一个 tool_use 出现在多个文件时算主文件的
      if (!prev || (prev.agent !== 'main' && r.agent === 'main')) toolUses.set(r.id, loc);
    };
    for (const r of agentToolRows) addToolUse(r);
    const metas = new Map<string, MetaRow>();
    for (const m of metaRows) {
      metas.set(m.agent_id, {
        agentType: m.agent_type,
        description: m.description,
        toolUseId: m.tool_use_id,
        spawnDepth: m.spawn_depth,
        model: m.model,
        requestShape: m.request_shape,
      });
    }
    // meta / 结果引用了但不是 Agent/Task 名字的 tool_use（兼容以后改名）
    const wanted = new Set<string>();
    for (const m of metas.values()) if (m.toolUseId && !toolUses.has(m.toolUseId)) wanted.add(m.toolUseId);
    for (const r of resultRows) if (!toolUses.has(r.tool_use_id)) wanted.add(r.tool_use_id);
    if (wanted.size) {
      const q = db.prepare('SELECT * FROM tool_uses WHERE session_id = ? AND id = ?');
      for (const id of wanted) for (const r of q.all(sid, id) as any[]) addToolUse(r);
    }
    const results = new Map<string, ResultLoc[]>();
    for (const r of resultRows) {
      const loc: ResultLoc = {
        agent: r.agent,
        toolUseId: r.tool_use_id,
        agentId: r.agent_id,
        status: r.status,
        isAsync: r.is_async === 1,
        durationMs: r.duration_ms,
        resolvedModel: r.resolved_model,
        agentType: r.agent_type,
        description: r.description,
        ts: r.ts,
      };
      const list = results.get(r.agent_id) ?? [];
      list.push(loc);
      results.set(r.agent_id, list);
    }

    const ids = new Set<string>();
    for (const a of fileInfo.keys()) if (a !== 'main') ids.add(a);
    for (const a of metas.keys()) ids.add(a);
    for (const r of resultRows) {
      const tu = toolUses.get(r.tool_use_id);
      if (tu && AGENT_TOOL_NAMES.has(tu.name)) ids.add(r.agent_id);
    }
    ids.delete('main');
    const agentIds = [...ids];
    const links = resolveTree({ agentIds, metas, toolUses, results });

    // ---------- 每个 agent 自己的统计 ----------
    const models = new Map<string, ModelUsage[]>();
    const selfReq = new Map<string, number>();
    for (const r of reqRows) {
      const t = makeTokens(r.i, r.o, r.cr, r.c5, r.c1);
      const model = r.model ?? UNKNOWN_MODEL;
      const list = models.get(r.agent) ?? [];
      list.push({ model, requests: r.n, tokens: t, costUsd: this.costOf(model, t) });
      models.set(r.agent, list);
      selfReq.set(r.agent, (selfReq.get(r.agent) ?? 0) + r.n);
    }
    // advisor 的用量不在顶层 usage 里，单独按 advisor 模型记；requests 记为 advisor 调用次数
    const advisorCalls = new Map<string, number>();
    for (const r of advRows) {
      advisorCalls.set(r.agent, (advisorCalls.get(r.agent) ?? 0) + r.n);
      const t = makeTokens(r.i, r.o, r.cr, r.c5, r.c1);
      if (t.total === 0) continue;
      const model = r.model ?? UNKNOWN_MODEL;
      const list = models.get(r.agent) ?? [];
      const existing = list.find((m) => m.model === model);
      if (existing) {
        existing.tokens = addTokens(existing.tokens, t);
        existing.costUsd = this.costOf(model, existing.tokens);
      } else list.push({ model, requests: 0, tokens: t, costUsd: this.costOf(model, t) });
      models.set(r.agent, list);
    }
    const efforts = new Map<string, string[]>();
    for (const r of effRows) {
      const list = efforts.get(r.agent) ?? [];
      if (!list.includes(r.effort)) list.push(r.effort);
      efforts.set(r.agent, list);
    }
    const last = new Map(lastRows.map((r) => [r.agent, r]));
    const advModel = new Map(advModelRows.map((r) => [r.agent, r.advisor_model]));
    const toolCount = new Map(toolCountRows.map((r) => [r.agent, r.n]));
    const lastTool = new Map(lastToolRows.map((r) => [r.agent, r.name]));
    const notif = new Map<string, { status: string; ts: string | null }>();
    for (const n of notifRows) {
      const prev = notif.get(n.task_id);
      if (!prev || (n.ts ?? '') > (prev.ts ?? '')) notif.set(n.task_id, { status: n.status, ts: n.ts });
    }

    const primaryOf = (list: ModelUsage[]): string | null => {
      const withReq = list.filter((m) => m.requests > 0);
      if (!withReq.length) return null;
      return sortModels([...withReq])[0].model;
    };

    const nodes = new Map<string, AgentNode>();
    const extras = new Map<string, AgentExtra>();
    const selfCost = new Map<string, CostAcc>();

    const baseStats = (id: string) => {
      const list = sortModels(models.get(id) ?? []);
      let tokens = zeroTokens();
      const cost = new CostAcc();
      for (const m of list) {
        tokens = addTokens(tokens, m.tokens);
        cost.add(m.costUsd, m.tokens.total);
      }
      selfCost.set(id, cost);
      return { list, tokens, cost: cost.value };
    };

    // 主会话
    const mainInfo = fileInfo.get('main');
    // 主会话节点代表整个会话：会话里任一文件还"活着"（最近 120 秒有写入，或在等长时间工具的结果）
    // 就算运行中；子 agent 的判断见下方，主节点在子 agent 算完后再修正一次
    let sessionRunning = [...fileInfo.values()].some((f) => isLive({ now, lastWriteMs: f.mtime, pendingTool: f.pending }));
    {
      const s = baseStats('main');
      const start = tsMs(mainInfo?.first ?? null);
      const end = sessionRunning ? null : tsMs(mainInfo?.last ?? null);
      nodes.set('main', {
        id: 'main',
        kind: 'main',
        agentType: null,
        description: null,
        parentId: null,
        depth: 0,
        toolUseId: null,
        status: sessionRunning ? 'running' : mainInfo ? 'completed' : 'unknown',
        background: false,
        startedAt: iso(start),
        endedAt: iso(end),
        durationMs: start !== null ? (end ?? now) - start : null,
        requests: selfReq.get('main') ?? 0,
        toolCalls: toolCount.get('main') ?? 0,
        tokens: s.tokens,
        costUsd: s.cost,
        subtree: { agents: 0, requests: 0, toolCalls: 0, tokens: zeroTokens(), costUsd: null },
        models: s.list,
        primaryModel: primaryOf(s.list),
        efforts: efforts.get('main') ?? [],
        requestedModel: null,
        advisorModel: advModel.get('main') ?? null,
        advisorCalls: advisorCalls.get('main') ?? 0,
        conformance: { verdict: 'not-checked', presetAgent: null, checks: [] },
        children: [],
      });
      extras.set('main', {
        lastModel: last.get('main')?.model ?? null,
        lastEffort: last.get('main')?.effort ?? null,
        currentTool: lastTool.get('main') ?? null,
        lastActivityMs: mainInfo?.mtime ?? null,
        pendingTool: mainInfo?.pending ?? false,
        link: null,
      });
    }

    for (const id of agentIds) {
      const link = links.get(id)!;
      const meta = metas.get(id) ?? null;
      const tu = link.toolUse;
      const res = link.result;
      const fi = fileInfo.get(id);
      const s = baseStats(id);
      const mtime = fi?.mtime ?? null;
      const lastTsMs = tsMs(fi?.last ?? null);

      // 状态
      const { status, doneMs } = agentStatus({
        now,
        lastWriteMs: mtime,
        lastRecordMs: lastTsMs,
        pendingTool: fi?.pending ?? false,
        result: res ? { status: res.status, isAsync: res.isAsync, ts: res.ts } : null,
        notification: notif.get(id) ?? null,
      });

      const start = tsMs(fi?.first ?? null) ?? tsMs(tu?.ts ?? null);
      let end: number | null = null;
      if (status === 'completed' || status === 'failed' || status === 'stopped') end = lastTsMs ?? doneMs;
      else if (status === 'unknown') end = lastTsMs;
      let duration: number | null = null;
      if (status === 'completed' && res && !res.isAsync && typeof res.durationMs === 'number') duration = res.durationMs;
      else if (start !== null) duration = (end ?? now) - start;
      if (duration !== null && duration < 0) duration = 0;

      const agentType = meta?.agentType ?? res?.agentType ?? tu?.subagentType ?? null;
      const background = res ? res.isAsync : meta?.requestShape ? meta.requestShape === 'background' : tu?.background ?? false;

      nodes.set(id, {
        id,
        kind: 'subagent',
        agentType,
        description: meta?.description ?? tu?.description ?? res?.description ?? null,
        parentId: link.parentId,
        depth: link.depth,
        toolUseId: link.toolUseId,
        status,
        background,
        startedAt: iso(start),
        endedAt: iso(end),
        durationMs: duration,
        requests: selfReq.get(id) ?? 0,
        toolCalls: toolCount.get(id) ?? 0,
        tokens: s.tokens,
        costUsd: s.cost,
        subtree: { agents: 0, requests: 0, toolCalls: 0, tokens: zeroTokens(), costUsd: null },
        models: s.list,
        primaryModel: primaryOf(s.list),
        efforts: efforts.get(id) ?? [],
        requestedModel: tu?.model ?? meta?.model ?? null,
        advisorModel: advModel.get(id) ?? null,
        advisorCalls: advisorCalls.get(id) ?? 0,
        conformance: { verdict: 'not-checked', presetAgent: null, checks: [] },
        children: [],
      });
      extras.set(id, {
        lastModel: last.get(id)?.model ?? null,
        lastEffort: last.get(id)?.effort ?? null,
        currentTool: lastTool.get(id) ?? null,
        lastActivityMs: mtime,
        pendingTool: fi?.pending ?? false,
        link: link.link,
      });
    }

    // 有子 agent 在运行（包括在等长时间工具的结果）时，主节点也算运行中
    if (!sessionRunning && [...nodes.values()].some((n) => n.kind === 'subagent' && n.status === 'running')) {
      sessionRunning = true;
      const m = nodes.get('main')!;
      m.status = 'running';
      m.endedAt = null;
      const st = tsMs(m.startedAt);
      m.durationMs = st !== null ? now - st : null;
    }

    // 子节点，按开始时间排序
    for (const node of nodes.values()) {
      if (node.parentId) nodes.get(node.parentId)?.children.push(node.id);
    }
    for (const node of nodes.values()) {
      node.children.sort((a, b) => {
        const x = nodes.get(a)!.startedAt ?? '';
        const y = nodes.get(b)!.startedAt ?? '';
        return x.localeCompare(y) || a.localeCompare(b);
      });
    }

    // 子树汇总（含自身）
    const visit = (id: string, stack: Set<string>): { agents: number; requests: number; toolCalls: number; tokens: TokenTotals; cost: CostAcc } => {
      const node = nodes.get(id)!;
      const cost = new CostAcc();
      cost.add(node.costUsd, node.tokens.total);
      let agents = 0;
      let requests = node.requests;
      let toolCalls = node.toolCalls;
      let tokens = { ...node.tokens };
      stack.add(id);
      for (const c of node.children) {
        if (stack.has(c)) continue;
        const sub = visit(c, stack);
        agents += 1 + sub.agents;
        requests += sub.requests;
        toolCalls += sub.toolCalls;
        tokens = addTokens(tokens, sub.tokens);
        const v = sub.cost.value;
        cost.add(v, sub.tokens.total);
      }
      stack.delete(id);
      node.subtree = { agents, requests, toolCalls, tokens, costUsd: cost.value };
      return { agents, requests, toolCalls, tokens, cost };
    };
    visit('main', new Set());

    // ---------- 一致性 ----------
    const main = nodes.get('main')!;
    const mainModelsList = main.models.filter((m) => m.requests > 0).map((m) => m.model);
    let totalAdvisorCalls = 0;
    for (const n of nodes.values()) totalAdvisorCalls += n.advisorCalls;
    const sChecks = sessionChecks(preset, {
      models: mainModelsList,
      primaryModel: main.primaryModel,
      efforts: main.efforts,
      // 主会话记录上没有时，用任一子 agent 记录上的 advisorModel
      advisorModel: main.advisorModel ?? [...nodes.values()].find((n) => n.advisorModel)?.advisorModel ?? null,
      advisorCalls: totalAdvisorCalls,
    });
    main.conformance = mainConformance(preset, sChecks);
    for (const node of nodes.values()) {
      if (node.kind !== 'subagent') continue;
      node.conformance = subagentConformance(
        preset,
        {
          agentType: node.agentType,
          models: node.models.filter((m) => m.requests > 0).map((m) => m.model),
          primaryModel: node.primaryModel,
          efforts: node.efforts,
        },
        main.primaryModel,
      );
    }

    // ---------- 汇总 ----------
    const ordered: AgentNode[] = [];
    const walk = (id: string, seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      ordered.push(nodes.get(id)!);
      for (const c of nodes.get(id)!.children) walk(c, seen);
    };
    const seen = new Set<string>();
    walk('main', seen);
    for (const id of nodes.keys()) if (!seen.has(id)) walk(id, seen); // 理论上不会发生

    const sessionModels = mergeModelUsages(ordered.map((n) => n.models), this.costOf);
    const typeMap = new Map<string, { spawns: number; requests: number; tokens: TokenTotals; lists: ModelUsage[][] }>();
    const types = new Map<string, string>();
    for (const n of ordered) {
      const t = n.kind === 'main' ? 'main' : n.agentType ?? 'unknown';
      types.set(n.id, t);
      const e = typeMap.get(t) ?? { spawns: 0, requests: 0, tokens: zeroTokens(), lists: [] };
      e.spawns += 1;
      e.requests += n.requests;
      e.tokens = addTokens(e.tokens, n.tokens);
      e.lists.push(n.models);
      typeMap.set(t, e);
    }
    const agentTypes: AgentTypeUsage[] = [...typeMap].map(([agentType, e]) => {
      const merged = mergeModelUsages(e.lists, this.costOf);
      const cost = new CostAcc();
      for (const m of merged) cost.add(m.costUsd, m.tokens.total);
      return { agentType, spawns: e.spawns, requests: e.requests, tokens: e.tokens, costUsd: cost.value, models: merged.map((m) => m.model) };
    });
    agentTypes.sort((a, b) => (a.agentType === 'main' ? -1 : b.agentType === 'main' ? 1 : b.tokens.total - a.tokens.total));

    const allChecks: ConformanceCheck[] = [...sChecks];
    for (const n of ordered) if (n.kind === 'subagent') allChecks.push(...n.conformance.checks);
    const verdicts = ordered.map((n) => n.conformance.verdict);
    const verdict: ConformanceVerdict = verdicts.includes('mismatch')
      ? 'mismatch'
      : verdicts.includes('unplanned')
        ? 'unplanned'
        : verdicts.includes('match')
          ? 'match'
          : 'not-checked';

    let startedAt: string | null = null;
    let lastActivity: string | null = null;
    let lastMtime: number | null = null;
    for (const f of fileInfo.values()) {
      if (f.first && (!startedAt || f.first < startedAt)) startedAt = f.first;
      if (f.last && (!lastActivity || f.last > lastActivity)) lastActivity = f.last;
      if (f.mtime !== null && (lastMtime === null || f.mtime > lastMtime)) lastMtime = f.mtime;
    }
    const isActive = lastMtime !== null && now - lastMtime < ACTIVE_WINDOW_MS;
    if (isActive && lastMtime !== null) {
      const m = new Date(lastMtime).toISOString();
      if (!lastActivity || m > lastActivity) lastActivity = m;
    }
    const ds = this.desktop.sessions.get(sid);
    const title = ds?.title ?? sess.custom_title ?? sess.ai_title ?? sess.first_prompt ?? null;

    const totalCost = new CostAcc();
    for (const m of sessionModels) totalCost.add(m.costUsd, m.tokens.total);
    let maxDepth = 0;
    for (const n of ordered) maxDepth = Math.max(maxDepth, n.depth);

    const summary: SessionSummary = {
      id: sid,
      projectDir: sess.project_dir,
      cwd: sess.cwd ?? null,
      title,
      entrypoint: sess.entrypoint ?? null,
      version: sess.version ?? null,
      startedAt,
      lastActivityAt: lastActivity,
      isActive,
      mainModel: main.primaryModel,
      mainEffort: extras.get('main')?.lastEffort ?? main.efforts[main.efforts.length - 1] ?? null,
      advisorModel: main.advisorModel,
      advisorCalls: totalAdvisorCalls,
      agentCount: ordered.length - 1,
      maxDepth,
      requests: ordered.reduce((s, n) => s + n.requests, 0),
      tokens: main.subtree.tokens,
      costUsd: totalCost.value,
      conformance: {
        verdict,
        fail: allChecks.filter((c) => c.level === 'fail').length,
        warn: allChecks.filter((c) => c.level === 'warn').length,
      },
      scheme,
    };

    // 缓存有效期：状态依赖"最近 120 秒有写入"，到期后要重算
    let validUntil = Infinity;
    for (const f of fileInfo.values()) {
      if (f.mtime !== null) {
        for (const exp of [f.mtime + ACTIVE_WINDOW_MS, f.pending ? f.mtime + PENDING_TOOL_WINDOW_MS : 0]) {
          if (exp > now) validUntil = Math.min(validUntil, exp);
        }
      }
    }
    if (isActive || sessionRunning) validUntil = Math.min(validUntil, now + 1500); // 运行中的耗时在变

    return {
      detail: { summary, agents: ordered, models: sessionModels, agentTypes, sessionChecks: sChecks },
      extras,
      types,
      computedAt: now,
      validUntil,
    };
  }

  /** 树的关联方式统计（诊断用：哪些节点靠兜底规则挂上） */
  linkReport(): Array<{ sessionId: string; agentId: string; link: LinkMethod | null; parentId: string | null; depth: number }> {
    const out: Array<{ sessionId: string; agentId: string; link: LinkMethod | null; parentId: string | null; depth: number }> = [];
    for (const sid of this.sessionIds()) {
      const c = this.computed(sid);
      if (!c) continue;
      for (const n of c.detail.agents) {
        if (n.kind !== 'subagent') continue;
        out.push({ sessionId: sid, agentId: n.id, link: c.extras.get(n.id)?.link ?? null, parentId: n.parentId, depth: n.depth });
      }
    }
    return out;
  }

  sessions(limit = 200, project?: string | null): SessionSummary[] {
    const list: SessionSummary[] = [];
    for (const sid of this.sessionIds()) {
      const c = this.computed(sid);
      if (!c) continue;
      if (project && c.detail.summary.projectDir !== project) continue;
      list.push(c.detail.summary);
    }
    list.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    return list.slice(0, Math.max(0, limit));
  }

  async overview(days: number | null): Promise<Overview> {
    const now = new Date();
    let fromDate: Date | null = null;
    if (days !== null && days > 0) {
      // 从本地时区 (days-1) 天前的零点开始，含今天共 days 天
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    }
    const fromIso = fromDate ? fromDate.toISOString() : null;
    const where = fromIso ? `AND ts >= ?` : '';
    const params = fromIso ? [fromIso] : [];
    const rows = this.store.db
      .prepare(
        `SELECT session_id, agent, model, day, COUNT(*) AS n, SUM(input) AS i, SUM(output) AS o, SUM(cache_read) AS cr, SUM(cw5m) AS c5, SUM(cw1h) AS c1
         FROM requests WHERE ${COUNTED} ${where} GROUP BY session_id, agent, model, day`,
      )
      .all(...params) as Array<{ session_id: string; agent: string; model: string | null; day: string | null; n: number; i: number; o: number; cr: number; c5: number; c1: number }>;
    const advRows = this.store.db
      .prepare(
        `SELECT r.session_id AS session_id, r.agent AS agent, a.model AS model, SUM(a.input) AS i, SUM(a.output) AS o, SUM(a.cache_read) AS cr, SUM(a.cw5m) AS c5, SUM(a.cw1h) AS c1
         FROM advisor_usage a JOIN requests r ON r.session_id = a.session_id AND r.key = a.key
         WHERE 1=1 ${fromIso ? 'AND r.ts >= ?' : ''} GROUP BY r.session_id, r.agent, a.model`,
      )
      .all(...params) as Array<{ session_id: string; agent: string; model: string | null; i: number; o: number; cr: number; c5: number; c1: number }>;

    const sessionsSeen = new Set<string>();
    const agentsSeen = new Set<string>();
    const modelMap = new Map<string, { requests: number; tokens: TokenTotals }>();
    const typeMap = new Map<string, { agents: Set<string>; requests: number; tokens: TokenTotals; models: Map<string, TokenTotals> }>();
    const dayMap = new Map<string, DailyPoint>();
    let totalReq = 0;
    let totalTokens = zeroTokens();
    const typeCache = new Map<string, Map<string, string>>();
    const typeOf = (sid: string, agent: string): string => {
      if (agent === 'main') return 'main';
      let m = typeCache.get(sid);
      if (!m) {
        m = this.computed(sid)?.types ?? new Map();
        typeCache.set(sid, m);
      }
      return m.get(agent) ?? 'unknown';
    };
    const addModel = (model: string, reqs: number, t: TokenTotals) => {
      const e = modelMap.get(model) ?? { requests: 0, tokens: zeroTokens() };
      e.requests += reqs;
      e.tokens = addTokens(e.tokens, t);
      modelMap.set(model, e);
    };
    const addType = (sid: string, agent: string, model: string, reqs: number, t: TokenTotals) => {
      const type = typeOf(sid, agent);
      const e = typeMap.get(type) ?? { agents: new Set<string>(), requests: 0, tokens: zeroTokens(), models: new Map() };
      e.agents.add(`${sid}/${agent}`);
      e.requests += reqs;
      e.tokens = addTokens(e.tokens, t);
      e.models.set(model, addTokens(e.models.get(model) ?? zeroTokens(), t));
      typeMap.set(type, e);
    };
    for (const r of rows) {
      const t = makeTokens(r.i, r.o, r.cr, r.c5, r.c1);
      const model = r.model ?? UNKNOWN_MODEL;
      sessionsSeen.add(r.session_id);
      if (r.agent !== 'main') agentsSeen.add(`${r.session_id}/${r.agent}`);
      totalReq += r.n;
      totalTokens = addTokens(totalTokens, t);
      addModel(model, r.n, t);
      addType(r.session_id, r.agent, model, r.n, t);
      if (r.day) {
        const d = dayMap.get(r.day) ?? { date: r.day, requests: 0, tokens: 0, byModel: {} };
        d.requests += r.n;
        d.tokens += t.total;
        const bm = d.byModel[model] ?? { requests: 0, tokens: 0 };
        bm.requests += r.n;
        bm.tokens += t.total;
        d.byModel[model] = bm;
        dayMap.set(r.day, d);
      }
    }
    for (const r of advRows) {
      const t = makeTokens(r.i, r.o, r.cr, r.c5, r.c1);
      if (t.total === 0) continue;
      const model = r.model ?? UNKNOWN_MODEL;
      totalTokens = addTokens(totalTokens, t);
      addModel(model, 0, t);
      addType(r.session_id, r.agent, model, 0, t);
    }
    const models = sortModels([...modelMap].map(([model, e]) => ({ model, requests: e.requests, tokens: e.tokens, costUsd: this.costOf(model, e.tokens) })));
    const totalCost = new CostAcc();
    for (const m of models) totalCost.add(m.costUsd, m.tokens.total);
    const agentTypes: AgentTypeUsage[] = [...typeMap].map(([agentType, e]) => {
      const cost = new CostAcc();
      const ms = [...e.models].sort((a, b) => b[1].total - a[1].total);
      for (const [m, t] of ms) cost.add(this.costOf(m, t), t.total);
      return { agentType, spawns: e.agents.size, requests: e.requests, tokens: e.tokens, costUsd: cost.value, models: ms.map(([m]) => m) };
    });
    agentTypes.sort((a, b) => (a.agentType === 'main' ? -1 : b.agentType === 'main' ? 1 : b.tokens.total - a.tokens.total));

    // 每日趋势：范围内每一天都给一个点（没有数据的为 0）
    const daily: DailyPoint[] = [];
    if (fromDate) {
      for (let d = new Date(fromDate); d <= now; d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        daily.push(dayMap.get(key) ?? { date: key, requests: 0, tokens: 0, byModel: {} });
      }
    } else {
      daily.push(...[...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)));
    }

    let quota = await this.desktop.quota();
    if (quota && fromDate) {
      const fromMs = fromDate.getTime();
      quota = { ...quota, samples: quota.samples.filter((s) => s.t >= fromMs) };
    }

    return {
      range: { from: fromIso, to: now.toISOString() },
      totals: { sessions: sessionsSeen.size, agents: agentsSeen.size, requests: totalReq, tokens: totalTokens, costUsd: totalCost.value },
      models,
      agentTypes,
      daily,
      quota,
      index: { ...this.indexer.status },
    };
  }

  live(): LiveState {
    const now = Date.now();
    const sessions: LiveSession[] = [];
    for (const sid of this.sessionIds()) {
      const c = this.computed(sid, now);
      // 最近 120 秒有写入，或有 agent 在等长时间工具的结果
      if (!c || !(c.detail.summary.isActive || c.detail.agents.some((n) => n.status === 'running'))) continue;
      const d = c.detail;
      const mainExtra = c.extras.get('main');
      const runningAgents: LiveAgent[] = d.agents
        .filter((n) => n.kind === 'subagent' && n.status === 'running')
        .map((n) => {
          const ex = c.extras.get(n.id);
          return {
            id: n.id,
            agentType: n.agentType,
            description: n.description,
            model: ex?.lastModel ?? n.primaryModel,
            depth: n.depth,
            parentId: n.parentId,
            lastActivityAt: iso(ex?.lastActivityMs ?? null),
            currentTool: ex?.currentTool ?? null,
            startedAt: n.startedAt,
            requests: n.requests,
            tokens: n.tokens.total,
            toolCalls: n.toolCalls,
          };
        });
      // 主会话本身：最近 120 秒有写入，或在等长时间工具的结果（规则同子 agent）
      const mainActive = isLive({ now, lastWriteMs: mainExtra?.lastActivityMs ?? null, pendingTool: mainExtra?.pendingTool ?? false });
      sessions.push({
        sessionId: sid,
        title: d.summary.title,
        cwd: d.summary.cwd,
        lastActivityAt: d.summary.lastActivityAt,
        mainActive,
        mainModel: mainExtra?.lastModel ?? d.summary.mainModel,
        mainTool: mainActive ? (mainExtra?.currentTool ?? null) : null,
        requests: d.summary.requests,
        tokens: d.summary.tokens.total,
        agentCount: d.summary.agentCount,
        runningAgents,
      });
    }
    sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    return { now: new Date(now).toISOString(), sessions };
  }
}

// 单行日志记录 -> 结构化行。纯函数，不接触文件系统和数据库。
// 只提取统计需要的字段，绝不保留消息正文（首条用户消息的前 60 字作为标题兜底除外，这是契约允许的）。

export interface UsageNums {
  input: number;
  output: number;
  cacheRead: number;
  /** cache_creation_input_tokens 原值 */
  cacheCreate: number;
  cw5m: number;
  cw1h: number;
}

export interface AdvisorIter {
  idx: number;
  model: string | null;
  usage: UsageNums;
}

export interface RequestRow {
  key: string;
  model: string | null;
  ts: string | null;
  effort: string | null;
  advisorModel: string | null;
  usage: UsageNums;
  advisor: AdvisorIter[];
  /**
   * 这次回复的"等待起点"：第一块内容之前最近的一条用户记录（用户消息、工具结果）或上一次回复的块的时间。
   * 不知道时为 null
   */
  promptTs: string | null;
  /** 这次回复最后一块完成的时间；减去 promptTs 就是整次回复的耗时 */
  endTs: string | null;
  /**
   * 这次回复里最长的一段没有输出的时间（毫秒）：起点到第一块、以及相邻两块之间（中间夹着的工具结果也算一条记录）的最大间隔。
   * 思考块完成之前日志里什么都没有，所以长思考表现为块和块之间的一段沉默。不知道时为 null
   */
  maxGapMs: number | null;
  /** 最长那段沉默结束的时间（结束它的那一块的时间） */
  gapTs: string | null;
}

/** 用户按中断时程序写入的标记（type 为 user、内容为 [Request interrupted by user...]），只记时间，不保留内容 */
export interface InterruptRow {
  /** 去重键：记录的 uuid；没有时退回时间戳 */
  key: string;
  ts: string | null;
  /** 中断前已经等了多久（毫秒）：中断标记的时间 - 它之前最近的一条用户记录或回复块的时间。不知道时为 null */
  waitMs: number | null;
}

/** 两个时间戳之差（毫秒）；任一无效或为负时为 null */
function gapMs(from: string | null | undefined, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

export interface ToolUseRow {
  id: string;
  name: string;
  ts: string | null;
  subagentType: string | null;
  description: string | null;
  model: string | null;
  background: boolean | null;
}

export interface AgentResultRow {
  toolUseId: string;
  agentId: string;
  status: string | null;
  isAsync: boolean;
  durationMs: number | null;
  resolvedModel: string | null;
  agentType: string | null;
  description: string | null;
  ts: string | null;
}

export interface NotificationRow {
  taskId: string;
  status: string;
  ts: string | null;
}

/** 会话可用 agent 类型清单的一次变化（attachment.type 为 agent_listing_delta）。只取类型名，不保留描述文本 */
export interface ListingDelta {
  ts: string | null;
  added: string[];
  removed: string[];
}

/**
 * 一次上下文压缩（type 为 system、subtype 为 compact_boundary 的记录）。
 * 字段名来自 Claude Code 的文档，但格式标注为内部格式，所以宽松处理：没有 compactMetadata 也算一次压缩，
 * trigger 记为 unknown、preTokens 记为 null。压缩后的摘要本身（下一条 isCompactSummary 的用户消息）不保留
 */
export interface CompactionRow {
  /** 去重键：记录的 uuid；没有时退回时间戳 */
  key: string;
  trigger: 'auto' | 'manual' | 'unknown';
  /** 压缩前的上下文 token 数 */
  preTokens: number | null;
  ts: string | null;
}

export interface SessionPatch {
  cwd: string | null;
  entrypoint: string | null;
  version: string | null;
  gitBranch: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
}

export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function obj(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

export function emptyUsage(): UsageNums {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cw5m: 0, cw1h: 0 };
}

/** 从 message.usage（或 iterations 的一项）提取数值 */
export function readUsage(u: unknown): UsageNums {
  const o = obj(u);
  if (!o) return emptyUsage();
  const cacheCreate = num(o.cache_creation_input_tokens);
  const cc = obj(o.cache_creation);
  let cw5m: number;
  let cw1h: number;
  if (cc) {
    cw1h = num(cc.ephemeral_1h_input_tokens);
    const e5 = num(cc.ephemeral_5m_input_tokens);
    // 拆分与总数不一致时，差额记到 5 分钟档，保证五项之和等于四项原值之和
    cw5m = Math.max(e5, cacheCreate - cw1h);
    if (cw5m + cw1h < cacheCreate) cw5m = cacheCreate - cw1h;
  } else {
    // 没有拆分信息：按 5 分钟档计（Claude Code 默认 TTL）
    cw5m = cacheCreate;
    cw1h = 0;
  }
  return {
    input: num(o.input_tokens),
    output: num(o.output_tokens),
    cacheRead: num(o.cache_read_input_tokens),
    cacheCreate,
    cw5m,
    cw1h,
  };
}

export function maxUsage(a: UsageNums, b: UsageNums): UsageNums {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheCreate: Math.max(a.cacheCreate, b.cacheCreate),
    cw5m: Math.max(a.cw5m, b.cw5m),
    cw1h: Math.max(a.cw1h, b.cw1h),
  };
}

/** 计入条件的四项之和 */
export function fourSum(u: UsageNums): number {
  return u.input + u.output + u.cacheRead + u.cacheCreate;
}

/** 同一个去重键的两行合并：用量逐字段取最大值 */
export function mergeRequest(a: RequestRow, b: RequestRow): RequestRow {
  const advisor = new Map<number, AdvisorIter>();
  for (const it of a.advisor) advisor.set(it.idx, it);
  for (const it of b.advisor) {
    const prev = advisor.get(it.idx);
    advisor.set(it.idx, prev ? { idx: it.idx, model: prev.model ?? it.model, usage: maxUsage(prev.usage, it.usage) } : it);
  }
  const pickModel = (x: string | null, y: string | null) => {
    if (!x) return y;
    if (x === '<synthetic>' && y && y !== '<synthetic>') return y;
    return x;
  };
  return {
    key: a.key,
    model: pickModel(a.model, b.model),
    ts: a.ts && b.ts ? (a.ts < b.ts ? a.ts : b.ts) : a.ts ?? b.ts,
    effort: a.effort ?? b.effort,
    advisorModel: a.advisorModel ?? b.advisorModel,
    usage: maxUsage(a.usage, b.usage),
    advisor: [...advisor.values()].sort((x, y) => x.idx - y.idx),
    // 起点取较早的（第一块之前的那条记录），结束取较晚的
    promptTs: a.promptTs && b.promptTs ? (a.promptTs < b.promptTs ? a.promptTs : b.promptTs) : a.promptTs ?? b.promptTs,
    endTs: a.endTs && b.endTs ? (a.endTs > b.endTs ? a.endTs : b.endTs) : a.endTs ?? b.endTs,
    ...(b.maxGapMs !== null && (a.maxGapMs === null || b.maxGapMs > a.maxGapMs) ? { maxGapMs: b.maxGapMs, gapTs: b.gapTs } : { maxGapMs: a.maxGapMs, gapTs: a.gapTs }),
  };
}

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/;

/** 是否是用户按中断时程序写入的标记（两种写法：[Request interrupted by user] 和 [Request interrupted by user for tool use]） */
export function isInterruptText(text: string): boolean {
  return INTERRUPT_RE.test(text.trim());
}

/** 本地命令和 ! 命令的输出：写完之后不会有模型回复 */
const LOCAL_OUTPUT_RE = /^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/;

const NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;
const STATUS_RE = /<status>\s*([^<\s]+)\s*<\/status>/;

/** 从文本中提取后台任务通知（task-id 与 status），不保留其他内容 */
export function extractNotifications(text: string): Array<{ taskId: string; status: string }> {
  if (!text.includes('<task-notification>')) return [];
  const out: Array<{ taskId: string; status: string }> = [];
  for (const m of text.matchAll(NOTIF_RE)) {
    const body = m[1];
    const id = TASK_ID_RE.exec(body);
    const st = STATUS_RE.exec(body);
    if (id && st) out.push({ taskId: id[1], status: st[1] });
  }
  return out;
}

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const b of content) {
      const bo = obj(b);
      if (bo && bo.type === 'text' && typeof bo.text === 'string') out.push(bo.text);
    }
    return out;
  }
  return [];
}

function titleFromPrompt(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<')) return null;
  const chars = Array.from(t);
  return chars.length > 60 ? chars.slice(0, 60).join('') : t;
}

/**
 * 文件末尾的状态，跨增量读取延续（存在 files.pending_tools 里）。
 * msg 为发出这些 tool_use 的 assistant 消息 id，ids 为还没拿到 tool_result 的 tool_use id。
 * 后三项是回复计时用的，旧数据里没有，按 null 处理。
 */
export interface PendingTools {
  msg: string | null;
  ids: string[];
  /** 最近一条用户记录或回复块的时间：下一次新回复的等待起点 */
  anchor?: string | null;
  /** 最近一次回复的去重键；同一次回复后面的块不重新取起点 */
  reply?: string | null;
  /** 最后一条有效记录是用户消息或工具结果、之后还没有回复时，这条记录的时间；否则为 null */
  awaiting?: string | null;
}

export function parsePending(s: string | null | undefined): PendingTools {
  const empty = { msg: null, ids: [], anchor: null, reply: null, awaiting: null };
  if (!s) return empty;
  try {
    const o = JSON.parse(s);
    const sv = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      msg: sv(o.msg),
      ids: Array.isArray(o.ids) ? o.ids.filter((x: unknown) => typeof x === 'string') : [],
      anchor: sv(o.anchor),
      reply: sv(o.reply),
      awaiting: sv(o.awaiting),
    };
  } catch {
    return empty;
  }
}

/** 一个文件一段新内容的解析结果；同一批里重复的去重键先在内存中合并 */
export class LineBatch {
  readonly isMain: boolean;
  requests = new Map<string, RequestRow>();
  toolUses = new Map<string, ToolUseRow>();
  results = new Map<string, AgentResultRow>();
  notifications: NotificationRow[] = [];
  listings: ListingDelta[] = [];
  compactions: CompactionRow[] = [];
  interrupts: InterruptRow[] = [];
  session: SessionPatch = {
    cwd: null,
    entrypoint: null,
    version: null,
    gitBranch: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
  };
  minTs: string | null = null;
  maxTs: string | null = null;
  badLines = 0;
  lines = 0;
  /** 读完这一批之后，文件末尾还在等结果的 tool_use */
  pending: PendingTools;

  constructor(isMain: boolean, pending: PendingTools = { msg: null, ids: [] }) {
    this.isMain = isMain;
    this.pending = { msg: pending.msg, ids: [...pending.ids], anchor: pending.anchor ?? null, reply: pending.reply ?? null, awaiting: pending.awaiting ?? null };
  }

  /** 最后一条记录是否是还没拿到结果的 tool_use */
  get hasPendingTool(): boolean {
    return this.pending.ids.length > 0;
  }

  get isEmpty(): boolean {
    return (
      this.requests.size === 0 &&
      this.toolUses.size === 0 &&
      this.results.size === 0 &&
      this.notifications.length === 0 &&
      this.listings.length === 0 &&
      this.compactions.length === 0 &&
      this.interrupts.length === 0 &&
      this.minTs === null &&
      this.badLines === 0 &&
      Object.values(this.session).every((v) => v === null)
    );
  }

  addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lines++;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      this.badLines++;
      return;
    }
    const o = obj(rec);
    if (!o) {
      this.badLines++;
      return;
    }
    this.addRecord(o);
  }

  addRecord(o: Record<string, any>): void {
    const ts = str(o.timestamp);
    if (ts) {
      if (!this.minTs || ts < this.minTs) this.minTs = ts;
      if (!this.maxTs || ts > this.maxTs) this.maxTs = ts;
    }
    const type = o.type;
    if (this.isMain) this.patchSession(o);

    if (type === 'assistant') this.onAssistant(o, ts);
    else if (type === 'user') this.onUser(o, ts);
    else if (type === 'queue-operation') {
      if (typeof o.content === 'string') this.onNotificationText(o.content, ts);
    } else if (type === 'attachment') {
      const a = obj(o.attachment);
      if (a && a.type === 'queued_command') {
        for (const t of textsOf(a.prompt)) this.onNotificationText(t, ts ?? str(a.timestamp));
      } else if (a && a.type === 'agent_listing_delta') {
        // 只存类型名；addedLines 是描述文本，用不上，不保留
        const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []);
        const added = names(a.addedTypes);
        const removed = names(a.removedTypes);
        if (added.length || removed.length) this.listings.push({ ts, added, removed });
      }
    } else if (type === 'system' && o.subtype === 'compact_boundary') {
      this.onCompactBoundary(o, ts);
    }
  }

  private onCompactBoundary(o: Record<string, any>, ts: string | null) {
    const meta = obj(o.compactMetadata);
    const trig = meta ? str(meta.trigger) : null;
    const pre = meta && typeof meta.preTokens === 'number' && Number.isFinite(meta.preTokens) && meta.preTokens >= 0 ? Math.round(meta.preTokens) : null;
    // 同一批里重复的键（文件被重写后从头重读）只记一次
    const key = str(o.uuid) ?? (ts ? `ts:${ts}` : `line:${this.lines}`);
    if (this.compactions.some((c) => c.key === key)) return;
    this.compactions.push({ key, trigger: trig === 'auto' || trig === 'manual' ? trig : 'unknown', preTokens: pre, ts });
  }

  private patchSession(o: Record<string, any>) {
    const s = this.session;
    // 记会话开始时的目录，它代表这个会话属于哪个项目。
    // 会话中途切换目录（比如 cd 到子目录）不应该改变项目归属
    const cwd = str(o.cwd) ?? str(o.relocatedCwd);
    if (cwd && s.cwd === null) s.cwd = cwd;
    const ep = str(o.entrypoint);
    if (ep) s.entrypoint = ep;
    const v = str(o.version);
    if (v) s.version = v;
    const gb = str(o.gitBranch);
    if (gb) s.gitBranch = gb;
    if (o.type === 'custom-title') {
      const t = str(o.customTitle);
      if (t) s.customTitle = t;
    } else if (o.type === 'ai-title') {
      const t = str(o.aiTitle);
      if (t) s.aiTitle = t;
    }
  }

  private onAssistant(o: Record<string, any>, ts: string | null) {
    const msg = obj(o.message) ?? {};
    const key = str(msg.id) ?? str(o.requestId) ?? str(o.uuid);
    const usageObj = obj(msg.usage);
    const advisor: AdvisorIter[] = [];
    if (usageObj && Array.isArray(usageObj.iterations)) {
      let idx = 0;
      for (const it of usageObj.iterations) {
        const io = obj(it);
        if (io && io.type === 'advisor_message') {
          advisor.push({ idx: idx++, model: str(io.model), usage: readUsage(io) });
        }
      }
    }
    // 回复计时：一次回复的第一块取等待起点，同一回复后面的块不再取（旧版本主文件里混写的子 agent 记录不参与）
    const timed = !(this.isMain && o.isSidechain === true);
    let promptTs: string | null = null;
    // 这一块和前一条记录（用户记录或回复块）之间的沉默
    const gap = key && timed ? gapMs(this.pending.anchor, ts) : null;
    if (key && timed && key !== this.pending.reply) {
      promptTs = this.pending.anchor ?? null;
      this.pending.reply = key;
    }
    if (key) {
      const row: RequestRow = {
        key,
        model: str(msg.model),
        ts,
        effort: str(o.effort),
        advisorModel: str(o.advisorModel),
        usage: readUsage(usageObj),
        advisor,
        promptTs,
        endTs: ts,
        maxGapMs: gap,
        gapTs: gap !== null ? ts : null,
      };
      const prev = this.requests.get(key);
      this.requests.set(key, prev ? mergeRequest(prev, row) : row);
    }
    // 同一条 assistant 消息会拆成多行写入（thinking、text、tool_use 各一行）：同一消息累加，新消息重置
    const msgId = str(msg.id) ?? str(o.requestId) ?? str(o.uuid);
    if (msgId !== this.pending.msg) this.pending = { ...this.pending, msg: msgId, ids: [] };
    if (timed) {
      if (ts) this.pending.anchor = ts;
      this.pending.awaiting = null;
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const bo = obj(b);
        if (!bo || bo.type !== 'tool_use') continue;
        const id = str(bo.id);
        if (!id) continue;
        if (!this.pending.ids.includes(id)) this.pending.ids.push(id);
        const name = str(bo.name) ?? 'unknown';
        const input = obj(bo.input) ?? {};
        const isAgent = AGENT_TOOL_NAMES.has(name);
        if (this.toolUses.has(id)) continue;
        this.toolUses.set(id, {
          id,
          name,
          ts,
          subagentType: isAgent ? str(input.subagent_type) : null,
          description: isAgent ? str(input.description) : null,
          model: isAgent ? str(input.model) : null,
          background: isAgent && typeof input.run_in_background === 'boolean' ? input.run_in_background : null,
        });
      }
    }
  }

  private onUser(o: Record<string, any>, ts: string | null) {
    const msg = obj(o.message);
    const content = msg ? msg.content : undefined;
    const r = obj(o.toolUseResult);
    if (r && typeof r.agentId === 'string' && Array.isArray(content)) {
      const block = content.map(obj).find((b) => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string');
      if (block) {
        this.results.set(block.tool_use_id, {
          toolUseId: block.tool_use_id,
          agentId: r.agentId,
          status: str(r.status),
          isAsync: r.isAsync === true,
          durationMs: typeof r.totalDurationMs === 'number' ? r.totalDurationMs : null,
          resolvedModel: str(r.resolvedModel),
          agentType: str(r.agentType),
          description: str(r.description),
          ts,
        });
      }
    }
    const texts = textsOf(content);
    for (const t of texts) this.onNotificationText(t, ts);
    const interrupted = texts.some(isInterruptText);
    if (!(this.isMain && o.isSidechain === true)) {
      // 中断标记：同一批里重复的键只记一次，跨批次靠数据库主键去重
      if (interrupted) {
        const key = str(o.uuid) ?? (ts ? `ts:${ts}` : `line:${this.lines}`);
        if (!this.interrupts.some((x) => x.key === key)) this.interrupts.push({ key, ts, waitMs: gapMs(this.pending.anchor, ts) });
      }
      // 回复计时：用户记录都算下一次回复的等待起点
      if (ts) this.pending.anchor = ts;
      // 是否在等回复：用户消息、工具结果之后在等；中断、压缩摘要、本地命令的输出之后不会有回复；isMeta 的记录不改变状态
      if (!o.isMeta) {
        if (interrupted || o.isCompactSummary === true || (texts.length > 0 && texts.every((t) => LOCAL_OUTPUT_RE.test(t)))) this.pending.awaiting = null;
        else this.pending.awaiting = ts ?? this.pending.awaiting ?? null;
      }
    }
    // 等待中的 tool_use：拿到结果就移除；用户发了新消息（含中断）则清空
    if (!o.isMeta) {
      const resultIds = Array.isArray(content)
        ? content.map(obj).filter((b) => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string').map((b) => b!.tool_use_id as string)
        : [];
      if (resultIds.length) this.pending.ids = this.pending.ids.filter((id) => !resultIds.includes(id));
      else if (texts.length) this.pending = { ...this.pending, msg: null, ids: [] };
    }
    if (this.isMain && this.session.firstPrompt === null && !o.isMeta && !o.isCompactSummary && !r) {
      const origin = obj(o.origin);
      if (!origin || origin.kind === undefined || origin.kind === 'human' || origin.kind === 'user') {
        for (const t of texts) {
          if (isInterruptText(t)) continue;
          const title = titleFromPrompt(t);
          if (title) {
            this.session.firstPrompt = title;
            break;
          }
        }
      }
    }
  }

  private onNotificationText(text: string, ts: string | null) {
    for (const n of extractNotifications(text)) this.notifications.push({ ...n, ts });
  }
}

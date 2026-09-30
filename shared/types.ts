// agentree 前后端共用的接口契约。
// 后端（server/）产出这些结构，前端（web/）消费。修改这里必须同时改两边。
// 所有时间字段为 ISO 8601 字符串，除非注明是毫秒时间戳。

export interface TokenTotals {
  /** 未命中缓存的输入 */
  input: number;
  output: number;
  cacheRead: number;
  /** 5 分钟缓存写入 */
  cacheWrite5m: number;
  /** 1 小时缓存写入 */
  cacheWrite1h: number;
  /** 以上五项之和 */
  total: number;
}

export interface ModelUsage {
  /** 日志里的原始模型名，如 claude-opus-5-5 */
  model: string;
  /** 去重后的 API 请求次数 */
  requests: number;
  tokens: TokenTotals;
  /** 查不到价格时为 null，前端显示 "—" */
  costUsd: number | null;
}

/** stopped 表示被用户或系统中止（任务通知的状态为 stopped 或 killed） */
export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** ok 符合；warn 有差异但可能合法（别名、后缀、降级）；fail 明确不符；info 仅提示 */
export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface ConformanceCheck {
  /** dispatch：这个节点是被一个指定了 dispatchModel 的父 agent 派发的，比的是派发时实际传的 model 参数 */
  field: 'agent' | 'model' | 'effort' | 'advisor' | 'dispatch';
  level: CheckLevel;
  expected: string | null;
  actual: string | null;
  /** 给用户看的中文说明，要解释原因 */
  message: string;
}

/**
 * match       全部检查通过
 * mismatch    至少一项 fail
 * unplanned   该 agent 类型不在预设里，也不是内置类型
 * not-checked 没有预设可比
 */
export type ConformanceVerdict = 'match' | 'mismatch' | 'unplanned' | 'not-checked';

export interface Conformance {
  verdict: ConformanceVerdict;
  /** 匹配到的预设 agent 名；内置类型或未匹配时为 null */
  presetAgent: string | null;
  checks: ConformanceCheck[];
}

/**
 * 上下文压缩的统计。依据是日志里 type 为 system、subtype 为 compact_boundary 的记录：
 * compactMetadata.trigger 为 auto（上下文达到阈值时自动压缩）或 manual（用户输入 /compact），
 * compactMetadata.preTokens 是压缩前的上下文 token 数。记录上没有 compactMetadata 时仍算一次压缩，但不知道触发方式和 token 数
 */
export interface CompactionStats {
  total: number;
  auto: number;
  manual: number;
  /** 自动压缩时的 preTokens，按时间顺序；记录上没有 preTokens 的不在这里 */
  autoPreTokens: number[];
}

/**
 * 回复等待的统计。一次回复的每个内容块各写一条记录，时间戳是块完成的时间，所以思考完成之前日志里什么都没有。
 * "没有输出的时间"取这次回复里最长的一段沉默：之前最近的一条用户记录（用户消息、工具结果）到第一块、
 * 以及同一次回复里相邻两块之间的最大间隔。长思考常常不在开头（比如先调用 advisor，拿到结果后再思考 6 分钟），
 * 所以不能只看第一块。高强度（xhigh、max）下模型会先思考很久，这段时间界面上没有任何输出
 */
export interface ReplyWaitStats {
  /** 能算出沉默时间的回复次数 */
  replies: number;
  /** 最长一段没有输出的时间超过 2 分钟的回复次数 */
  slowReplies: number;
  /** 沉默最久的一次回复；没有能算的回复时为 null */
  longest: {
    /** 这次回复里最长一段没有输出的时间，毫秒 */
    waitMs: number;
    /** 整次回复的耗时（起点到最后一块完成），毫秒 */
    durationMs: number | null;
    /** 这次回复的输出 token */
    outputTokens: number;
    /** 这段沉默结束的时间（结束它的那一块完成的时间） */
    at: string;
  } | null;
}

/** 正在等模型回复：最后一条有效记录是用户消息或工具结果，之后还没有回复 */
export interface AwaitingReply {
  /** 开始等的时间（那条用户记录的时间） */
  since: string;
  /** 到后端计算时已经等了多久，毫秒 */
  waitedMs: number;
}

export interface AgentNode {
  /** 主会话固定为 'main'，子 agent 为 agentId */
  id: string;
  kind: 'main' | 'subagent';
  /** 子 agent 类型，如 Explore、general-purpose；主会话为 null */
  agentType: string | null;
  /** 派发时的任务描述；主会话为 null */
  description: string | null;
  /** 父节点 id；主会话为 null */
  parentId: string | null;
  /** 主会话为 0，第一层子 agent 为 1 */
  depth: number;
  /** 父级发起这个子 agent 的那次工具调用 id */
  toolUseId: string | null;
  status: AgentStatus;
  /** 是否后台运行 */
  background: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** 该 agent 自己的去重后请求次数，不含后代 */
  requests: number;
  /** 该 agent 自己发起的工具调用次数，不含后代 */
  toolCalls: number;
  /** 该 agent 自己的用量，不含后代 */
  tokens: TokenTotals;
  costUsd: number | null;
  /** 含所有后代的汇总 */
  subtree: {
    agents: number;
    requests: number;
    toolCalls: number;
    tokens: TokenTotals;
    costUsd: number | null;
  };
  /** 按模型拆分；一个 agent 中途可能换模型 */
  models: ModelUsage[];
  /** 请求次数最多的模型 */
  primaryModel: string | null;
  /** 出现过的 effort 值，按首次出现顺序 */
  efforts: string[];
  /** 派发时显式传入的 model 参数；没传为 null */
  requestedModel: string | null;
  /** 记录上标注的 advisor 模型（表示配置了谁，不代表调用过） */
  advisorModel: string | null;
  /** advisor 实际被调用的次数 */
  advisorCalls: number;
  /** 这个 agent 自己的对话被压缩的次数（主会话是主对话，子 agent 是它自己的对话），不含后代 */
  compactions: CompactionStats;
  /** 这个 agent 自己的回复等待统计，不含后代 */
  replyWait: ReplyWaitStats;
  conformance: Conformance;
  /** 子节点 id，按开始时间排序 */
  children: string[];
}

/**
 * 一个会话是按哪份方案检查的。
 *   project  会话所在的项目有自己的方案。检查时用"项目方案叠在全局方案上"的结果
 *   user     项目没有自己的方案，用全局方案
 *   none     两者都没有
 */
export interface SchemeRef {
  scope: 'user' | 'project' | 'none';
  /** scope 为 project 时是方案所属的项目目录，其他为 null */
  projectCwd: string | null;
}

export interface SessionSummary {
  id: string;
  /** ~/.claude/projects 下的目录名 */
  projectDir: string;
  /** 会话的工作目录，取自日志记录 */
  cwd: string | null;
  /** 优先用桌面版标题，其次自定义标题，再次首条用户消息的前 60 字 */
  title: string | null;
  /** 如 claude-desktop、cli */
  entrypoint: string | null;
  version: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** 最近 120 秒内有写入 */
  isActive: boolean;
  mainModel: string | null;
  mainEffort: string | null;
  advisorModel: string | null;
  advisorCalls: number;
  /** 主对话被压缩的次数（不含子 agent 自己的对话；每个 agent 自己的见 AgentNode.compactions） */
  compactions: CompactionStats;
  /** 主对话的回复等待统计（不含子 agent；每个 agent 自己的见 AgentNode.replyWait） */
  replyWait: ReplyWaitStats;
  /** 主对话被用户中断的次数（日志里 [Request interrupted by user...] 标记的条数） */
  interrupts: number;
  /**
   * 主对话里中断前最长等了多久（毫秒）：每个中断标记的时间减去它之前最近的一条记录（用户消息、工具结果或回复块）的时间，取最大。
   * 用户消息之后一直没有输出、等到被中断的那段时间只在这里体现。没有中断或算不出时为 null
   */
  interruptMaxWaitMs: number | null;
  /** 主对话正在等回复时的信息；没在等，或会话最近 30 分钟没有写入时为 null */
  awaitingReply: AwaitingReply | null;
  /** 子 agent 数量，不含主会话 */
  agentCount: number;
  maxDepth: number;
  /** 整个会话含所有子 agent */
  requests: number;
  tokens: TokenTotals;
  costUsd: number | null;
  conformance: {
    verdict: ConformanceVerdict;
    fail: number;
    warn: number;
  };
  /** 这个会话是按哪份方案检查的 */
  scheme: SchemeRef;
}

export interface AgentTypeUsage {
  /** 主会话用 'main' */
  agentType: string;
  /** 被派发的次数 */
  spawns: number;
  requests: number;
  tokens: TokenTotals;
  costUsd: number | null;
  /** 用过的模型 */
  models: string[];
}

export interface SessionDetail {
  summary: SessionSummary;
  /** 扁平列表，用 parentId / children 还原树；第一个元素是主会话 */
  agents: AgentNode[];
  models: ModelUsage[];
  agentTypes: AgentTypeUsage[];
  /** 会话级的检查项（主模型、主 effort、advisor） */
  sessionChecks: ConformanceCheck[];
}

export interface DailyPoint {
  /** 本地时区的 YYYY-MM-DD */
  date: string;
  requests: number;
  tokens: number;
  byModel: Record<string, { requests: number; tokens: number }>;
}

export interface QuotaSample {
  /** 毫秒时间戳 */
  t: number;
  /** 5 小时窗口已用百分比 0-100 */
  fiveHourPct: number;
  /** 7 天窗口已用百分比 0-100 */
  sevenDayPct: number;
}

export interface QuotaInfo {
  /** 数据来源文件 */
  source: string;
  latest: QuotaSample | null;
  samples: QuotaSample[];
}

export interface Overview {
  range: { from: string | null; to: string | null };
  totals: {
    sessions: number;
    agents: number;
    requests: number;
    tokens: TokenTotals;
    costUsd: number | null;
  };
  models: ModelUsage[];
  agentTypes: AgentTypeUsage[];
  daily: DailyPoint[];
  /** 没有桌面版数据时为 null */
  quota: QuotaInfo | null;
  index: IndexStatus;
}

export interface IndexStatus {
  state: 'idle' | 'indexing';
  filesTotal: number;
  filesIndexed: number;
  lastIndexedAt: string | null;
  /** 解析时跳过的坏行数 */
  skippedLines: number;
}

export interface LiveAgent {
  id: string;
  agentType: string | null;
  description: string | null;
  model: string | null;
  depth: number;
  parentId: string | null;
  lastActivityAt: string | null;
  /** 最近一次发起的工具名 */
  currentTool: string | null;
  startedAt: string | null;
  /** 该 agent 自己到目前为止的请求数、token 合计、工具调用数 */
  requests: number;
  tokens: number;
  toolCalls: number;
}

export interface LiveSession {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  lastActivityAt: string | null;
  /** 主会话本身最近是否有写入 */
  mainActive: boolean;
  mainModel: string | null;
  /** 主会话最近一次发起的工具名 */
  mainTool: string | null;
  /** 整个会话（含所有子 agent）到目前为止的请求数和 token 合计 */
  requests: number;
  tokens: number;
  /** 这个会话一共派发过多少子 agent，包括已经结束的 */
  agentCount: number;
  runningAgents: LiveAgent[];
  /** 主会话正在等回复时的信息（模型可能在思考），否则为 null */
  awaitingReply: AwaitingReply | null;
}

export interface LiveState {
  now: string;
  sessions: LiveSession[];
}

export interface PresetAgent {
  /** 对应子 agent 类型名 */
  name: string;
  /** 别名（opus、sonnet、haiku、fable）、inherit 或完整模型 ID；null 表示不指定（不检查，应用时不写这个字段） */
  model: string | null;
  /** low、medium、high、xhigh、max；null 表示不指定 */
  effort: string | null;
  /** 旧版的"职责"一句话。新版改用 description；读到只有 note 没有 description 的旧预设时，把 note 当作 description */
  note?: string;
  /**
   * 以下四个字段描述定义文件的内容。三种取值含义不同：
   *   字段缺失（undefined）：不管这一项。应用时不修改已有文件里的值，新建文件时用模板
   *   null：明确不要这个字段。应用时从文件里删掉（tools 为 null 即"继承全部工具"）
   *   字符串：应用时写成这个值
   * description 和 prompt 不接受 null（定义文件必须有描述；正文可以是空字符串）
   */
  /** 什么时候该把任务交给它。主会话靠这段话决定是否派发 */
  description?: string;
  /** 工具白名单，逗号分隔，如 "Read, Grep, Glob" */
  tools?: string | null;
  /** 工具黑名单，逗号分隔。常见用法是 "Agent"：禁止它再往下派发子 agent */
  disallowedTools?: string | null;
  /** 系统提示词，即定义文件的正文。不含 agentree 写在正文末尾的"往下派发"块（见 shared/dispatch.ts），那一块由 dispatchModel 表示 */
  prompt?: string;
  /**
   * 它往下派发子 agent 时要传给 Agent 工具的 model 参数：别名（opus、sonnet、haiku、fable）或完整模型 ID。
   * Claude Code 没有这样的 frontmatter 字段，唯一能左右下一层模型的是派发时的 model 参数（官方解析顺序里排第一），
   * 所以应用时把这个要求写进定义文件正文末尾一段受管的块（shared/dispatch.ts）。这是给模型的提示，不是硬性限制，
   * 会话页和生效检查按日志核对它每次派发实际传的模型。
   * 没有这个要求时，下一层的模型按 Claude Code 的规则：有定义文件的 agent 用自己定义里的 model；
   * Explore、Plan、general-purpose 这类内置类型用主会话的模型（Explore 最高到 Opus），不是父 agent 的。
   *   字段缺失（undefined）：不管这一项，应用时不动正文里已有的块
   *   null：明确不要，应用时把正文里的块删掉
   *   字符串：应用时写成这个值
   * 只有允许它再派发（tools 含 Agent 或没限制，且 disallowedTools 不含 Agent）时才有意义
   */
  dispatchModel?: string | null;
}

/**
 * 方案分两种范围，对应 Claude Code 的两级配置：
 *
 *   全局方案  对所有项目生效。子 agent 定义写在 ~/.claude/agents，设置写在 ~/.claude/settings.json，
 *             规则写在 ~/.claude/CLAUDE.md
 *   项目方案  只对某一个项目目录下的会话生效。子 agent 定义写在 <项目>/.claude/agents，
 *             设置写在 <项目>/.claude/settings.local.json（个人用，不进版本库），规则写在 <项目>/CLAUDE.md
 *
 * 一个项目里实际生效的是两者叠加：
 *   子 agent   全局的和项目的都可用；同名时用项目的
 *   主模型、主 effort、advisor、自动压缩阈值   项目方案里指定了就用项目的，没指定（null）就用全局的
 *   规则       两边的 CLAUDE.md 都会被读到
 *   allowBuiltins   有项目方案时用项目方案的
 * 一致性检查和生效检查都按叠加后的结果来比。
 *
 * Claude Code 另有"只对一次会话生效"的方式（命令行的 --agents 参数），桌面版没有对应的入口，
 * agentree 不管理它，只在搭建页提供生成启动命令的功能（纯前端）。
 */
export interface SchemeInfo {
  scope: 'user' | 'project';
  /** 全局方案为 null */
  projectCwd: string | null;
  /** 方案里的子 agent 数量 */
  agents: number;
  /** 方案保存的时间；没保存过为 null */
  updatedAt: string | null;
  /** 上次应用到 Claude Code 的时间；没应用过为 null */
  appliedAt: string | null;
}

/** 用户期望的 agent 树，存在 agentree 自己的目录里，不写入 Claude Code 配置 */
export interface Preset {
  version: 1;
  main: {
    model: string | null;
    effort: string | null;
    /**
     * 自动压缩阈值：上下文达到这么多 token 时 Claude Code 自动压缩对话，对应 settings 的 autoCompactWindow。
     * 主对话和全部子 agent 共用这一个阈值：官方文档写压缩设置 "Applies to both main conversations and subagents"，
     * 定义文件的 frontmatter 没有任何压缩相关字段，所以不能给单个子 agent 单独设。生效检查也要把子 agent 里的自动压缩算进来。
     * 取值 100000 到 1000000 的整数，实际生效的上限是模型的上下文窗口（200K 的模型到 200K 就压缩）。
     * null 表示不指定，跟 Claude Code 默认。磁盘上的旧方案没有这个字段，读入时当作 null
     */
    autoCompactWindow: number | null;
  };
  advisor: { model: string | null };
  agents: PresetAgent[];
  /** 为 true 时，内置类型（Explore、Plan 等）不算 unplanned */
  allowBuiltins: boolean;
  updatedAt: string | null;
}

export interface AgentDefinition {
  name: string;
  source: 'user' | 'project';
  filePath: string;
  description: string | null;
  model: string | null;
  effort: string | null;
  tools: string | null;
  /** source 为 project 时，所属项目的目录 */
  projectCwd: string | null;
}

export interface EnvCheck {
  name: string;
  /** 未设置为 null。值可能敏感，超过 12 个字符时后端只返回前 4 位加省略号 */
  value: string | null;
  scope: 'user' | 'machine' | 'settings';
  level: CheckLevel;
  /** 中文说明：这个变量会造成什么影响 */
  impact: string;
}

export interface ClaudeConfigSnapshot {
  configDir: string;
  definitions: AgentDefinition[];
  settings: {
    effortLevel: string | null;
    model: string | null;
    advisorModel: string | null;
    /** modelSettings.<model>.effortLevel 的映射 */
    modelEffort: Record<string, string>;
    /** 自动压缩阈值（token 数）；没有设置或不是数字为 null */
    autoCompactWindow: number | null;
    /** 是否开启自动压缩；没有设置为 null（Claude Code 默认开启） */
    autoCompactEnabled: boolean | null;
  };
  env: EnvCheck[];
  builtinAgentTypes: string[];
  /** 检测到 cc-switch 可能接管配置 */
  ccSwitchDetected: boolean;
  /** 索引里出现过的会话工作目录，项目级 agent 只能建在这些目录下。按最近活跃排序 */
  projectCwds: string[];
}

/** 下拉框里可选的一个具体模型 */
export interface ModelOption {
  /** 完整模型 ID，如 claude-opus-5-5 */
  id: string;
  /** 给人看的名字，如 Opus 5.5 */
  label: string;
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other';
  /** 本机日志里用这个模型发过多少次请求；没用过为 0 */
  requests: number;
  lastUsedAt: string | null;
}

export interface ApiError {
  error: string;
}

/**
 * HTTP 接口（全部 JSON，前缀 /api）：
 *
 * GET  /api/overview?days=30            -> Overview
 * GET  /api/sessions?limit=200&project= -> SessionSummary[]   按 lastActivityAt 倒序
 * GET  /api/sessions/:id                -> SessionDetail
 * GET  /api/live                        -> LiveState          前端每 2 秒轮询
 * GET  /api/config                      -> ClaudeConfigSnapshot
 * GET  /api/presets                     -> SchemeInfo[]       全局方案排第一（即使还没保存过），后面是各个项目方案，按最近保存排序
 * GET  /api/preset                      -> Preset
 * PUT  /api/preset        body: Preset  -> Preset
 * DELETE /api/preset?cwd=<项目目录>      -> { ok: true }       删除项目方案（只删 agentree 自己的记录，不动 Claude Code 的配置文件）。不能删全局方案
 * POST /api/preset/from-config          -> Preset             根据当前 Claude 配置生成预设（不保存）
 *      以上 GET / PUT / from-config 三个接口都接受查询参数 cwd=<项目目录>：带上表示项目方案，不带表示全局方案。
 *      项目方案的 from-config 只读这个项目自己的定义文件、settings.local.json 和 CLAUDE.md，不包含全局的
 * POST /api/reindex                     -> IndexStatus        触发一次增量扫描
 * GET  /api/version                     -> { api: number }    接口版本号，见 shared/version.ts。界面在写入之前核对
 * GET  /api/models                      -> ModelOption[]      价格表里的 Claude 模型加上本机用过的模型，按系列排、新版本在前
 */

// ─────────────────────────────────────────────────────────────
// 第二阶段：配置写入
// 所有写操作都走"先生成计划、用户看过差异、再应用"两步，没有直接写入的接口。
// ─────────────────────────────────────────────────────────────

export type ConfigScope = 'user' | 'project';

/** agent 定义文件里 agentree 负责管理的字段。其余 frontmatter 字段和正文原样保留 */
export interface AgentFields {
  description: string;
  /** null 表示删除这个字段，让 Claude Code 用默认值 */
  model: string | null;
  effort: string | null;
  /** 逗号分隔的工具名；null 表示删除这个字段（继承全部工具） */
  tools: string | null;
}

export interface AgentDefinitionDetail extends AgentDefinition {
  /** frontmatter 之后的正文，即系统提示词。frontmatter 和正文之间那个分隔用的空行不算在内，所以读出来的正文和写入时提交的一致 */
  body: string;
  /** frontmatter 里 agentree 不管理的其他字段名，仅用于展示 */
  otherFields: string[];
  /** 文件内容的 sha256，编辑时作为基线传回 */
  hash: string;
}

export type ConfigAction =
  | {
      type: 'agent.upsert';
      scope: ConfigScope;
      /** scope 为 project 时必填，且必须是索引里出现过的项目目录 */
      projectCwd: string | null;
      name: string;
      /** 改名时传原名；新建或不改名传 null */
      originalName: string | null;
      fields: AgentFields;
      /** 正文。传 null 表示保持原样（新建时用模板） */
      body: string | null;
      /** 编辑已有文件时传打开时的 hash；新建传 null */
      baseHash: string | null;
    }
  | { type: 'agent.delete'; filePath: string; baseHash: string }
  | { type: 'settings.mainModel'; value: string | null }
  | { type: 'settings.advisorModel'; value: string | null }
  | {
      type: 'settings.autoCompactWindow';
      /** token 数，100000 到 1000000 的整数；null 表示删除这个键，跟 Claude Code 默认 */
      value: number | null;
    }
  | {
      type: 'settings.effort';
      /** 要设置 effort 的模型完整 ID；null 表示写全局默认的 effortLevel */
      model: string | null;
      value: string | null;
    }
  | {
      type: 'claudeMd.rule';
      enabled: boolean;
      /** 规则正文；null 表示用默认文字：按已保存的全局方案生成，方案为空时用 advisor 三条 */
      text: string | null;
    }
  | {
      type: 'preset.apply';
      preset: Preset;
      /** 项目方案时是项目目录，必须是索引里出现过的会话目录；缺失或 null 表示全局方案 */
      projectCwd?: string | null;
      /** 是否同时写入 CLAUDE.md 规则 */
      includeRule: boolean;
      /**
       * 规则文字。缺失或 null：用按方案生成的文字（shared/rule.ts 的 defaultRuleText，项目方案叠加已保存的全局方案），
       * 已有规则块且文字不同时替换；生成的文字为空（方案里既没有子 agent 也没有 advisor）时不写规则块，已有的删除
       */
      ruleText?: string | null;
      /**
       * 为 true 时，把 agentree 以前写进去、现在方案里已经没有的东西移除：
       *   主模型、主 effort、advisor、自动压缩阈值：只有 agentree 上次应用时写过这个键，且这次预设里为 null，才删除。
       *     不是 agentree 写的键（用户自己写的、cc-switch 写的）永远不删
       *   includeRule 为 false，而 CLAUDE.md 里有 agentree 的规则块 -> 删除规则块
       * 不会删除任何 agent 定义文件（删除定义文件只能用 agent.delete）。
       * 缺失或 false 时保持旧行为：只增改，不移除。
       */
      prune?: boolean;
    };

export interface FileChange {
  filePath: string;
  kind: 'create' | 'modify' | 'delete';
  /** 修改前的完整内容；新建为 null */
  before: string | null;
  /** 修改后的完整内容；删除为 null */
  after: string | null;
  /** 生成计划时文件的 sha256；新建为 null */
  baseHash: string | null;
  /** 一句话说明改了什么，如"把 model 从 sonnet 改为 opus" */
  summary: string;
}

export interface PlanNote {
  level: CheckLevel;
  message: string;
}

export interface ChangePlan {
  id: string;
  createdAt: string;
  /** 计划 10 分钟后过期 */
  expiresAt: string;
  changes: FileChange[];
  /** 提示和警告，如"这个设置对桌面版可能不生效" */
  notes: PlanNote[];
  /** 有任何一项无法安全执行时为 true，此时不能应用 */
  blocked: boolean;
  /** blocked 的原因，如"settings.json 第 12 行第 3 列解析失败" */
  errors: string[];
  /**
   * 因为 baseHash 对不上而无法修改的文件路径，即文件在用户打开之后被别的程序改过。
   * 不为空时 blocked 一定为 true。前端据此提示"重新加载"，不要靠匹配 errors 里的文字判断
   */
  conflicts: string[];
}

/**
 * conflict    文件在生成计划之后被改过，重新生成计划即可
 * permission  没有写权限或文件被占用
 * not-allowed 路径不在写入白名单内
 * blocked     计划本身是 blocked 的
 * skipped     前面的文件失败后，这个文件没有执行
 * io          其他读写错误
 */
export type ApplyFailureCode = 'conflict' | 'permission' | 'not-allowed' | 'blocked' | 'skipped' | 'io';

export interface ApplyResult {
  planId: string;
  applied: {
    filePath: string;
    kind: FileChange['kind'];
    backupId: string | null;
    /** 备份文件的完整路径 */
    backupPath: string | null;
  }[];
  /** 包含因为前面失败而没有执行的文件（code 为 skipped），这样 applied 加 failed 等于计划里的全部文件 */
  failed: { filePath: string; code: ApplyFailureCode; reason: string }[];
  /** 应用后的最新配置快照 */
  config: ClaudeConfigSnapshot;
  /**
   * 计划来自 preset.apply 且没有失败项时，后端会把这份预设同时保存为检查标准，并记录应用时间。
   * 这里返回保存后的预设；其他情况为 null
   */
  preset?: Preset | null;
}

export interface BackupEntry {
  id: string;
  /** 被备份的原文件路径 */
  filePath: string;
  createdAt: string;
  /** first-write 是 agentree 第一次改这个文件前的原件，永久保留 */
  kind: 'first-write' | 'pre-change';
  /** 备份时原文件是否存在；不存在表示那次操作是新建 */
  existedBefore: boolean;
  size: number;
}

export interface ClaudeMdRuleState {
  filePath: string;
  fileExists: boolean;
  /** 文件里是否有 agentree 管理的规则块 */
  enabled: boolean;
  /** 当前规则块里的正文；没有则为 null */
  text: string | null;
  /** 按已保存的方案生成的默认文字（项目叠加全局方案）；方案里既没有子 agent 也没有 advisor 时是兜底的 advisor 三条 */
  defaultText: string;
  /** 标记损坏（不成对或重复）时的说明；正常为 null。不为 null 时界面应禁用开关并提示用户手动处理 */
  error: string | null;
}

/**
 * 生效检查：回答"搭好的方案写进去了吗、实际运行时用上了吗"。
 * 每一项分两步判断：written（配置文件里是不是这个值）和 observed（之后的实际运行里是不是这个值）。
 */
export type EffectKind = 'main-model' | 'main-effort' | 'main-compact' | 'advisor' | 'rule' | 'agent' | 'agent-dispatch';

export interface EffectWritten {
  /**
   * yes      配置文件里的值和方案一致
   * no       配置文件里没有这一项（还没应用）
   * differs  配置文件里有，但和方案不一样
   * extra    方案里没有这一项，但配置文件里有，而且是 agentree 以前写进去的。应用时会移除
   * n/a      这一项不需要写入：方案里没指定（配置里的值不是 agentree 写的就不动它），或者是内置类型
   */
  state: 'yes' | 'no' | 'differs' | 'extra' | 'n/a';
  /** 涉及的文件；没有为 null */
  filePath: string | null;
  /** 配置文件里现在的值，给人看的短文本；没有为 null */
  actual: string | null;
  /** 不一致的字段名，如 ['model', 'tools', 'prompt']；只在 agent 上有多项 */
  diffs: string[];
}

/**
 * 只对子 agent 有意义：定义文件写入之后，有没有会话把它加载进来。
 * 依据是日志里的 agent_listing_delta 记录（会话可用的 agent 类型清单）。
 */
export interface EffectLoaded {
  /**
   * yes      起点之后有会话的可用类型清单里出现了它
   * no       起点之后有会话在运行，但它们的清单里都没有它
   * unknown  起点之后还没有任何会话记录，或者日志里没有清单记录
   * n/a      不是子 agent，或者是内置类型
   */
  state: 'yes' | 'no' | 'unknown' | 'n/a';
  /** 清单里有它的会话数 */
  count: number;
  lastSeenAt: string | null;
  lastSessionId: string | null;
}

export interface EffectObserved {
  /**
   * match     之后的运行里出现过，且符合方案
   * mismatch  之后的运行里出现过，但不符合方案
   * not-seen  之后还没有出现过（还没新开会话，或主会话没派发过这个 agent；自动压缩阈值是还没有会话的上下文达到过阈值）
   * n/a       无法从日志判断（如 CLAUDE.md 规则是否被读到）
   */
  state: 'match' | 'mismatch' | 'not-seen' | 'n/a';
  /** 统计的起点：上次应用的时间，没应用过则是预设保存的时间；都没有为 null（统计全部历史） */
  since: string | null;
  /** 起点之后出现的次数：主会话类的项是会话数，agent 是被派发的次数，advisor 是被调用的次数，自动压缩阈值是自动压缩过的会话数 */
  count: number;
  /** 其中符合方案的次数 */
  matched: number;
  /** 实际出现过的值（模型名、effort 值、自动压缩前的 token 数），按出现次数从多到少 */
  actual: string[];
  lastSeenAt: string | null;
  /** 最近一次出现所在的会话，前端用来跳转 */
  lastSessionId: string | null;
}

export interface EffectItem {
  /** 'main.model'、'main.effort'、'main.compact'、'advisor'、'rule'、'agent:<name>'、'agent:<name>:dispatch'（它往下派发时指定的模型） */
  key: string;
  kind: EffectKind;
  /** agent 的名字；其他为 null */
  name: string | null;
  /** 方案里期望的值，给人看的短文本；没指定为 null */
  expected: string | null;
  written: EffectWritten;
  loaded: EffectLoaded;
  observed: EffectObserved;
  /**
   * 写入配置文件对这一项有没有用。
   * 桌面版启动会话时自己指定模型和 effort，不读配置文件里的值，所以最近的会话都来自桌面版时，
   * 主模型和主 effort 这两项为 false：written 为 yes 也不代表会生效，要靠 nextStep 里的手动步骤
   */
  writeEffective: boolean;
  /** 一句话结论，中文 */
  summary: string;
  /** 需要用户自己动手的下一步（如"在桌面版的模型选择器里选 Opus 5.5"）；不需要为 null */
  nextStep: string | null;
}

export interface EffectReport {
  generatedAt: string;
  /** 检查的是哪份方案 */
  scheme: SchemeRef;
  /** 上次通过 agentree 应用方案的时间；没应用过为 null */
  appliedAt: string | null;
  /** observed 的统计起点，同 EffectObserved.since */
  since: string | null;
  /** 起点之后开始的会话数 */
  sessionsSince: number;
  /** 起点之后最近一个会话的入口，如 claude-desktop、cli；没有为 null */
  lastEntrypoint: string | null;
  items: EffectItem[];
  /** 会让方案失效的外部因素：环境变量覆盖、cc-switch 等 */
  blockers: PlanNote[];
}

/** 现成的子 agent 模板，搭建页的"添加节点"菜单用 */
export interface AgentTemplateInfo {
  name: string;
  /** 菜单里显示的短说明，如"读代码" */
  label: string;
  description: string;
  tools: string | null;
  disallowedTools: string | null;
  prompt: string;
}

export interface PresetTemplate {
  id: string;
  name: string;
  description: string;
  preset: Preset;
  includeRule: boolean;
}

/**
 * 第二阶段接口。所有会写入的接口（方法不是 GET 的）都必须带请求头 X-Agentree-Token。
 * 第一阶段的 PUT /api/preset 和 POST /api/reindex 也补上这个要求。
 *
 * GET  /api/token                         -> { token: string }   仅同源可读
 * GET  /api/config/agent?path=<filePath>  -> AgentDefinitionDetail
 * GET  /api/config/rule                   -> ClaudeMdRuleState
 * GET  /api/config/templates              -> PresetTemplate[]
 * POST /api/config/plan    body: { actions: ConfigAction[] } -> ChangePlan
 * POST /api/config/apply   body: { planId: string }          -> ApplyResult
 * GET  /api/config/backups                -> BackupEntry[]      按时间倒序
 * POST /api/config/restore body: { backupId: string }        -> ChangePlan   恢复也要走计划
 * GET  /api/config/agent-templates        -> AgentTemplateInfo[]
 * GET  /api/config/rule 接受查询参数 cwd=<项目目录>，返回这个项目 CLAUDE.md 里的规则状态
 * POST /api/config/effect  body: { preset: Preset, includeRule: boolean, ruleText?: string | null, projectCwd?: string | null } -> EffectReport
 *      带 projectCwd 时检查的是项目方案：written 看项目自己的文件，loaded 和 observed 只统计这个项目目录下的会话
 *      只读，不写任何文件，也不生成计划。用 POST 是因为要带预设正文。
 *      preset 是画布上当前的方案（可能还没保存）。
 */

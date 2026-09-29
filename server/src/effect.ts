// 生效检查：搭好的方案写进配置了吗（written）、新会话加载了吗（loaded）、之后的实际运行用上了吗（observed）。
// 只读：不写任何文件，也不生成、不保存计划。
// written 的判断直接复用 planner 里 preset.apply 的同一段逻辑，保证结论和"现在用 prune: true 点应用会不会改动"一致。
// observed 用索引数据库（经 Analyzer 还原会话树），不重新解析日志；模型和 effort 是否符合沿用 conformance.ts 的判断。
// 返回内容里不放提示词正文和对话正文，actual 只放模型名、effort 值之类的短文本。
import path from 'node:path';
import type {
  EffectItem,
  EffectKind,
  EffectLoaded,
  EffectObserved,
  EffectReport,
  EffectWritten,
  PlanNote,
  Preset,
  PresetAgent,
  SessionDetail,
} from '../../shared/types.ts';
import type { Analyzer } from './aggregate.ts';
import { BUILTIN_AGENT_TYPES, claudeConfigDirs } from './config.ts';
import { checkEffort, checkModel, matchModel, normalizeDir, normalizeModel, owningProject } from './conformance.ts';
import type { Store } from './db.ts';
import { enableRule, findRuleBlock, RuleBlockError } from './config/claudeMd.ts';
import { parseAgentDoc } from './config/frontmatter.ts';
import { nodeAt, parseJsonDoc, type JsonDoc } from './config/jsonEdit.ts';
import { isConfigDirProject, isKnownProjectCwd, PathError, projectClaudeMdPath, projectSettingsPath, validateAgentName } from './config/paths.ts';
import {
  applyPresetAgent,
  effectiveRuleText,
  effortPath,
  envNotes,
  findAgentFile,
  mainEffortLocation,
  describeJsonNode,
  pruneDecisions,
  type PruneDecision,
  type PlanContext,
} from './config/planner.ts';
import { readTextFile } from './config/text.ts';
import { validatePreset, type AppliedRecord } from './preset.ts';

// ---------------- 措辞（集中定义，方便以后调整） ----------------

/**
 * 全部措辞。hasSince 为 false 时没有统计起点（从没应用过、预设也没保存过），统计的是全部历史，
 * 这时不能说"之后"，统一换成"到目前为止"。
 */
export function effectText(hasSince: boolean) {
  const after = hasSince ? '之后' : '到目前为止';
  return {
    applyHint: '点"应用"写入配置。',
    // 桌面版：启动会话时自己带 --model / --effort，不读配置文件里的值
    desktopMainModel: '桌面版不读配置文件里的主模型，每个会话用的是发送框旁边选择器里选的模型。',
    desktopMainEffort: '桌面版不读配置文件里的 effort，每个会话用的是发送框旁边选择器里选的 effort。',
    desktopRecentMatch: (x: string) => `最近的会话用的正是 ${x}。`,
    desktopRecentMismatch: (actual: string, x: string) => `最近的会话用的是 ${actual}，不是 ${x}。`,
    desktopNotSeen: hasSince ? '之后还没有新的会话。' : '到目前为止没有会话记录。',
    desktopPickModel: (x: string) => `新开会话时，在发送框旁边的模型选择器里选 ${x}。`,
    desktopPickEffort: (x: string) => `新开会话时，在发送框旁边的 effort 选择器里选 ${x}。`,
    mainMatch: (count: number, x: string) => `已写入。${after}开始的 ${count} 个会话里，最近一个用的正是 ${x}。`,
    mainMismatch: (actual: string, x: string) => `已写入，但最近的会话用的是 ${actual}，不是 ${x}。`,
    writtenNoSession: hasSince ? '已写入，之后还没有新的会话。' : '已写入，到目前为止没有会话记录。',
    advisorDesktopUnverified: '已写入配置文件。桌面版是否读取这个设置还没有验证。',
    advisorSlash: (x: string) => `如果新会话里没有生效，可以在对话里输入 /advisor ${x} 来指定。`,
    advisorCalled: (n: number) => `已写入。${after} advisor 被调用了 ${n} 次。`,
    advisorNotCalled: `已写入。${after}的会话已配置了 advisor，但还没有被调用过。`,
    advisorMismatch: (actual: string, x: string) => `已写入，但${after}会话记录上的 advisor 是 ${actual}，不是 ${x}。`,
    advisorMissing: `已写入，但${after}的会话记录上没有 advisor。`,
    ruleAdvisorCalls: (n: number) => `${after} advisor 被调用了 ${n} 次。`,
    agentLoadedUnknown: '已写入。新开一个会话后，这里会显示它有没有被加载。',
    agentNotLoaded: `已写入，但${after}的会话都没有加载它。`,
    agentReopen: '已经开着的会话可能要重新打开才能加载。新开一个会话试试。',
    agentLoadedNotDispatched: '已写入，新会话已经加载了它，但主会话还没有派发过它。',
    agentMention: (name: string) => `可以在对话里输入 @agent-${name} 加上任务，直接点名试一次。`,
    /** 全部符合（或没什么可比的）：只检查了模型或 effort、都没指定时措辞相应调整。不带"已生效。"前缀 */
    agentMatch: (count: number, checkedModel: boolean, checkedEffort: boolean) => {
      if (checkedModel && checkedEffort) return `${after}被派发 ${count} 次，模型和 effort 都符合。`;
      if (checkedModel) return `${after}被派发 ${count} 次，模型都符合。`;
      if (checkedEffort) return `${after}被派发 ${count} 次，effort 都符合。`;
      return `${after}被派发 ${count} 次。`;
    },
    agentMismatch: (count: number, bad: number, actual: string) => `${after}被派发 ${count} 次，其中 ${bad} 次不符合：实际用的是 ${actual}。`,
    agentNotDispatched: `${after}还没有被派发过。`,
    builtinPrefix: (name: string) => `${name} 是内置类型，不需要写入。`,
    agentOverride: '主会话派发时可以另外指定模型，那样会盖过定义文件里的设置。到会话页查看那次派发的详情。',
    fixRuleMarkers: '请先手动修复 CLAUDE.md 里 agentree 的规则标记，再点"应用"。',
  };
}

export type EffectTexts = ReturnType<typeof effectText>;

/** 有统计起点时的措辞 */
export const EFFECT_TEXT = effectText(true);

const FIELD_LABEL: Record<string, string> = {
  model: '模型',
  effort: 'effort',
  description: '描述',
  tools: '工具白名单',
  disallowedTools: '工具黑名单',
  prompt: '系统提示词',
};

// ---------------- 输入 ----------------

export interface EffectInput {
  preset: unknown;
  includeRule: unknown;
  ruleText?: unknown;
  /** 项目方案时是项目目录；缺失或 null 表示全局方案 */
  projectCwd?: unknown;
}

export interface EffectDeps {
  store: Store;
  analyzer: Analyzer;
  /** knownCwds、环境变量、cc-switch、applied.json 的记录（项目的应用记录用 ctx.projectApplied） */
  ctx: PlanContext;
  /** 已保存的项目方案：决定每个会话归哪个项目，以及全局方案要排除哪些会话 */
  projects?: Array<{ projectCwd: string; preset: Preset }>;
  now?: number;
}

export class EffectInputError extends Error {}

// ---------------- 工具函数 ----------------

function tsMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** 按出现次数从多到少 */
function byFrequency(values: string[]): string[] {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

function sameType(a: string | null, name: string): boolean {
  return a !== null && (a === name || a.toLowerCase() === name.toLowerCase());
}

function isBuiltin(name: string): boolean {
  return BUILTIN_AGENT_TYPES.some((b) => b.toLowerCase() === name.toLowerCase());
}

const NA_LOADED: EffectLoaded = { state: 'n/a', count: 0, lastSeenAt: null, lastSessionId: null };

function observedNA(since: string | null): EffectObserved {
  return { state: 'n/a', since, count: 0, matched: 0, actual: [], lastSeenAt: null, lastSessionId: null };
}

// ---------------- 会话数据 ----------------

interface SessionRow {
  sid: string;
  cwd: string | null;
  started: string | null;
  last: string | null;
  entrypoint: string | null;
}

/**
 * 统计范围。projectCwd 为 null 是全局方案：统计所有会话，但属于某个项目方案的会话里、那个项目方案接管了的项
 * （同名 agent，或指定了的主模型 / effort / advisor）不计入。projectCwd 有值时只统计属于这个项目的会话
 * （等于或在其下，且没有被更深一层的另一个项目方案接管）
 */
export interface SessionScope {
  projectCwd: string | null;
  projects: Array<{ projectCwd: string; preset: Preset }>;
}

class Sessions {
  private details = new Map<string, SessionDetail | null>();
  readonly rows: SessionRow[];
  /** 起点之后开始的会话，按开始时间从早到晚 */
  readonly startedSince: SessionRow[];
  /** 起点之后有活动的会话（子 agent 按自己的开始时间筛，会话可能更早开始） */
  readonly activeSince: SessionRow[];

  /** 全局方案时：会话所属的项目方案（没有为 null），用来排除被项目接管的项 */
  private owners = new Map<string, Preset | null>();

  constructor(
    private store: Store,
    /** 只判断会话入口时不需要，传 null */
    private analyzer: Analyzer | null,
    readonly sinceMs: number | null,
    scope: SessionScope = { projectCwd: null, projects: [] },
  ) {
    const all = store.db
      .prepare(
        `SELECT f.session_id AS sid, s.cwd AS cwd, MIN(f.first_ts) AS started, MAX(f.last_ts) AS last, s.entrypoint AS entrypoint
         FROM files f LEFT JOIN sessions s ON s.session_id = f.session_id GROUP BY f.session_id`,
      )
      .all() as unknown as SessionRow[];
    if (scope.projectCwd !== null) {
      // 这个项目的会话：在它和已保存的项目方案里取最长匹配，结果是它自己
      const target = normalizeDir(scope.projectCwd);
      const roots = [scope.projectCwd, ...scope.projects.map((p) => p.projectCwd)];
      this.rows = all.filter((r) => {
        const owner = owningProject(r.cwd, roots);
        return owner !== null && normalizeDir(owner) === target;
      });
    } else {
      this.rows = all;
      const roots = scope.projects.map((p) => p.projectCwd);
      for (const r of all) {
        const owner = owningProject(r.cwd, roots);
        this.owners.set(r.sid, owner === null ? null : scope.projects.find((p) => p.projectCwd === owner)!.preset);
      }
    }
    this.startedSince = this.rows.filter((r) => this.after(r.started)).sort((a, b) => (tsMs(a.started) ?? 0) - (tsMs(b.started) ?? 0));
    this.activeSince = this.rows.filter((r) => this.after(r.last));
  }

  after(ts: string | null | undefined): boolean {
    if (this.sinceMs === null) return true;
    const t = tsMs(ts);
    return t !== null && t >= this.sinceMs;
  }

  detail(sid: string): SessionDetail | null {
    if (!this.details.has(sid)) this.details.set(sid, this.analyzer?.sessionDetail(sid) ?? null);
    return this.details.get(sid) ?? null;
  }

  /** 最近的会话是否全部来自桌面版：取起点之后开始的会话；没有就取索引里最近的 20 个。索引里没有会话时为 false */
  desktopOnly(): boolean {
    const recent = this.startedSince.length
      ? this.startedSince
      : [...this.rows].sort((a, b) => (tsMs(b.last) ?? 0) - (tsMs(a.last) ?? 0)).slice(0, 20);
    return recent.length > 0 && recent.every((r) => r.entrypoint === 'claude-desktop');
  }

  /** 起点之后，统计范围内的会话是否有任何活动（有 assistant 请求） */
  hasActivity(): boolean {
    const rows = (this.sinceMs === null
      ? this.store.db.prepare('SELECT DISTINCT session_id AS sid FROM requests').all()
      : this.store.db.prepare('SELECT DISTINCT session_id AS sid FROM requests WHERE ts >= ?').all(new Date(this.sinceMs).toISOString())) as Array<{ sid: string }>;
    const inScope = new Set(this.rows.map((r) => r.sid));
    return rows.some((r) => inScope.has(r.sid));
  }

  /** 会话是否在统计范围内 */
  has(sid: string): boolean {
    return this.rows.some((r) => r.sid === sid);
  }

  /** 全局方案时：这个会话所属的项目方案是否接管了主模型 / 主 effort / advisor 这一项 */
  takenOverMain(sid: string, item: 'model' | 'effort' | 'advisor'): boolean {
    const p = this.owners.get(sid);
    if (!p) return false;
    return (item === 'model' ? p.main.model : item === 'effort' ? p.main.effort : p.advisor.model) !== null;
  }

  /** 全局方案时：这个会话所属的项目方案里有没有同名 agent（有则那次派发用的是项目的定义） */
  takenOverAgent(sid: string, name: string): boolean {
    const p = this.owners.get(sid);
    return !!p && p.agents.some((a) => a.name.toLowerCase() === name.toLowerCase());
  }
}

/**
 * 最近的会话是否全部来自桌面版：取起点之后开始的会话，没有就取索引里最近的 20 个；索引里没有会话时为 false。
 * 生效检查的 writeEffective 和计划里的桌面版提示用同一个判断
 */
export function recentSessionsDesktopOnly(store: Store, since: string | null): boolean {
  return new Sessions(store, null, tsMs(since)).desktopOnly();
}

// ---------------- 主会话类（主模型、主 effort、advisor） ----------------

interface Sample {
  sid: string;
  at: string | null;
  value: string;
  ok: boolean;
  weight: number;
}

/** 由按时间排好的样本得到 observed；lastValue 是最近一个样本的值（actual 按频率排序，取不到最近的） */
function observedFrom(samples: Sample[], expected: string | null, since: string | null, count?: number): { observed: EffectObserved; lastValue: string | null } {
  const last = samples[samples.length - 1] ?? null;
  const total = count ?? samples.length;
  return {
    observed: {
      state: expected === null ? 'n/a' : last === null ? 'not-seen' : last.ok ? 'match' : 'mismatch',
      since,
      count: total,
      matched: expected === null ? 0 : samples.filter((s) => s.ok).reduce((n, s) => n + s.weight, 0),
      actual: byFrequency(samples.map((s) => s.value)),
      lastSeenAt: last?.at ?? null,
      lastSessionId: last?.sid ?? null,
    },
    lastValue: last?.value ?? null,
  };
}

/** 中文里夹英文词时两侧加空格 */
function spaced(label: string, left: boolean, right: boolean): string {
  return `${left && /^[A-Za-z]/.test(label) ? ' ' : ''}${label}${right && /[A-Za-z]$/.test(label) ? ' ' : ''}`;
}

// ---------------- 主函数 ----------------

export function effectReport(input: EffectInput, deps: EffectDeps): EffectReport {
  let preset: Preset;
  try {
    preset = validatePreset(input.preset);
  } catch (e) {
    throw new EffectInputError(`预设不合法：${(e as Error).message}`);
  }
  if (typeof input.includeRule !== 'boolean') throw new EffectInputError('includeRule 必须是布尔值');
  const ruleText = input.ruleText;
  if (ruleText !== undefined && ruleText !== null && typeof ruleText !== 'string') throw new EffectInputError('ruleText 必须是字符串或 null');
  const includeRule = input.includeRule;
  let projectCwd: string | null = null;
  if (input.projectCwd !== undefined && input.projectCwd !== null) {
    if (typeof input.projectCwd !== 'string' || !path.isAbsolute(input.projectCwd)) throw new EffectInputError('projectCwd 必须是项目目录的绝对路径');
    if (!isKnownProjectCwd(input.projectCwd, deps.ctx.knownCwds)) throw new EffectInputError(`项目目录 ${input.projectCwd} 没有在索引过的会话里出现过`);
    if (isConfigDirProject(input.projectCwd)) throw new EffectInputError(`${input.projectCwd} 下的 .claude 就是全局配置目录，这个目录不能用项目方案`);
    projectCwd = input.projectCwd;
  }
  // 这份方案自己的应用记录：项目方案用项目的，全局方案用 applied.json
  const applied: AppliedRecord | null = projectCwd === null ? deps.ctx.applied ?? null : deps.ctx.projectApplied?.(projectCwd) ?? null;
  const since = applied?.appliedAt ?? preset.updatedAt ?? null;
  // 没有起点时统计全部历史，措辞里不说"之后"
  const T = effectText(since !== null);
  const sessions = new Sessions(deps.store, deps.analyzer, tsMs(since), { projectCwd, projects: deps.projects ?? [] });
  const desktopOnly = sessions.desktopOnly();
  const configDir = claudeConfigDirs()[0];

  // ---------- settings.json（项目方案是 <项目>/.claude/settings.local.json） ----------
  const settingsPath = projectCwd === null ? path.join(configDir, 'settings.json') : projectSettingsPath(projectCwd);
  const sf = readTextFile(settingsPath);
  let settings: JsonDoc | null = null;
  let settingsError: string | null = null;
  if (sf.exists) {
    if (sf.text === null) settingsError = 'settings.json 不是 UTF-8 编码的文本';
    else {
      try {
        settings = parseJsonDoc(sf.text);
      } catch (e) {
        settingsError = (e as Error).message;
      }
    }
  }
  const node = (p: string[]) => (settings ? nodeAt(settings, p) : undefined);
  const shortValue = (p: string[]): string | null => {
    const n = node(p);
    return n ? describeJsonNode(n) : null;
  };
  // prune 时的判断（和 planner 用同一个函数）：remove 会被移除；changed 是 agentree 写过、但之后被改过的，不会动
  const decisions = settings ? pruneDecisions(preset, applied, node) : [];

  /** settings.json 里一个键的写入状态。和 planner 的判断一致：值相同（字符串）才算不需要改 */
  const settingsWritten = (expected: string | null, p: string[], decision: PruneDecision | undefined): EffectWritten & { owned: boolean } => {
    const base = { filePath: settingsPath, diffs: [] as string[] };
    if (settingsError) return { ...base, state: expected !== null ? 'differs' : 'n/a', actual: null, owned: false };
    if (expected !== null) {
      const n = node(p);
      if (!n) return { ...base, state: 'no', actual: null, owned: false };
      return { ...base, state: n.type === 'string' && n.value === expected ? 'yes' : 'differs', actual: shortValue(p), owned: false };
    }
    if (decision?.status === 'remove') return { ...base, state: 'extra', actual: decision.current, owned: true };
    // 值被改过：已经不是 agentree 的，不会动
    if (decision?.status === 'changed') return { ...base, state: 'n/a', actual: decision.current, owned: false };
    const v = shortValue(p);
    return { ...base, state: 'n/a', actual: v, owned: false };
  };

  const items: EffectItem[] = [];

  // ---------- 主模型 ----------
  {
    const expected = preset.main.model;
    const w = settingsWritten(expected, ['model'], decisions.find((t) => t.item === 'model'));
    const samples: Sample[] = [];
    for (const r of sessions.startedSince) {
      if (sessions.takenOverMain(r.sid, 'model')) continue;
      const d = sessions.detail(r.sid);
      const m = d?.summary.mainModel ?? null;
      if (!d || !m) continue;
      const ok = expected !== null && checkModel(expected, [m], m)?.level === 'ok';
      samples.push({ sid: r.sid, at: d.summary.startedAt, value: m, ok, weight: 1 });
    }
    const obs = observedFrom(samples, expected, since);
    items.push(
      mainItem(T, 'main.model', 'main-model', '主模型', expected, w, obs, !desktopOnly, settingsError, {
        desktop: T.desktopMainModel,
        pick: T.desktopPickModel,
      }),
    );
  }

  // ---------- 主 effort ----------
  {
    const expected = preset.main.effort;
    const loc = mainEffortLocation(preset.main.model);
    const target = effortPath(loc);
    const rec = decisions.find((t) => t.item === 'effort');
    let w: EffectWritten & { owned: boolean };
    if (expected === null) {
      w = settingsWritten(null, target, rec);
      // 没有记录、也不在主模型对应的位置时，看看顶层有没有（只用于显示）
      if (w.state === 'n/a' && w.actual === null && !settingsError) w = { ...w, actual: shortValue(['effortLevel']) };
    } else {
      w = settingsWritten(expected, target, undefined);
      // effort 换了位置：新位置已经是这个值，但旧位置还留着 agentree 上次写的，应用时会移除，所以不算一致
      if (w.state === 'yes' && rec?.status === 'remove') w = { ...w, state: 'differs', actual: `${w.actual}（旧位置 ${rec.path.join('.')} 还有一份）` };
    }
    const samples: Sample[] = [];
    for (const r of sessions.startedSince) {
      if (sessions.takenOverMain(r.sid, 'effort')) continue;
      const d = sessions.detail(r.sid);
      const e = d?.summary.mainEffort ?? null;
      if (!d || !e) continue;
      const ok = expected !== null && checkEffort(expected, [e])?.level === 'ok';
      samples.push({ sid: r.sid, at: d.summary.startedAt, value: e, ok, weight: 1 });
    }
    const obs = observedFrom(samples, expected, since);
    const item = mainItem(T, 'main.effort', 'main-effort', '主会话 effort', expected, w, obs, !desktopOnly, settingsError, {
      desktop: T.desktopMainEffort,
      pick: T.desktopPickEffort,
    });
    if (expected === 'max') item.summary += ' settings.json 不接受 max，应用前请改为 xhigh 或更低。';
    items.push(item);
  }

  // ---------- advisor ----------
  let advisorCallsSince = 0;
  {
    const expected = preset.advisor.model;
    const w = settingsWritten(expected, ['advisorModel'], decisions.find((t) => t.item === 'advisorModel'));
    const samples: Sample[] = [];
    for (const r of sessions.startedSince) {
      if (sessions.takenOverMain(r.sid, 'advisor')) continue;
      const d = sessions.detail(r.sid);
      if (!d || !d.summary.mainModel) continue; // 还没有请求的会话看不出 advisor 配置
      advisorCallsSince += d.summary.advisorCalls;
      const annot = d.agents[0]?.advisorModel ?? d.agents.find((n) => n.advisorModel)?.advisorModel ?? null;
      let ok = false;
      if (expected !== null && annot) {
        // 桌面会话里这个字段经常等于主模型：等于主模型、又不是期望值本身时，不能当作配置了期望的 advisor
        const mirrorsMain = normalizeModel(annot) === normalizeModel(d.summary.mainModel) && normalizeModel(annot) !== normalizeModel(expected);
        ok = !mirrorsMain && matchModel(expected, annot).level === 'ok';
      }
      samples.push({ sid: r.sid, at: d.summary.startedAt, value: annot ?? '（没有 advisor）', ok, weight: d.summary.advisorCalls });
    }
    const { observed } = observedFrom(samples, expected, since, samples.reduce((n, s) => n + s.weight, 0));
    observed.actual = observed.actual.filter((v) => v !== '（没有 advisor）');
    items.push(advisorItem(T, expected, w, observed, desktopOnly, settingsError));
  }

  // ---------- CLAUDE.md 规则 ----------
  items.push(ruleItem(T, projectCwd === null ? path.join(configDir, 'CLAUDE.md') : projectClaudeMdPath(projectCwd), includeRule, ruleText as string | null | undefined, since, advisorCallsSince));

  // ---------- 子 agent ----------
  const listing = loadedIndex(deps.store, sessions);
  for (const pa of preset.agents) {
    items.push(agentItem(T, pa, deps.ctx.knownCwds, projectCwd, sessions, listing, since));
  }

  // ---------- 外部因素 ----------
  const blockers: PlanNote[] = envNotes(deps.ctx, {
    modelKeys: preset.main.model !== null || preset.advisor.model !== null,
    effort: preset.main.effort !== null || preset.agents.some((a) => a.effort !== null),
    agentModel: preset.agents.some((a) => a.model !== null),
    advisor: preset.advisor.model !== null,
  });
  const subagentModel = deps.ctx.env.find((e) => e.name === 'CLAUDE_CODE_SUBAGENT_MODEL' && e.value !== null);
  const unspecified = preset.agents.filter((a) => a.model === null).map((a) => a.name);
  if (subagentModel && unspecified.length) {
    blockers.push({
      level: 'info',
      message: `设置了环境变量 CLAUDE_CODE_SUBAGENT_MODEL（${subagentModel.value}）：没有指定模型的 ${unspecified.join('、')} 会用这个环境变量指定的模型，而不是主会话的模型`,
    });
  }

  const latest = sessions.startedSince[sessions.startedSince.length - 1] ?? null;
  return {
    generatedAt: new Date(deps.now ?? Date.now()).toISOString(),
    scheme: projectCwd === null ? { scope: 'user', projectCwd: null } : { scope: 'project', projectCwd },
    appliedAt: applied?.appliedAt ?? null,
    since,
    sessionsSince: sessions.startedSince.length,
    lastEntrypoint: latest?.entrypoint ?? null,
    items,
    blockers,
  };
}

// ---------------- 各项的结论 ----------------

function writtenSummary(label: string, expected: string | null, w: EffectWritten, settingsError: string | null): string | null {
  if (settingsError) return `settings.json 无法解析（${settingsError}），agentree 不会修改它，请先手动修好。`;
  switch (w.state) {
    case 'no':
      return '还没有写入。';
    case 'differs':
      return `配置文件里的${spaced(label, true, true)}是 ${w.actual ?? '（空）'}，和方案不一样。`;
    case 'extra':
      return `方案没有指定${spaced(label, true, false)}，但配置文件里还有 agentree 上次写入的 ${w.actual}，应用时会移除。`;
    case 'n/a':
      if (expected === null) {
        return w.actual !== null
          ? `方案没有指定${spaced(label, true, false)}。配置文件里现在是 ${w.actual}，不是 agentree 写的，不会动它。`
          : `方案没有指定${spaced(label, true, false)}。`;
      }
      return null;
    default:
      return null;
  }
}

function mainItem(
  T: EffectTexts,
  key: string,
  kind: EffectKind,
  label: string,
  expected: string | null,
  w: EffectWritten & { owned: boolean },
  obs: { observed: EffectObserved; lastValue: string | null },
  writeEffective: boolean,
  settingsError: string | null,
  text: { desktop: string; pick: (x: string) => string },
): EffectItem {
  const { owned: _o, ...written } = w;
  const { observed, lastValue } = obs;
  let summary: string;
  let nextStep: string | null = null;
  const needsApply = w.state === 'no' || w.state === 'differs' || w.state === 'extra';
  if (expected !== null && !writeEffective) {
    // 最近的会话都来自桌面版：写配置文件对它没用（写不写都照实给 written），要在选择器里选
    const tail =
      observed.state === 'match'
        ? T.desktopRecentMatch(expected)
        : observed.state === 'mismatch'
          ? T.desktopRecentMismatch(lastValue ?? '（未知）', expected)
          : T.desktopNotSeen;
    summary = text.desktop + tail;
    if (observed.state !== 'match') nextStep = text.pick(expected);
  } else {
    const ws = writtenSummary(label, expected, w, settingsError);
    if (ws !== null) summary = ws;
    else if (observed.state === 'match') summary = T.mainMatch(observed.count, expected!);
    else if (observed.state === 'mismatch') summary = T.mainMismatch(lastValue ?? '（未知）', expected!);
    else summary = T.writtenNoSession;
    if (needsApply && !settingsError) nextStep = T.applyHint;
  }
  return { key, kind, name: null, expected, written, loaded: NA_LOADED, observed, writeEffective, summary, nextStep };
}

function advisorItem(
  T: EffectTexts,
  expected: string | null,
  w: EffectWritten & { owned: boolean },
  observed: EffectObserved,
  desktopOnly: boolean,
  settingsError: string | null,
): EffectItem {
  const { owned: _o, ...written } = w;
  let summary: string;
  let nextStep: string | null = null;
  const ws = writtenSummary('advisor', expected, w, settingsError);
  if (ws !== null) {
    summary = ws;
    if ((w.state === 'no' || w.state === 'differs' || w.state === 'extra') && !settingsError) nextStep = T.applyHint;
  } else if (desktopOnly && observed.state !== 'match') {
    summary = T.advisorDesktopUnverified;
    nextStep = T.advisorSlash(expected!);
  } else if (observed.state === 'match') {
    summary = observed.count > 0 ? T.advisorCalled(observed.count) : T.advisorNotCalled;
  } else if (observed.state === 'mismatch') {
    summary = observed.actual.length
      ? T.advisorMismatch(observed.actual.join('、'), expected!)
      : T.advisorMissing;
  } else {
    summary = T.writtenNoSession;
  }
  return { key: 'advisor', kind: 'advisor', name: null, expected, written, loaded: NA_LOADED, observed, writeEffective: true, summary, nextStep };
}

function ruleItem(T: EffectTexts, filePath: string, includeRule: boolean, ruleText: string | null | undefined, since: string | null, advisorCalls: number): EffectItem {
  const f = readTextFile(filePath);
  const written: EffectWritten = { state: 'n/a', filePath, actual: null, diffs: [] };
  let summary: string;
  let nextStep: string | null = null;
  let error: string | null = null;
  let hasBlock = false;
  if (f.exists && f.text === null) error = 'CLAUDE.md 不是 UTF-8 编码的文本';
  else if (f.text) {
    try {
      hasBlock = findRuleBlock(f.text) !== null;
    } catch (e) {
      if (!(e instanceof RuleBlockError)) throw e;
      error = e.message;
    }
  }
  if (error) {
    written.state = 'differs';
    written.actual = '规则标记损坏';
    summary = `CLAUDE.md 里 agentree 的规则块有问题：${error}`;
    nextStep = T.fixRuleMarkers;
  } else {
    written.actual = hasBlock ? '有规则块' : '没有规则块';
    if (includeRule) {
      if (!hasBlock) written.state = 'no';
      else if (typeof ruleText === 'string') {
        // 和 planner 一样：用这段文案重写规则块，结果和现在不同就是文案不一样
        written.state = enableRule(f.text!, effectiveRuleText(ruleText)) === f.text ? 'yes' : 'differs';
      } else written.state = 'yes';
    } else {
      written.state = hasBlock ? 'extra' : 'n/a';
    }
    if (written.state === 'yes') summary = '已写入 CLAUDE.md。';
    else if (written.state === 'no') summary = 'CLAUDE.md 里还没有 advisor 规则。';
    else if (written.state === 'differs') summary = 'CLAUDE.md 里的规则文案和方案不一样。';
    else if (written.state === 'extra') summary = '方案不包含规则，但 CLAUDE.md 里还有 agentree 的规则块，应用时会移除。';
    else summary = '方案不包含规则。';
    if (written.state === 'no' || written.state === 'differs' || written.state === 'extra') nextStep = T.applyHint;
    if (written.state === 'yes' && advisorCalls > 0) summary += T.ruleAdvisorCalls(advisorCalls);
  }
  return {
    key: 'rule',
    kind: 'rule',
    name: null,
    expected: includeRule ? (typeof ruleText === 'string' ? '有规则块（自定义文案）' : '有规则块') : null,
    written,
    loaded: NA_LOADED,
    observed: observedNA(since),
    writeEffective: true,
    summary,
    nextStep,
  };
}

// ---------------- 子 agent ----------------

interface ListingIndex {
  /** 起点之后有清单记录的会话里，每个类型（小写）出现在哪些会话 */
  byType: Map<string, Array<{ sid: string; at: string | null }>>;
  /** 起点之后是否有任何清单记录 */
  any: boolean;
  /** 起点之后是否有任何会话活动 */
  activity: boolean;
}

/** 读 agent_listings：起点之后有清单记录（加入或移除）的会话，以及这些会话里加入过的类型 */
function loadedIndex(store: Store, sessions: Sessions): ListingIndex {
  const rows = store.db
    .prepare('SELECT session_id AS sid, agent_type AS type, first_added_at AS first, last_added_at AS last, removed_at AS removed FROM agent_listings')
    .all() as Array<{ sid: string; type: string; first: string | null; last: string | null; removed: string | null }>;
  const activeSids = new Set<string>();
  for (const r of rows) {
    if (!sessions.has(r.sid)) continue; // 不在统计范围内（项目方案只看这个项目的会话）
    if (sessions.after(r.first) || sessions.after(r.last) || (r.removed !== null && sessions.after(r.removed))) activeSids.add(r.sid);
  }
  const byType = new Map<string, Array<{ sid: string; at: string | null }>>();
  for (const r of rows) {
    if (!activeSids.has(r.sid)) continue;
    const k = r.type.toLowerCase();
    const list = byType.get(k) ?? [];
    list.push({ sid: r.sid, at: r.last ?? r.first });
    byType.set(k, list);
  }
  return { byType, any: activeSids.size > 0, activity: sessions.hasActivity() };
}

function agentItem(
  T: EffectTexts,
  pa: PresetAgent,
  knownCwds: string[],
  projectCwd: string | null,
  sessions: Sessions,
  listing: ListingIndex,
  since: string | null,
): EffectItem {
  const builtin = isBuiltin(pa.name);
  const expected = [pa.model !== null ? `model ${pa.model}` : null, pa.effort !== null ? `effort ${pa.effort}` : null].filter(Boolean).join('，') || null;
  const written: EffectWritten = { state: 'n/a', filePath: null, actual: null, diffs: [] };
  let writtenNote: string | null = null;
  if (!builtin) {
    try {
      validateAgentName(pa.name);
      const target = findAgentFile(pa.name, knownCwds, projectCwd);
      written.filePath = target.path;
      const f = readTextFile(target.path);
      if (!f.exists) written.state = 'no';
      else if (f.text === null) {
        written.state = 'differs';
        writtenNote = '定义文件不是 UTF-8 编码的文本，agentree 不会修改它。';
      } else {
        try {
          // 和 preset.apply 用同一个函数：改动的字段就是不一致的字段
          const doc = parseAgentDoc(f.text, f.bom);
          const { keys } = applyPresetAgent(doc, pa);
          const cur = parseAgentDoc(f.text, f.bom);
          const field = (k: string) => cur.fields.find((x) => x.key === k)?.value ?? null;
          written.actual = `model ${field('model') ?? '未指定'}，effort ${field('effort') ?? '未指定'}`;
          written.state = keys.length ? 'differs' : 'yes';
          written.diffs = keys;
        } catch (e) {
          written.state = 'differs';
          writtenNote = `定义文件的 frontmatter 格式异常（${(e as Error).message}），agentree 不会修改它，请手动处理。`;
        }
      }
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
      written.state = 'no';
      writtenNote = e.message;
    }
  }

  // observed：起点之后开始运行的、类型是这个名字的子 agent（按子 agent 自己的开始时间，定义文件会热加载）
  const dispatches: Array<{ sid: string; at: string | null; model: string | null; efforts: string[]; ok: boolean; bad: string | null }> = [];
  for (const r of sessions.activeSince) {
    // 全局方案：会话所属的项目方案里有同名 agent 时，那次派发用的是项目的定义，不计入
    if (sessions.takenOverAgent(r.sid, pa.name)) continue;
    const d = sessions.detail(r.sid);
    if (!d) continue;
    const mainModel = d.summary.mainModel;
    for (const n of d.agents) {
      if (n.kind !== 'subagent' || !sameType(n.agentType, pa.name) || !sessions.after(n.startedAt)) continue;
      const mc = checkModel(pa.model, n.primaryModel ? [n.primaryModel] : [], n.primaryModel, mainModel);
      const ec = checkEffort(pa.effort, n.efforts);
      const passes = (c: { level: string } | null) => !c || c.level === 'ok' || c.level === 'info';
      const ok = passes(mc) && passes(ec);
      const bad = ok
        ? null
        : [!passes(mc) ? n.primaryModel ?? '未知模型' : null, !passes(ec) ? `effort ${n.efforts.join('/')}` : null].filter(Boolean).join('，');
      dispatches.push({ sid: r.sid, at: n.startedAt, model: n.primaryModel, efforts: n.efforts, ok, bad });
    }
  }
  dispatches.sort((a, b) => (tsMs(a.at) ?? 0) - (tsMs(b.at) ?? 0));
  const last = dispatches[dispatches.length - 1] ?? null;
  // 指定了模型或 effort 时，全部符合才算 match；没什么可比的，派发过就算 match
  const matched = dispatches.filter((x) => x.ok).length;
  const models = (list: typeof dispatches) => byFrequency(list.map((x) => x.model).filter((m): m is string => m !== null));
  const badModels = models(dispatches.filter((x) => !x.ok));
  const observed: EffectObserved = {
    state: last === null ? 'not-seen' : matched === dispatches.length ? 'match' : 'mismatch',
    since,
    count: dispatches.length,
    matched,
    // 实际出现过的全部模型，不符合的排在前面
    actual: [...badModels, ...models(dispatches).filter((m) => !badModels.includes(m))],
    lastSeenAt: last?.at ?? null,
    lastSessionId: last?.sid ?? null,
  };

  // loaded：起点之后有清单记录的会话里有没有它
  let loaded: EffectLoaded = NA_LOADED;
  if (!builtin) {
    if (written.state !== 'yes') loaded = { state: 'unknown', count: 0, lastSeenAt: null, lastSessionId: null };
    else {
      const hits = (listing.byType.get(pa.name.toLowerCase()) ?? []).filter((h) => !sessions.takenOverAgent(h.sid, pa.name)).sort((a, b) => (tsMs(a.at) ?? 0) - (tsMs(b.at) ?? 0));
      const lastHit = hits[hits.length - 1] ?? null;
      if (hits.length) loaded = { state: 'yes', count: new Set(hits.map((h) => h.sid)).size, lastSeenAt: lastHit!.at, lastSessionId: lastHit!.sid };
      else if (observed.state === 'match' || observed.state === 'mismatch') {
        // 被派发过必然被加载过
        loaded = { state: 'yes', count: 0, lastSeenAt: observed.lastSeenAt, lastSessionId: observed.lastSessionId };
      } else if (listing.activity && listing.any) loaded = { state: 'no', count: 0, lastSeenAt: null, lastSessionId: null };
      else loaded = { state: 'unknown', count: 0, lastSeenAt: null, lastSessionId: null };
    }
  }

  // 结论
  let summary: string;
  let nextStep: string | null = null;
  const dispatchText = () => {
    if (observed.state === 'match') return T.agentMatch(observed.count, pa.model !== null, pa.effort !== null);
    if (observed.state === 'mismatch') {
      const bads = byFrequency(dispatches.filter((x) => !x.ok).map((x) => x.bad ?? '')).filter(Boolean);
      return T.agentMismatch(observed.count, observed.count - observed.matched, bads.join('、') || '（未知）');
    }
    return null;
  };
  if (builtin) {
    // 内置类型没有定义文件，派发时另外指定的模型才会让它不符合，所以不给"盖过定义文件"那条 nextStep
    summary = T.builtinPrefix(pa.name) + (dispatchText() ?? T.agentNotDispatched);
  } else if (written.state === 'no') {
    summary = writtenNote ? `还没有写入：${writtenNote}` : '还没有写入。';
    if (!writtenNote) nextStep = T.applyHint;
  } else if (written.state === 'differs') {
    summary = writtenNote ?? `定义文件里的${written.diffs.map((k) => FIELD_LABEL[k] ?? k).join('、')}和方案不一样。`;
    if (!writtenNote) nextStep = T.applyHint;
  } else {
    const dt = dispatchText();
    if (dt !== null) {
      summary = observed.state === 'match' ? `已生效。${dt}` : dt;
      if (observed.state === 'mismatch') nextStep = T.agentOverride;
    } else if (loaded.state === 'yes') {
      summary = T.agentLoadedNotDispatched;
      nextStep = T.agentMention(pa.name);
    } else if (loaded.state === 'no') {
      summary = T.agentNotLoaded;
      nextStep = T.agentReopen;
    } else {
      summary = T.agentLoadedUnknown;
    }
  }
  return {
    key: `agent:${pa.name}`,
    kind: 'agent',
    name: pa.name,
    expected,
    written,
    loaded,
    observed,
    writeEffective: true,
    summary,
    nextStep,
  };
}

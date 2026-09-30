// 配置修改：把动作展开成计划（只计算，不写文件）。
// 同一个文件的多项修改在内存里依次叠加，最后合并成一个 FileChange。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Node as JsonNode } from 'jsonc-parser';
import type { AgentFields, ChangePlan, CheckLevel, ConfigAction, EnvCheck, FileChange, PlanNote, Preset, PresetAgent } from '../../../shared/types.ts';
import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, BUILTIN_AGENT_TYPES, claudeConfigDirs, formatWindow, isValidAutoCompactWindow } from '../config.ts';
import { modelFamily, normalizeModel, MODEL_ALIASES } from '../conformance.ts';
import { sameTools, validatePreset, type AppliedRecord, type EffortLocation, type WrittenEffort } from '../preset.ts';
import { parseDispatch, withDispatch } from '../../../shared/dispatch.ts';
import { getBackup } from './backups.ts';
import { defaultRuleText } from '../../../shared/rule.ts';
import { disableRule, enableRule, FALLBACK_RULE_TEXT, findRuleBlock, RuleBlockError } from './claudeMd.ts';
import { FrontmatterError, getField, newAgentText, parseAgentDoc, promptOf, serializeAgentDoc, setField, setPrompt, type AgentDoc } from './frontmatter.ts';
import { JsonEditError, nodeAt, parseJsonDoc, removeValue, setValue } from './jsonEdit.ts';
import {
  agentFilePath,
  checkWritable,
  isConfigDirProject,
  isKnownProjectCwd,
  PathError,
  projectAgentsDir,
  projectClaudeMdPath,
  projectSettingsPath,
  userAgentsDir,
  validateAgentName,
  type WritableTarget,
} from './paths.ts';
import { agentTemplate } from './templates.ts';
import { decodeUtf8, encodeText, readTextFile, sha256 } from './text.ts';

export const PLAN_TTL_MS = 10 * 60_000;

/** 计划提示：桌面版不读 settings.json 里的主模型和 effort（措辞集中在这里，方便以后调整） */
export const PLAN_DESKTOP_MAIN_NOTE = '桌面版不读配置文件里的主模型和 effort，每个会话用的是发送框旁边选择器里选的值。这次写入只对命令行和 VS Code 里启动的会话有效。';
export const PLAN_DESKTOP_ADVISOR_NOTE = '桌面版是否读取配置文件里的 advisor 设置还没有验证。如果没有生效，可以在对话里输入 /advisor <模型> 来指定。';
export const PLAN_DESKTOP_COMPACT_NOTE = '桌面版是否读取配置文件里的 autoCompactWindow 还没有验证。写入之后，搭建页的生效检查会根据实际压缩的时机告诉你有没有生效。';
/** 设置文件里 autoCompactEnabled 为 false 时的提示 */
export const PLAN_COMPACT_DISABLED_NOTE = '设置文件里 autoCompactEnabled 为 false：自动压缩已经关闭，写入的 autoCompactWindow 不会生效。要用它请先把 autoCompactEnabled 改回 true 或删掉';
export const SETTINGS_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface PlanContext {
  /** 索引里出现过的会话工作目录（项目级 agent 的白名单） */
  knownCwds: string[];
  env: EnvCheck[];
  ccSwitchDetected: boolean;
  /** 上一次通过 preset.apply 成功应用的记录（applied.json）；prune 只移除这里记录 agentree 写过的键。没有为 null */
  applied?: AppliedRecord | null;
  /**
   * 最近的会话是否全部来自桌面版（和生效检查的判断相同，索引里没有会话时为 false）。
   * 为 true 时才给出"桌面版不读 settings.json 里的模型和 effort"的提示；缺失当作 false
   */
  desktopOnly?: boolean;
  /** 项目方案的应用记录（存在项目方案文件里）；prune 项目方案时用它，不用全局的 applied */
  projectApplied?: (projectCwd: string) => AppliedRecord | null;
  /**
   * 已保存的全局方案。规则的默认文字按方案生成：项目方案要叠加全局方案的子 agent，
   * 配置页手动启用规则（claudeMd.rule 不带正文）按全局方案生成。缺失当作空方案
   */
  globalPreset?: () => Preset | null;
}

/** 计划的内部表示：比对外的 FileChange 多了要写入的原始字节 */
export interface InternalChange extends FileChange {
  afterBytes: Buffer | null;
}

/** 计划来自 preset.apply 时附带的信息：应用成功后据此保存预设、写 applied.json */
export interface PresetApplyInfo {
  preset: Preset;
  /** 项目方案的项目目录；全局方案为 null */
  projectCwd: string | null;
  includeRule: boolean;
  /** 应用成功后 applied.json 里的 wrote */
  wrote: AppliedRecord['wrote'];
}

export interface StoredPlan {
  plan: ChangePlan;
  internal: InternalChange[];
  /** 计划里含 preset.apply 时才有（多个时取最后一个） */
  presetApply?: PresetApplyInfo;
}

interface WorkFile {
  target: WritableTarget;
  existed: boolean;
  origBytes: Buffer | null;
  origText: string | null;
  baseHash: string | null;
  bom: boolean;
  /** 当前工作内容（不含 BOM）；null 表示文件将不存在 */
  text: string | null;
  /** 直接指定写入的字节（恢复备份时用，保证逐字节相同） */
  rawAfter?: Buffer | null;
  summaries: string[];
}

class PlanError extends Error {}

export function isOpus55OrLater(model: string): boolean {
  const m = /^claude-opus-(\d+)(?:-(\d+))?$/.exec(normalizeModel(model));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] !== undefined && m[2].length <= 2 ? Number(m[2]) : 0;
  return major > 5 || (major === 5 && minor >= 5);
}

// ---------------- preset.apply 和生效检查共用的判断 ----------------
// 生效检查（effect.ts）直接调用这些函数，保证"配置里是不是这个值"的结论和"现在点应用会不会改动"一致。

/** 主会话 effort 写在哪里：主模型是 Opus 5.5 及之后的完整 ID 时按模型写 modelSettings，否则写顶层 effortLevel */
export function mainEffortLocation(model: string | null): EffortLocation {
  return model && isOpus55OrLater(model) ? { where: 'modelSettings', model: normalizeModel(model) } : { where: 'top', model: null };
}

export function effortPath(loc: EffortLocation): string[] {
  return loc.where === 'top' ? ['effortLevel'] : ['modelSettings', loc.model ?? '', 'effortLevel'];
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export interface PruneTarget {
  item: 'model' | 'advisorModel' | 'effort' | 'autoCompactWindow';
  path: string[];
  /** agentree 上次写入的值（autoCompactWindow 是数字） */
  recorded: string | number;
  /** 给 FileChange.summary 用的说明 */
  summary: string;
}

/** settings.json 里一个节点给人看的短文本 */
export function describeJsonNode(n: JsonNode): string {
  if (typeof n.value === 'string') return n.value;
  if (n.type === 'object' || n.type === 'array') return `（${n.type === 'object' ? '对象' : '数组'}）`;
  return String(n.value);
}

/**
 * prune 时要从 settings.json 移除的候选：applied.json 记录了 agentree 写入的值、而这次预设里为 null 的项；
 * effort 这次要写到新位置、而记录的旧位置不同时，旧位置也是候选。没有记录时一律没有候选。
 * 候选还要再经过 pruneDecisions 比对现在的值，值没变才真正删除。
 */
export function settingsPruneTargets(preset: Preset, applied: AppliedRecord | null): PruneTarget[] {
  const out: PruneTarget[] = [];
  const w = applied?.wrote;
  if (!w) return out;
  if (w.model !== null && preset.main.model === null) {
    out.push({ item: 'model', path: ['model'], recorded: w.model, summary: '删除 model（方案没有指定主模型，这个值是 agentree 上次写入的）' });
  }
  if (w.advisorModel !== null && preset.advisor.model === null) {
    out.push({ item: 'advisorModel', path: ['advisorModel'], recorded: w.advisorModel, summary: '删除 advisorModel（方案没有指定 advisor，这个值是 agentree 上次写入的）' });
  }
  if (w.autoCompactWindow !== null && preset.main.autoCompactWindow === null) {
    out.push({ item: 'autoCompactWindow', path: ['autoCompactWindow'], recorded: w.autoCompactWindow, summary: '删除 autoCompactWindow（方案没有指定自动压缩阈值，这个值是 agentree 上次写入的）' });
  }
  if (w.effort) {
    const old = effortPath(w.effort);
    if (preset.main.effort === null) {
      out.push({ item: 'effort', path: old, recorded: w.effort.value, summary: `删除 ${old.join('.')}（方案没有指定主会话 effort，这个值是 agentree 上次写入的）` });
    } else {
      const next = effortPath(mainEffortLocation(preset.main.model));
      if (!samePath(old, next)) {
        out.push({ item: 'effort', path: old, recorded: w.effort.value, summary: `删除旧位置的 ${old.join('.')}（effort 这次写在 ${next.join('.')}，避免留下两份）` });
      }
    }
  }
  return out;
}

export interface PruneDecision extends PruneTarget {
  /** remove：值和记录完全相同，删除；changed：被别的程序或用户改过，不动 */
  status: 'remove' | 'changed';
  /** 现在的值（短文本） */
  current: string;
}

/**
 * 比对现在的值，决定每个候选删不删。键不存在的候选不出现在结果里。
 * planner 和生效检查都用这个函数，保证结论一致
 */
export function pruneDecisions(preset: Preset, applied: AppliedRecord | null, nodeOf: (p: string[]) => JsonNode | undefined): PruneDecision[] {
  const out: PruneDecision[] = [];
  for (const t of settingsPruneTargets(preset, applied)) {
    const n = nodeOf(t.path);
    if (!n) continue;
    // 类型也要一样：字符串 "500000" 和数字 500000 不算同一个值
    const same = (typeof t.recorded === 'number' ? n.type === 'number' : n.type === 'string') && n.value === t.recorded;
    out.push({ ...t, status: same ? 'remove' : 'changed', current: describeJsonNode(n) });
  }
  return out;
}

/** 值被改过、这次不会动的键：planner 的提示 */
export function changedSinceWriteNote(key: string, current: string): string {
  return `settings.json 的 ${key} 在 agentree 写入之后被改成了 ${current}，这次不会动它`;
}

/** 这次应用里 settings 的哪些键是 agentree 实际写入的（值有改动或新建）。文件里本来就是方案的值时不算写入 */
export interface WrittenKeys {
  model: boolean;
  advisorModel: boolean;
  effort: boolean;
  autoCompactWindow: boolean;
}
const ALL_WRITTEN: WrittenKeys = { model: true, advisorModel: true, effort: true, autoCompactWindow: true };

const sameEffort = (a: WrittenEffort, b: WrittenEffort) => a.where === b.where && a.model === b.model && a.value === b.value;

/**
 * 应用成功后 applied.json 里的 wrote，只记 agentree 自己写过的值：
 *   这次实际写了（written 里为 true）的记这次的值；
 *   方案指定了、但文件里本来就是这个值（这次没写）的：上次记录的值和它相同才仍算 agentree 的，否则是用户自己写的，记 null，prune 永远不会删它；
 *   方案为 null 且 prune 了的记 null（删掉了，或者值被改过、已经不是 agentree 的）；没 prune 的保留上次的记录。
 * written 缺省当作全部写了（只在测试里这么用）
 */
export function nextWrote(preset: Preset, applied: AppliedRecord | null, pruning: boolean, written: WrittenKeys = ALL_WRITTEN): AppliedRecord['wrote'] {
  const prev = applied?.wrote ?? { model: null, advisorModel: null, effort: null, autoCompactWindow: null };
  const keep = <T>(specified: T | null, wroteNow: boolean, prevValue: T | null, same: (a: T, b: T) => boolean): T | null => {
    if (specified === null) return pruning ? null : prevValue;
    if (wroteNow) return specified;
    return prevValue !== null && same(prevValue, specified) ? prevValue : null;
  };
  const eq = <T>(a: T, b: T) => a === b;
  const effort: WrittenEffort | null = preset.main.effort !== null ? { ...mainEffortLocation(preset.main.model), value: preset.main.effort } : null;
  return {
    model: keep(preset.main.model, written.model, prev.model, eq),
    advisorModel: keep(preset.advisor.model, written.advisorModel, prev.advisorModel, eq),
    effort: keep(effort, written.effort, prev.effort, sameEffort),
    autoCompactWindow: keep(preset.main.autoCompactWindow, written.autoCompactWindow, prev.autoCompactWindow, eq),
  };
}

const EMPTY_PRESET: Preset = { version: 1, main: { model: null, effort: null, autoCompactWindow: null }, advisor: { model: null }, agents: [], allowBuiltins: true, updatedAt: null };

/** 规则块实际使用的文字：给了非空的自定义文字就用它，否则用按方案生成的 autoText（可能是空字符串，表示不需要规则块） */
export function effectiveRuleText(text: unknown, autoText: string): string {
  return typeof text === 'string' && text.trim() ? text : autoText;
}

/** 正文比较用：忽略换行风格、开头的空行和末尾的空白行 */
export function normalizePrompt(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
}

export function describeChange(key: string, before: string | null, after: string | null): string {
  if (before === null) return `新增 ${key}：${after}`;
  if (after === null) return `删除 ${key}（原为 ${before}）`;
  return `把 ${key} 从 ${before} 改为 ${after}`;
}

const hasField = (doc: AgentDoc, key: string) => doc.fields.some((f) => f.key === key);

/**
 * 把预设里一个 agent 的设置写进已有定义文件（直接修改 doc）。只改预设里有定义的项：
 * model、effort 为 null 不动；description、prompt 缺失不动；tools、disallowedTools 缺失不动、null 删除字段。
 * 返回改了的字段名（正文记为 prompt）和给 summary 用的中文说明（不含正文内容）。
 */
export function applyPresetAgent(doc: AgentDoc, pa: PresetAgent): { keys: string[]; labels: string[] } {
  const keys: string[] = [];
  const labels: string[] = [];
  const set = (key: string, value: string | null, label?: string) => {
    const before = getField(doc, key);
    if (setField(doc, key, value)) {
      keys.push(key);
      labels.push(label ?? describeChange(key, before, value));
    }
  };
  if (pa.model !== null) set('model', pa.model);
  if (pa.effort !== null) set('effort', pa.effort);
  if (pa.description !== undefined) set('description', pa.description, '修改 description');
  for (const key of ['tools', 'disallowedTools'] as const) {
    const v = pa[key];
    if (v === undefined) continue;
    // 同样的工具只是顺序或空白不同：不改，保留原来的写法
    if (v !== null && hasField(doc, key) && sameTools(getField(doc, key), v)) continue;
    set(key, v);
  }
  const body = presetAgentBody(doc, pa);
  if (body !== null) {
    // 沿用文件的换行风格；原正文和 frontmatter 之间空一行的，替换后也空一行
    const lead = doc.body === '' || /^[ \t]*\r?\n/.test(doc.body) ? doc.eol : '';
    const text = body.text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\r?\n/g, doc.eol);
    doc.body = lead + text + (text === '' || text.endsWith(doc.eol) ? '' : doc.eol);
    doc.closeEol = true;
    if (body.promptChanged) {
      keys.push('prompt');
      labels.push('修改系统提示词');
    }
    if (body.dispatchChanged) {
      keys.push('dispatchModel');
      labels.push(describeDispatchChange(body.before, body.after));
    }
  }
  return { keys, labels };
}

/** 往下派发的模型改动的中文说明 */
function describeDispatchChange(before: string | null, after: string | null): string {
  if (before === null) return `写入往下派发的模型 ${after}`;
  if (after === null) return `删除往下派发的模型（原为 ${before}）`;
  return `把往下派发的模型从 ${before} 改为 ${after}`;
}

/**
 * 应用方案时定义文件正文（系统提示词 + 末尾的派发块，见 shared/dispatch.ts）应该变成什么。
 *   prompt 缺失：提示词沿用文件里的；dispatchModel 缺失：块沿用（给的 prompt 里自带块时用它的，否则用文件里的），
 *   null 删除块，字符串写成这个模型的块。
 * 比较按"拆开后的提示词（忽略换行风格和首尾空行）+ 块里的模型"，所以读出来的内容原样提交不会有改动，
 * 块不在末尾之类的写法只要内容相同也不动。不需要改时返回 null；返回的 text 换行统一为 \n
 */
export function presetAgentBody(doc: AgentDoc, pa: PresetAgent): { text: string; promptChanged: boolean; dispatchChanged: boolean; before: string | null; after: string | null } | null {
  if (pa.prompt === undefined && pa.dispatchModel === undefined) return null;
  const cur = parseDispatch(promptOf(doc).replace(/\r\n/g, '\n'));
  const given = pa.prompt !== undefined ? parseDispatch(pa.prompt.replace(/\r\n/g, '\n')) : null;
  const prompt = given ? given.prompt : cur.prompt;
  const model = pa.dispatchModel !== undefined ? pa.dispatchModel : (given?.model ?? cur.model);
  const promptChanged = normalizePrompt(prompt) !== normalizePrompt(cur.prompt);
  const dispatchChanged = model !== cur.model;
  if (!promptChanged && !dispatchChanged) return null;
  // 不带块时提示词原样写（和以前一样保留它自己的末尾空行）
  return { text: model === null ? prompt : withDispatch(prompt, model), promptChanged, dispatchChanged, before: cur.model, after: model };
}

/** agent 还能不能往下派发：disallowedTools 含 Agent，或 tools 有白名单且不含 Agent 时不能（tools 里 Agent(a,b) 这种写法也算含） */
export function canDispatch(tools: string | null, disallowedTools: string | null): boolean {
  const list = (v: string | null) =>
    (v ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  const isAgent = (t: string) => /^(Agent|Task)(\(|$)/.test(t);
  if (list(disallowedTools).some((t) => t === 'Agent' || t === 'Task')) return false;
  const allow = list(tools);
  return allow.length === 0 || allow.some(isAgent);
}

/** 用户级定义：优先 <name>.md；否则找 frontmatter 里 name 相同的文件 */
export function findUserAgentFile(name: string, knownCwds: string[]): WritableTarget {
  return findAgentFile(name, knownCwds, null);
}

/**
 * 找 agent 定义文件：projectCwd 为 null 时在用户级 agents 目录找，否则只在 <项目>/.claude/agents 里找。
 * 优先 <name>.md；否则找 frontmatter 里 name 相同的文件；都没有返回 <name>.md（新建的位置）
 */
export function findAgentFile(name: string, knownCwds: string[], projectCwd: string | null): WritableTarget {
  const direct = projectCwd === null ? agentFilePath('user', name, null, knownCwds) : agentFilePath('project', name, projectCwd, knownCwds);
  if (fs.existsSync(direct.path)) return direct;
  const dir = projectCwd === null ? userAgentsDir() : projectAgentsDir(projectCwd);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return direct;
  }
  for (const e of entries) {
    try {
      const t = readTextFile(path.join(dir, e));
      if (t.text === null) continue;
      if (getField(parseAgentDoc(t.text), 'name') === name) return checkWritable(path.join(dir, e), knownCwds);
    } catch {
      /* 解析不了的文件不当作匹配 */
    }
  }
  return direct;
}

/**
 * 环境变量和 cc-switch 会让哪些设置失效。inv 表示计划（或方案）涉及哪些项，只对涉及的项给出提示：
 * modelKeys 为 settings.json 的 model / advisorModel，effort 为主会话或 agent 的 effort，
 * agentModel 为 agent 定义文件里的 model，advisor 为 advisorModel，compact 为 autoCompactWindow
 */
export function envNotes(ctx: Pick<PlanContext, 'env' | 'ccSwitchDetected'>, inv: { modelKeys: boolean; effort: boolean; agentModel: boolean; advisor: boolean; compact?: boolean }): PlanNote[] {
  const set = (name: string) => ctx.env.some((e) => e.name === name && e.value !== null);
  const out: PlanNote[] = [];
  if (ctx.ccSwitchDetected && inv.modelKeys) {
    out.push({ level: 'warn', message: '检测到 cc-switch：它切换供应商时会覆盖 settings.json 里的 model 和 advisorModel' });
  }
  if (set('CLAUDE_CODE_EFFORT_LEVEL') && inv.effort) {
    out.push({ level: 'warn', message: '设置了环境变量 CLAUDE_CODE_EFFORT_LEVEL：它会覆盖所有 effort 设置，包括 agent 定义文件里的 effort' });
  }
  if (set('CLAUDE_CODE_SUBAGENT_MODEL_FORCE') && inv.agentModel) {
    out.push({ level: 'warn', message: '设置了环境变量 CLAUDE_CODE_SUBAGENT_MODEL_FORCE：所有子 agent 会被强制使用同一个模型，定义文件里的 model 不生效' });
  }
  if (set('CLAUDE_CODE_DISABLE_ADVISOR_TOOL') && inv.advisor) {
    out.push({ level: 'warn', message: '设置了环境变量 CLAUDE_CODE_DISABLE_ADVISOR_TOOL：advisor 被禁用，advisorModel 设置不生效' });
  }
  if (inv.compact) {
    if (set('DISABLE_COMPACT')) {
      out.push({ level: 'warn', message: '设置了环境变量 DISABLE_COMPACT：所有压缩都被关闭，autoCompactWindow 设置不生效' });
    } else if (set('DISABLE_AUTO_COMPACT')) {
      out.push({ level: 'warn', message: '设置了环境变量 DISABLE_AUTO_COMPACT：自动压缩被关闭，autoCompactWindow 设置不生效' });
    }
    if (set('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) {
      out.push({ level: 'warn', message: '设置了环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW：它会覆盖 settings.json 里的 autoCompactWindow（也盖过 /autocompact 和 --autocompact）' });
    }
  }
  return out;
}

export class Planner {
  private files = new Map<string, WorkFile>();
  private notes: PlanNote[] = [];
  private errors: string[] = [];
  /** baseHash 对不上（文件在用户打开之后被改过或删掉）的文件路径 */
  private conflicts: string[] = [];
  private touched = { mainModel: false, advisorModel: false, effort: false, compact: false, agentModel: false, agentEffort: false, agents: false, newAgentDir: false };
  /** 这次实际写入（值有改动或新建）的 settings 键，applied.json 的 wrote 只记这些 */
  private written: WrittenKeys = { model: false, advisorModel: false, effort: false, autoCompactWindow: false };
  private presetApplied: PresetApplyInfo | undefined;

  constructor(private ctx: PlanContext) {}

  // ---------------- 基础 ----------------

  /** 记录冲突并中止这个动作（计划会 blocked，errors 里有中文说明） */
  private conflict(filePath: string, message: string): never {
    if (!this.conflicts.includes(filePath)) this.conflicts.push(filePath);
    throw new PlanError(message);
  }

  private note(level: CheckLevel, message: string) {
    if (!this.notes.some((n) => n.message === message)) this.notes.push({ level, message });
  }

  private file(target: WritableTarget): WorkFile {
    const key = process.platform === 'win32' ? target.path.toLowerCase() : target.path;
    let f = this.files.get(key);
    if (f) return f;
    const tf = readTextFile(target.path);
    if (tf.exists && tf.text === null) throw new PlanError(`${target.path} 不是 UTF-8 编码的文本，拒绝修改`);
    f = {
      target,
      existed: tf.exists,
      origBytes: tf.bytes,
      origText: tf.exists ? tf.text : null,
      baseHash: tf.hash,
      bom: tf.bom,
      text: tf.exists ? tf.text : null,
      summaries: [],
    };
    this.files.set(key, f);
    return f;
  }

  /** 正在展开项目方案时是项目目录：设置和规则写到项目里。其余时候为 null（用户级） */
  private scopeCwd: string | null = null;

  private settingsTarget(): WritableTarget {
    const p = this.scopeCwd === null ? path.join(claudeConfigDirs()[0], 'settings.json') : projectSettingsPath(this.scopeCwd);
    return checkWritable(p, this.ctx.knownCwds);
  }

  private claudeMdTarget(): WritableTarget {
    const p = this.scopeCwd === null ? path.join(claudeConfigDirs()[0], 'CLAUDE.md') : projectClaudeMdPath(this.scopeCwd);
    return checkWritable(p, this.ctx.knownCwds);
  }

  /** 对 settings.json 做一次修改。文件不存在时从 {} 开始，最后只含要写的键。返回内容是否有改动 */
  private editSettings(summary: string, fn: (text: string) => string): boolean {
    const f = this.file(this.settingsTarget());
    const current = f.text ?? '{}';
    let next: string;
    try {
      next = fn(current);
    } catch (e) {
      if (e instanceof JsonEditError) throw new PlanError(e.message);
      throw e;
    }
    if (next === current) return false;
    f.text = next;
    f.summaries.push(summary);
    return true;
  }

  /** 返回是否真的改了值（文件里本来就是这个值时为 false） */
  private setSetting(pathKeys: string[], value: string | number | null, summary: string): boolean {
    return this.editSettings(summary, (text) => {
      const doc = parseJsonDoc(text);
      if (value === null) return removeValue(doc, pathKeys, 'settings.json', pathKeys.length > 2);
      const existing = nodeAt(doc, pathKeys);
      if (existing && (existing.type === 'string' || existing.type === 'number') && existing.value === value) return text;
      return setValue(doc, pathKeys, value);
    });
  }

  /** settings.json 当前工作内容里某个路径上的节点；文件不存在或没有这个键返回 undefined */
  private settingNode(pathKeys: string[]): JsonNode | undefined {
    const f = this.file(this.settingsTarget());
    if (f.text === null) return undefined;
    try {
      return nodeAt(parseJsonDoc(f.text), pathKeys);
    } catch (e) {
      if (e instanceof JsonEditError) throw new PlanError(e.message);
      throw e;
    }
  }

  private currentSetting(pathKeys: string[]): unknown {
    const f = this.file(this.settingsTarget());
    if (f.text === null) return undefined;
    try {
      return nodeAt(parseJsonDoc(f.text), pathKeys)?.value;
    } catch (e) {
      if (e instanceof JsonEditError) throw new PlanError(e.message);
      throw e;
    }
  }

  // ---------------- 动作 ----------------

  run(actions: ConfigAction[]): void {
    for (const [i, a] of actions.entries()) {
      try {
        this.action(a);
      } catch (e) {
        if (e instanceof PlanError || e instanceof PathError || e instanceof FrontmatterError || e instanceof RuleBlockError || e instanceof JsonEditError) {
          this.errors.push(actions.length > 1 ? `第 ${i + 1} 项（${(a as any)?.type ?? '未知'}）：${e.message}` : e.message);
        } else throw e;
      }
    }
  }

  private action(a: ConfigAction) {
    if (!a || typeof a !== 'object') throw new PlanError('动作必须是对象');
    switch (a.type) {
      case 'settings.mainModel':
        return this.mainModel(a.value);
      case 'settings.advisorModel':
        return this.advisorModel(a.value);
      case 'settings.autoCompactWindow':
        return this.autoCompactWindow(a.value);
      case 'settings.effort':
        return this.effort(a.model, a.value);
      case 'claudeMd.rule':
        return this.rule(a.enabled, a.text);
      case 'agent.upsert':
        return this.agentUpsert(a);
      case 'agent.delete':
        return this.agentDelete(a.filePath, a.baseHash);
      case 'preset.apply':
        return this.presetApplyScoped(a.preset, a.includeRule, a.ruleText, a.prune, a.projectCwd);
      default:
        throw new PlanError(`不认识的动作类型：${(a as any).type}`);
    }
  }

  private optString(v: unknown, what: string): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new PlanError(`${what} 必须是字符串或 null`);
    const t = v.trim();
    if (!t) throw new PlanError(`${what} 不能是空字符串（要删除请传 null）`);
    if (/[\r\n]/.test(t)) throw new PlanError(`${what} 不能包含换行`);
    return t;
  }

  mainModel(value: unknown) {
    const v = this.optString(value, '主模型');
    if (this.setSetting(['model'], v, v === null ? '删除 model' : `把 model 设为 ${v}`) && v !== null) this.written.model = true;
    this.touched.mainModel = true;
  }

  advisorModel(value: unknown) {
    const v = this.optString(value, 'advisor 模型');
    if (this.setSetting(['advisorModel'], v, v === null ? '删除 advisorModel（关闭 advisor）' : `把 advisorModel 设为 ${v}`) && v !== null) this.written.advisorModel = true;
    this.touched.advisorModel = true;
  }

  /** 自动压缩阈值：顶层 autoCompactWindow（token 数）。全局方案写用户级 settings.json，项目方案写 settings.local.json，和 model 相同 */
  autoCompactWindow(value: unknown) {
    if (value !== null && value !== undefined && !isValidAutoCompactWindow(value)) {
      throw new PlanError(`自动压缩阈值必须是 ${AUTO_COMPACT_MIN} 到 ${AUTO_COMPACT_MAX} 之间的整数（token 数），现在是 ${String(value)}`);
    }
    const v = value === undefined ? null : value;
    if (this.setSetting(['autoCompactWindow'], v, v === null ? '删除 autoCompactWindow（跟 Claude Code 默认）' : `把 autoCompactWindow 设为 ${v}（约 ${formatWindow(v)} token）`) && v !== null) {
      this.written.autoCompactWindow = true;
    }
    this.touched.compact = true;
    // 自动压缩关着的话，阈值写了也没用
    if (v !== null && this.currentSetting(['autoCompactEnabled']) === false) this.note('warn', PLAN_COMPACT_DISABLED_NOTE);
  }

  effort(model: unknown, value: unknown) {
    const v = this.optString(value, 'effort');
    if (v !== null && !SETTINGS_EFFORTS.includes(v)) {
      throw new PlanError(
        v === 'max'
          ? 'settings.json 的 effortLevel 和 modelSettings 不接受 max（官方文档：max 在这两个键里都不被接受），请选 low、medium、high 或 xhigh'
          : `effort 必须是 ${SETTINGS_EFFORTS.join('、')} 之一`,
      );
    }
    const m = this.optString(model, '模型 ID');
    this.touched.effort = true;
    if (m === null) {
      if (this.setSetting(['effortLevel'], v, v === null ? '删除顶层 effortLevel' : `把顶层 effortLevel 设为 ${v}`) && v !== null) this.written.effort = true;
      if (v !== null) {
        this.note('warn', '顶层 effortLevel 在用户级 settings.json 里只对 Opus 5、Fable 5.1 及更早的模型生效；Opus 5.5 及之后的模型会忽略它，需要按模型写在 modelSettings 里');
      }
      return;
    }
    const key = normalizeModel(m);
    if (MODEL_ALIASES.includes(key)) {
      throw new PlanError(`modelSettings 的键必须是完整模型 ID（如 claude-opus-5-5），不能用别名 ${m}：别名作为键只匹配它自己`);
    }
    if (key !== m.toLowerCase()) this.note('info', `modelSettings 的键写成规范名 ${key}（官方文档：Claude Code 按规范名保存，[1m] 和日期后缀的变体会匹配到同一项）`);
    const cur = this.currentSetting(['modelSettings']);
    if (cur !== undefined && (cur === null || typeof cur !== 'object')) throw new PlanError('settings.json 里 modelSettings 不是对象，拒绝修改');
    if (this.setSetting(['modelSettings', key, 'effortLevel'], v, v === null ? `删除 modelSettings.${key}.effortLevel` : `把 modelSettings.${key}.effortLevel 设为 ${v}`) && v !== null) {
      this.written.effort = true;
    }
  }

  /**
   * 启用 / 停用规则块。text 为 null 或空时用 autoText；autoText 缺失（配置页的 claudeMd.rule）时按已保存的全局方案生成，
   * 全局方案里既没有子 agent 也没有 advisor 时用兜底的 advisor 三条
   */
  rule(enabled: unknown, text: unknown, autoText?: string) {
    if (typeof enabled !== 'boolean') throw new PlanError('enabled 必须是布尔值');
    if (text !== null && text !== undefined && typeof text !== 'string') throw new PlanError('规则正文必须是字符串或 null');
    const auto = autoText ?? (defaultRuleText(this.ctx.globalPreset?.() ?? EMPTY_PRESET) || FALLBACK_RULE_TEXT);
    const ruleText = effectiveRuleText(text, auto);
    if (enabled && !ruleText.trim()) throw new PlanError('规则正文是空的');
    if (ruleText.includes('<!-- agentree:advisor-rule')) throw new PlanError('规则正文里不能包含 agentree 的标记');
    const f = this.file(this.claudeMdTarget());
    const current = f.text ?? '';
    if (!enabled && f.text === null) return;
    const next = enabled ? enableRule(current, ruleText) : disableRule(current);
    if (next !== current || (enabled && f.text === null)) {
      const had = findRuleBlock(current) !== null;
      f.text = next;
      f.summaries.push(enabled ? (had ? '替换 agentree 规则块的内容' : '在末尾追加 agentree 规则块') : '删除 agentree 规则块');
    }
  }

  private checkFields(fields: AgentFields | undefined, name: string): { description: string; model: string | null; effort: string | null; tools: string | null } {
    if (!fields || typeof fields !== 'object') throw new PlanError('fields 必须是对象');
    if (typeof fields.description !== 'string') throw new PlanError('description 必须是字符串');
    const description = fields.description.trim() || agentTemplate(name).description;
    const model = this.optString(fields.model, 'model');
    const effort = this.optString(fields.effort, 'effort');
    if (effort !== null && !AGENT_EFFORTS.includes(effort)) throw new PlanError(`effort 必须是 ${AGENT_EFFORTS.join('、')} 之一或 null`);
    const tools = this.optString(fields.tools, 'tools');
    return { description, model, effort, tools };
  }

  private parseAgent(f: WorkFile): AgentDoc {
    try {
      return parseAgentDoc(f.text ?? '', f.bom);
    } catch (e) {
      throw new PlanError(`${f.target.path} 的 frontmatter 格式异常：${(e as Error).message}，拒绝修改`);
    }
  }

  private isBuiltin(name: string): boolean {
    return BUILTIN_AGENT_TYPES.some((b) => b.toLowerCase() === name.toLowerCase());
  }

  private agentTouched(model: boolean, effort: boolean, created: boolean) {
    this.touched.agents = true;
    if (model) this.touched.agentModel = true;
    if (effort) this.touched.agentEffort = true;
    if (created) {
      const dir = path.dirname(this.lastAgentPath);
      if (!fs.existsSync(dir)) this.touched.newAgentDir = true;
    }
  }
  private lastAgentPath = '';

  agentUpsert(a: Extract<ConfigAction, { type: 'agent.upsert' }>) {
    if (a.scope !== 'user' && a.scope !== 'project') throw new PlanError('scope 必须是 user 或 project');
    const name = validateAgentName(a.name);
    const fields = this.checkFields(a.fields, name);
    if (a.body !== null && a.body !== undefined && typeof a.body !== 'string') throw new PlanError('body 必须是字符串或 null');
    const target = agentFilePath(a.scope, name, a.projectCwd ?? null, this.ctx.knownCwds);
    this.lastAgentPath = target.path;
    const renaming = a.originalName !== null && a.originalName !== undefined && a.originalName !== name;

    if (renaming) {
      const oldName = validateAgentName(a.originalName);
      if (oldName.toLowerCase() === name.toLowerCase()) throw new PlanError('只改大小写的改名不支持（Windows 文件名不区分大小写）');
      if (this.isBuiltin(name)) throw new PlanError(`${name} 是内置类型的名字，内置类型无法通过定义文件修改，不能改成这个名字`);
      const source = this.file(agentFilePath(a.scope, oldName, a.projectCwd ?? null, this.ctx.knownCwds));
      if (source.text === null) throw new PlanError(`要改名的文件 ${source.target.path} 不存在`);
      if (!a.baseHash) throw new PlanError('改名时必须传打开文件时的 baseHash');
      if (a.baseHash !== source.baseHash) this.conflict(source.target.path, `${source.target.path} 在打开之后被修改过，请重新加载后再改`);
      const dest = this.file(target);
      if (dest.text !== null) throw new PlanError(`${target.path} 已存在，不能改成这个名字`);
      const doc = this.parseAgent(source);
      const changed = this.applyFields(doc, name, fields, a.body ?? null);
      dest.text = serializeAgentDoc(doc);
      dest.bom = source.bom;
      dest.summaries.push(`由 ${oldName}.md 改名而来${changed.length ? `，并${changed.join('、')}` : ''}`);
      source.text = null;
      source.summaries.push(`改名为 ${name}.md（原文件移到备份目录）`);
      this.agentTouched(
        changed.some((c) => c.includes('model')),
        changed.some((c) => c.includes('effort')),
        true,
      );
      return;
    }

    const f = this.file(target);
    if (f.text === null) {
      if (a.baseHash) this.conflict(target.path, `${target.path} 不存在（打开之后被删除了），请重新加载`);
      if (this.isBuiltin(name)) throw new PlanError(`${name} 是内置类型，内置类型无法通过定义文件修改`);
      const body = a.body ?? agentTemplate(name).prompt;
      f.text = newAgentText(
        [
          ['name', name],
          ['description', fields.description],
          ['model', fields.model],
          ['effort', fields.effort],
          ['tools', fields.tools],
        ],
        body,
      );
      f.summaries.push(`新建 agent 定义 ${name}`);
      this.agentTouched(fields.model !== null, fields.effort !== null, true);
      return;
    }
    if (!a.baseHash) throw new PlanError(`${target.path} 已存在，不能新建同名 agent，请改为编辑`);
    if (a.baseHash !== f.baseHash) this.conflict(target.path, `${target.path} 在打开之后被修改过，请重新加载后再改`);
    const doc = this.parseAgent(f);
    const changed = this.applyFields(doc, name, fields, a.body ?? null);
    if (changed.length) {
      f.text = serializeAgentDoc(doc);
      f.summaries.push(changed.join('、'));
      this.agentTouched(
        changed.some((c) => c.includes('model')),
        changed.some((c) => c.includes('effort')),
        false,
      );
    }
  }

  private describe(key: string, before: string | null, after: string | null): string {
    return describeChange(key, before, after);
  }

  /** 把字段写进 frontmatter，返回改了哪些（中文说明） */
  private applyFields(doc: AgentDoc, name: string, fields: { description: string; model: string | null; effort: string | null; tools: string | null }, body: string | null): string[] {
    const changed: string[] = [];
    const set = (key: string, value: string | null, show = true) => {
      const before = getField(doc, key);
      if (setField(doc, key, value)) changed.push(show ? this.describe(key, before, value) : `修改 ${key}`);
    };
    set('name', name);
    set('description', fields.description, false);
    set('model', fields.model);
    set('effort', fields.effort);
    set('tools', fields.tools);
    // 正文按提示词比较：frontmatter 后面的分隔空行不算正文，读出来是什么、原样提交就不算改动
    if (body !== null && setPrompt(doc, body)) changed.push('修改正文');
    return changed;
  }

  agentDelete(filePath: unknown, baseHash: unknown) {
    if (typeof filePath !== 'string') throw new PlanError('filePath 必须是字符串');
    const target = checkWritable(filePath, this.ctx.knownCwds);
    if (target.kind !== 'agent') throw new PlanError(`${filePath} 不是 agent 定义文件，不能用 agent.delete 删除`);
    const f = this.file(target);
    if (typeof baseHash !== 'string' || !baseHash) throw new PlanError('删除时必须传打开文件时的 baseHash');
    if (f.text === null) this.conflict(target.path, `${target.path} 不存在（打开之后被删除了）`);
    if (baseHash !== f.baseHash) this.conflict(target.path, `${target.path} 在打开之后被修改过，请重新加载后再删除`);
    f.text = null;
    f.summaries.push('删除（文件移到备份目录，可以恢复）');
    this.touched.agents = true;
  }

  /** preset.apply：projectCwd 有值时展开项目方案（写到项目目录），否则展开全局方案 */
  presetApplyScoped(input: unknown, includeRule: unknown, ruleText: unknown, prune: unknown, projectCwd: unknown) {
    if (projectCwd === undefined || projectCwd === null) return this.presetApply(input, includeRule, ruleText, prune);
    if (typeof projectCwd !== 'string' || !path.isAbsolute(projectCwd)) throw new PlanError(`projectCwd 必须是项目目录的绝对路径：${String(projectCwd)}`);
    if (!isKnownProjectCwd(projectCwd, this.ctx.knownCwds)) {
      throw new PlanError(`项目目录 ${projectCwd} 没有在索引过的会话里出现过，不能给它建项目方案`);
    }
    if (isConfigDirProject(projectCwd)) {
      throw new PlanError(`${projectCwd} 下的 .claude 就是全局配置目录，这个目录不能用项目方案，请改用全局方案`);
    }
    this.scopeCwd = projectCwd;
    try {
      this.presetApply(input, includeRule, ruleText, prune);
    } finally {
      this.scopeCwd = null;
    }
  }

  presetApply(input: unknown, includeRule: unknown, ruleText?: unknown, prune?: unknown) {
    let preset: Preset;
    try {
      preset = validatePreset(input);
    } catch (e) {
      throw new PlanError(`预设不合法：${(e as Error).message}`);
    }
    if (prune !== undefined && prune !== null && typeof prune !== 'boolean') throw new PlanError('prune 必须是布尔值');
    if (ruleText !== undefined && ruleText !== null && typeof ruleText !== 'string') throw new PlanError('ruleText 必须是字符串或 null');
    const pruning = prune === true;
    const cwd = this.scopeCwd;
    // prune 用这个方案自己的应用记录：项目方案用项目的，全局方案用 applied.json
    const applied = cwd === null ? (this.ctx.applied ?? null) : (this.ctx.projectApplied?.(cwd) ?? null);
    /** 这次会移除的东西，最后汇总成一条 info */
    const removed: string[] = [];
    if (preset.main.model) this.mainModel(preset.main.model);
    if (preset.main.effort) {
      if (preset.main.effort === 'max') {
        throw new PlanError('主会话 effort 为 max：settings.json 不接受 max（官方文档），请改为 xhigh 或更低后再应用');
      }
      const loc = mainEffortLocation(preset.main.model);
      if (loc.where === 'modelSettings') {
        this.effort(loc.model, preset.main.effort);
      } else {
        this.effort(null, preset.main.effort);
        if (preset.main.model) {
          this.note(
            'warn',
            `主模型 ${preset.main.model} 不是 Opus 5.5 及之后的完整模型 ID，effort 写在顶层 effortLevel。如果它实际解析成 Opus 5.5 或更新的模型，这个 effort 不会生效；要按模型设置请把主模型写成完整 ID`,
          );
        }
      }
    }
    if (preset.advisor.model) this.advisorModel(preset.advisor.model);
    if (preset.main.autoCompactWindow !== null) this.autoCompactWindow(preset.main.autoCompactWindow);
    // prune：只移除 agentree 自己写过的 settings 键（applied.json 有记录），用户或 cc-switch 写的不动。
    // 键本来就不在（或 settings.json 不存在）时什么都不做，不会为了删除而创建文件
    // 值和 agentree 记录的不同，说明写入之后被别的程序或用户改过，同样不动
    if (pruning) {
      for (const t of pruneDecisions(preset, applied, (p) => this.settingNode(p))) {
        if (t.status === 'changed') {
          this.note('info', changedSinceWriteNote(t.path.join('.'), t.current));
          continue;
        }
        this.setSetting(t.path, null, t.summary);
        removed.push(`settings.json 的 ${t.path.join('.')}`);
        if (t.item === 'model') this.touched.mainModel = true;
        else if (t.item === 'advisorModel') this.touched.advisorModel = true;
        else if (t.item === 'autoCompactWindow') this.touched.compact = true;
        else this.touched.effort = true;
      }
    }
    for (const pa of preset.agents) {
      if (this.isBuiltin(pa.name)) {
        this.note('info', `${pa.name} 是内置类型，内置类型无法通过定义文件修改，已跳过`);
        continue;
      }
      validateAgentName(pa.name);
      if (pa.effort && !AGENT_EFFORTS.includes(pa.effort)) throw new PlanError(`agent ${pa.name} 的 effort ${pa.effort} 不合法`);
      const target = findAgentFile(pa.name, this.ctx.knownCwds, cwd);
      const f = this.file(target);
      this.lastAgentPath = target.path;
      let tools: string | null;
      let disallowedTools: string | null;
      if (f.text !== null) {
        // 已存在：只改预设里有定义的项，其余 frontmatter 字段、注释、顺序原样保留
        const doc = this.parseAgent(f);
        const { keys, labels } = applyPresetAgent(doc, pa);
        if (keys.length) {
          f.text = serializeAgentDoc(doc);
          f.summaries.push(labels.join('、'));
          this.agentTouched(keys.includes('model'), keys.includes('effort'), false);
        }
        tools = getField(doc, 'tools');
        disallowedTools = getField(doc, 'disallowedTools');
      } else {
        ({ tools, disallowedTools } = this.createPresetAgent(f, pa));
      }
      // 指定了往下派发的模型，但工具设置不允许它再派发：照写，提醒一句
      if (typeof pa.dispatchModel === 'string' && !canDispatch(tools, disallowedTools)) {
        this.note('warn', `${pa.name} 不能再派发子 agent，往下派发的模型指定用不上`);
      }
    }
    if (includeRule === true) {
      // 没给自定义文字时按方案生成（项目方案叠加已保存的全局方案）：没有规则块就追加，已有且文字不同就替换。
      // 早先版本写的只有 advisor 三条的块也会因此换成带分工的新文字
      const auto = defaultRuleText(preset, cwd === null ? null : (this.ctx.globalPreset?.() ?? null));
      const text = effectiveRuleText(ruleText, auto);
      if (text.trim()) this.rule(true, text, auto);
      else {
        // 方案里既没有子 agent 也没有 advisor：没有要写的规则，已有的 agentree 规则块删掉
        const f = this.file(this.claudeMdTarget());
        if (f.text !== null && findRuleBlock(f.text) !== null) {
          this.rule(false, null, auto);
          removed.push('CLAUDE.md 里的 agentree 规则块（方案里没有子 agent 也没有 advisor，不需要规则）');
        }
      }
    } else if (pruning) {
      // 规则块有 agentree 的标记，本来就是 agentree 管理的，prune 时直接删除
      const f = this.file(this.claudeMdTarget());
      if (f.text !== null && findRuleBlock(f.text) !== null) {
        this.rule(false, null, '');
        removed.push('CLAUDE.md 里的 agentree 规则块');
      }
    }
    if (removed.length) this.note('info', `这次会移除：${removed.join('、')}`);
    this.presetApplied = { preset, projectCwd: cwd, includeRule: includeRule === true, wrote: nextWrote(preset, applied, pruning, this.written) };
  }

  /** 预设里的 agent 还没有定义文件：按预设内容新建，缺的项用模板补 */
  private createPresetAgent(f: WorkFile, pa: PresetAgent): { tools: string | null; disallowedTools: string | null } {
    const t = agentTemplate(pa.name);
    const note = pa.note?.trim() ? pa.note.trim() : undefined;
    // description：预设 > 旧预设的 note > 模板
    const description = pa.description ?? note ?? t.description;
    const tools = pa.tools !== undefined ? pa.tools : t.tools;
    const disallowedTools = pa.disallowedTools !== undefined ? pa.disallowedTools : t.disallowedTools;
    // 正文 = 提示词 + 派发块。dispatchModel 缺失时用提示词里自带的块（没有就不加）
    const prompt = pa.prompt !== undefined ? pa.prompt : t.prompt;
    const dispatchModel = pa.dispatchModel !== undefined ? pa.dispatchModel : parseDispatch(prompt).model;
    const body = dispatchModel === null ? parseDispatch(prompt).prompt : withDispatch(prompt, dispatchModel);
    f.text = newAgentText(
      [
        ['name', pa.name],
        ['description', description],
        ['model', pa.model],
        ['effort', pa.effort],
        ['tools', tools],
        ['disallowedTools', disallowedTools],
      ],
      body,
    );
    const fromTemplate = pa.description === undefined && note === undefined && pa.prompt === undefined;
    f.summaries.push(fromTemplate ? `用模板新建 agent 定义 ${pa.name}` : `新建 agent 定义 ${pa.name}`);
    if (t.placeholder) {
      const parts: string[] = [];
      if (pa.description === undefined && note === undefined) parts.push('描述');
      if (pa.prompt === undefined) parts.push('系统提示词');
      if (parts.length) {
        this.note('warn', `新建的 ${pa.name} 的${parts.join('和')}还是占位文字：主会话靠描述决定什么时候派发它，现在它不知道该什么时候用这个 agent。请在节点上填写后再应用`);
      }
    }
    this.agentTouched(pa.model !== null, pa.effort !== null, true);
    return { tools, disallowedTools };
  }

  /** 从备份恢复：目标写成备份里的原始字节；备份时原文件不存在则删除 */
  restore(backupId: unknown) {
    if (typeof backupId !== 'string') throw new PlanError('backupId 必须是字符串');
    const b = getBackup(backupId);
    if (!b) throw new PlanError(`找不到备份 ${backupId}`);
    const target = checkWritable(b.entry.filePath, this.ctx.knownCwds);
    const f = this.file(target);
    if (b.bytes) {
      if (f.origBytes && f.origBytes.equals(b.bytes)) {
        this.note('info', '当前文件内容和备份完全相同，不需要恢复');
        return;
      }
      const { text, bom } = decodeUtf8(b.bytes);
      f.text = text ?? '';
      f.bom = bom;
      f.rawAfter = b.bytes;
      f.summaries.push(`恢复到 ${b.entry.createdAt} 的备份（${b.entry.kind === 'first-write' ? '首写备份' : '变更前备份'}）`);
    } else {
      if (f.text === null) {
        this.note('info', '备份时这个文件不存在，现在也不存在，不需要恢复');
        return;
      }
      f.text = null;
      f.summaries.push(`恢复到 ${b.entry.createdAt} 的状态：当时文件不存在，因此删除（当前内容会先备份）`);
    }
    if (target.kind === 'agent') this.touched.agents = true;
  }

  // ---------------- 汇总 ----------------

  private finalNotes(changes: InternalChange[]) {
    const isSettings = (c: InternalChange) => ['settings.json', 'settings.local.json'].includes(path.basename(c.filePath).toLowerCase());
    const settingsChanged = changes.some(isSettings);
    // 最近的会话都是从桌面版启动的：桌面版启动内嵌 CLI 时显式带 --model / --effort，不读 settings.json 里的这两项。
    // 索引里一个会话都没有时不提示
    const desktopOnly = this.ctx.desktopOnly === true;
    if (desktopOnly && settingsChanged && (this.touched.mainModel || this.touched.effort)) {
      this.note('warn', PLAN_DESKTOP_MAIN_NOTE);
    }
    if (desktopOnly && settingsChanged && this.touched.advisorModel) {
      this.note('warn', PLAN_DESKTOP_ADVISOR_NOTE);
    }
    if (desktopOnly && settingsChanged && this.touched.compact) {
      this.note('warn', PLAN_DESKTOP_COMPACT_NOTE);
    }
    for (const n of envNotes(this.ctx, {
      modelKeys: settingsChanged && (this.touched.mainModel || this.touched.advisorModel),
      effort: this.touched.effort || this.touched.agentEffort,
      agentModel: this.touched.agentModel,
      advisor: this.touched.advisorModel,
      compact: this.touched.compact,
    })) {
      this.note(n.level, n.message);
    }
    const agentFiles = changes.filter((c) => c.filePath.toLowerCase().endsWith('.md') && path.basename(path.dirname(c.filePath)).toLowerCase() === 'agents');
    if (agentFiles.length) {
      this.note(
        'info',
        this.touched.newAgentDir
          ? 'agents 目录是这次新建的：Claude Code 只监视会话启动时已存在的目录，已经在运行的会话要重启后才能加载这些定义，新开的会话会直接使用'
          : '已经在运行的会话会在几秒内检测到定义文件的变化（官方文档），之后的派发使用新定义；正在执行中的子 agent 不受影响',
      );
    }
    if (agentFiles.some((c) => c.kind === 'create' || c.kind === 'modify')) {
      this.note('info', '新开一个会话后，回到搭建页查看生效检查');
    }
    // 项目方案
    const projectCwd = this.presetApplied?.projectCwd ?? null;
    if (projectCwd !== null) {
      this.note('info', `这份方案只对在 ${projectCwd} 下开始的会话生效。`);
      if (changes.some((c) => c.kind === 'create' && path.basename(c.filePath).toLowerCase() === 'settings.local.json')) {
        this.note('info', 'settings.local.json 是你个人的设置，Claude Code 自己创建它时会让它不进版本库；这次是 agentree 创建的，如果这个项目用 git，请自己把它加进 .gitignore。');
      }
    }
    // advisor 与主模型的搭配（官方文档 advisor.md 的表格，只检查确定会被拒绝的组合）
    const settings = changes.find(isSettings);
    if (settings?.after) {
      try {
        const doc = parseJsonDoc(settings.after);
        const main = nodeAt(doc, ['model'])?.value;
        const adv = nodeAt(doc, ['advisorModel'])?.value;
        if (typeof main === 'string' && typeof adv === 'string') {
          const fm = modelFamily(main);
          const fa = modelFamily(adv);
          if (fm === 'fable' && fa && fa !== 'fable') {
            this.note('warn', `主模型 ${main} 是 Fable，官方文档说明 Fable 主模型只接受 Fable 顾问，${adv} 会被拒绝`);
          } else if (fm === 'opus' && fa === 'sonnet') {
            this.note('warn', `主模型 ${main} 是 Opus，官方文档说明 Opus 4.7 及之后的主模型不接受 Sonnet 顾问`);
          }
          if (fa === 'fable') this.note('info', 'Fable 作为顾问需要账号有 Fable 权限；部分套餐需要先运行 /model fable 同意按用量额度计费，否则 advisor 不会生效');
        }
      } catch {
        /* settings 解析失败的情况前面已经报错 */
      }
    }
  }

  build(): StoredPlan {
    const internal: InternalChange[] = [];
    for (const f of this.files.values()) {
      const isSettings = f.target.kind === 'settings';
      let afterText = f.text;
      // 新建的 settings.json 末尾加换行
      if (isSettings && !f.existed && afterText !== null) {
        if (afterText === '{}') afterText = null;
        else afterText += '\n';
      }
      const afterBytes = f.rawAfter !== undefined ? f.rawAfter : afterText === null ? null : encodeText(afterText, f.bom);
      if (!f.existed && afterBytes === null) continue;
      if (f.existed && afterBytes && f.origBytes && afterBytes.equals(f.origBytes)) continue;
      const kind: FileChange['kind'] = !f.existed ? 'create' : afterBytes === null ? 'delete' : 'modify';
      internal.push({
        filePath: f.target.path,
        kind,
        before: f.origText,
        after: afterText,
        baseHash: f.baseHash,
        summary: f.summaries.join('；') || (kind === 'create' ? '新建' : kind === 'delete' ? '删除' : '修改'),
        afterBytes,
      });
    }
    this.finalNotes(internal);
    const now = Date.now();
    const plan: ChangePlan = {
      id: crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
      changes: internal.map(({ afterBytes: _b, ...c }) => c),
      notes: this.notes,
      blocked: this.errors.length > 0,
      errors: this.errors,
      conflicts: this.conflicts,
    };
    if (!plan.blocked && plan.changes.length === 0) this.note('info', '没有需要修改的内容：当前配置已经是目标状态');
    return this.presetApplied ? { plan, internal, presetApply: this.presetApplied } : { plan, internal };
  }
}

/** 生成计划（纯计算，不写任何文件） */
export function makePlan(actions: ConfigAction[], ctx: PlanContext): StoredPlan {
  const p = new Planner(ctx);
  p.run(actions);
  return p.build();
}

export function makeRestorePlan(backupId: string, ctx: PlanContext): StoredPlan {
  const p = new Planner(ctx);
  try {
    p.restore(backupId);
  } catch (e) {
    if (e instanceof PlanError || e instanceof PathError) return blockedPlan((e as Error).message);
    throw e;
  }
  return p.build();
}

export function blockedPlan(message: string): StoredPlan {
  const now = Date.now();
  return {
    plan: {
      id: crypto.randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
      changes: [],
      notes: [],
      blocked: true,
      errors: [message],
      conflicts: [],
    },
    internal: [],
  };
}

export { sha256 };

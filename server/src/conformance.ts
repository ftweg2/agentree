// 一致性检查：预设 vs 日志里的实际运行值。纯函数。
import type { CheckLevel, Conformance, ConformanceCheck, ConformanceVerdict, Preset, PresetAgent, SchemeRef } from '../../shared/types.ts';
import path from 'node:path';
import { BUILTIN_AGENT_TYPES, EFFORT_ORDER } from './config.ts';

export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/** 归一化：去掉 [1m] 这类方括号后缀和末尾日期（-20250929），统一小写 */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/(\s*\[[^\]]*\])+$/g, '');
  m = m.replace(/-\d{8}$/, '');
  return m.trim();
}

export function isAlias(model: string): boolean {
  return MODEL_ALIASES.includes(normalizeModel(model));
}

/** 模型所属系列（opus / sonnet / haiku / fable），认不出返回 null */
export function modelFamily(model: string): string | null {
  const m = normalizeModel(model);
  if (MODEL_ALIASES.includes(m)) return m;
  for (const a of MODEL_ALIASES) {
    if (m.includes(`-${a}-`) || m.endsWith(`-${a}`) || m.startsWith(`${a}-`)) return a;
  }
  return null;
}

export interface ModelMatch {
  level: 'ok' | 'warn' | 'fail';
  reason: string;
}

/** 单个实际模型与预设的比较 */
export function matchModel(expected: string, actual: string): ModelMatch {
  const e = normalizeModel(expected);
  const a = normalizeModel(actual);
  if (MODEL_ALIASES.includes(e)) {
    // 实际值也是同一个别名（如记录上的 advisorModel 就写的 fable）时同样算符合
    if (a === e || a.includes(`-${e}-`) || a.endsWith(`-${e}`)) {
      return { level: 'ok', reason: `预设是别名 ${e}，实际模型 ${actual} 属于该系列` };
    }
    return { level: 'fail', reason: `预设是 ${e} 系列，实际用的是 ${actual}` };
  }
  if (e === a) {
    const note = normalizeModel(actual) !== actual.trim().toLowerCase() || normalizeModel(expected) !== expected.trim().toLowerCase() ? '（忽略了 [1m] 或日期后缀）' : '';
    return { level: 'ok', reason: `实际模型与预设一致${note}` };
  }
  const fe = modelFamily(e);
  const fa = modelFamily(a);
  if (fe && fe === fa) {
    return { level: 'warn', reason: `同属 ${fe} 系列但版本不同：预设 ${expected}，实际 ${actual}` };
  }
  return { level: 'fail', reason: `实际模型 ${actual} 与预设 ${expected} 不是同一个模型` };
}

const SEVERITY: Record<CheckLevel, number> = { ok: 0, info: 1, warn: 2, fail: 3 };
export function worst(levels: CheckLevel[]): CheckLevel {
  let w: CheckLevel = 'ok';
  for (const l of levels) if (SEVERITY[l] > SEVERITY[w]) w = l;
  return w;
}

/**
 * 模型检查。models 为该 agent 实际用过的模型（按请求数从多到少），primary 为请求最多的模型。
 * inheritFrom：预设为 inherit 时继承的模型（主会话的主模型）。
 */
export function checkModel(expected: string | null, models: string[], primary: string | null, inheritFrom: string | null = null): ConformanceCheck | null {
  if (expected === null || expected === undefined || expected === '') return null;
  let exp = expected;
  let inheritNote = '';
  if (normalizeModel(expected) === 'inherit') {
    if (!inheritFrom) {
      return { field: 'model', level: 'info', expected, actual: primary, message: '预设为 inherit（继承主会话模型），但主会话没有可比较的模型' };
    }
    exp = inheritFrom;
    inheritNote = `预设为 inherit，按主会话模型 ${inheritFrom} 比较。`;
  }
  if (!primary) {
    return { field: 'model', level: 'info', expected, actual: null, message: '该 agent 还没有发出过计费请求，无法检查模型' };
  }
  const m = matchModel(exp, primary);
  if (models.length > 1) {
    const list = models.join('、');
    const level: CheckLevel = m.level === 'fail' ? 'fail' : 'warn';
    const others = models.filter((x) => x !== primary);
    const otherResults = others.map((x) => `${x}：${matchModel(exp, x).level === 'ok' ? '符合' : '不符合'}`).join('；');
    return {
      field: 'model',
      level,
      expected,
      actual: list,
      message: `${inheritNote}该 agent 中途用了多个模型（${list}）。主要模型 ${primary}：${m.reason}。其他：${otherResults}`,
    };
  }
  return { field: 'model', level: m.level, expected, actual: primary, message: inheritNote + m.reason };
}

export function effortRank(e: string): number {
  return EFFORT_ORDER.indexOf(e.trim().toLowerCase());
}

/** effort 检查。efforts 为实际出现过的 effort（按首次出现顺序） */
export function checkEffort(expected: string | null, efforts: string[]): ConformanceCheck | null {
  if (expected === null || expected === undefined || expected === '') return null;
  if (efforts.length === 0) {
    return { field: 'effort', level: 'info', expected, actual: null, message: '日志里没有 effort 字段，无法检查（旧版本或该模型不支持 effort）' };
  }
  const er = effortRank(expected);
  const parts: string[] = [];
  const levels: CheckLevel[] = [];
  for (const a of efforts) {
    const ar = effortRank(a);
    if (a.trim().toLowerCase() === expected.trim().toLowerCase()) {
      levels.push('ok');
      parts.push(`${a} 与预设一致`);
    } else if (er < 0 || ar < 0) {
      levels.push('warn');
      parts.push(`${a} 无法与预设 ${expected} 比较高低`);
    } else if (ar < er) {
      levels.push('warn');
      parts.push(`${a} 低于预设 ${expected}：可能是模型不支持该级别被自动降级，或被环境变量 CLAUDE_CODE_EFFORT_LEVEL 覆盖`);
    } else {
      levels.push('fail');
      parts.push(`${a} 高于预设 ${expected}`);
    }
  }
  const level = worst(levels);
  const prefix = efforts.length > 1 ? `出现过多个 effort（${efforts.join('、')}）。` : '';
  return { field: 'effort', level, expected, actual: efforts.join(', '), message: prefix + parts.join('；') };
}

export function isPresetEmpty(p: Preset): boolean {
  return p.agents.length === 0 && !p.main.model && !p.main.effort && p.main.autoCompactWindow === null && !p.advisor.model;
}

// ---------------- 方案的范围与叠加 ----------------

/** 目录比较用的规范形式：绝对路径，去掉末尾分隔符，Windows 上不区分大小写 */
export function normalizeDir(dir: string): string {
  let r = path.resolve(dir);
  if (r.length > path.parse(r).root.length) r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** cwd 是否等于 root 或在 root 之下 */
export function isUnderDir(cwd: string, root: string): boolean {
  const c = normalizeDir(cwd);
  const r = normalizeDir(root);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 会话目录属于哪个项目方案：等于或在其下的项目目录里取最长（最深）的那个；都不是返回 null */
export function owningProject(cwd: string | null, projectCwds: string[]): string | null {
  if (!cwd) return null;
  let best: string | null = null;
  for (const p of projectCwds) {
    if (isUnderDir(cwd, p) && (best === null || normalizeDir(p).length > normalizeDir(best).length)) best = p;
  }
  return best;
}

/**
 * 项目方案叠在全局方案上，得到一个项目里实际生效的方案（契约 Preset 上方的注释）：
 *   子 agent 取并集，同名用项目的（名字不区分大小写）；
 *   主模型、主 effort、advisor、自动压缩阈值 项目为 null 时用全局的；allowBuiltins 用项目的
 */
export function overlayPreset(global: Preset, project: Preset): Preset {
  const own = new Set(project.agents.map((a) => a.name.toLowerCase()));
  return {
    version: 1,
    main: {
      model: project.main.model ?? global.main.model,
      effort: project.main.effort ?? global.main.effort,
      autoCompactWindow: project.main.autoCompactWindow ?? global.main.autoCompactWindow,
    },
    advisor: { model: project.advisor.model ?? global.advisor.model },
    agents: [...project.agents, ...global.agents.filter((a) => !own.has(a.name.toLowerCase()))],
    allowBuiltins: project.allowBuiltins,
    updatedAt: project.updatedAt,
  };
}

/**
 * 给一个会话确定方案：属于某个项目方案 -> 叠加后的方案；否则全局方案有内容 -> 全局；否则 none（仍返回空的全局方案）
 */
export function schemeForSession(cwd: string | null, global: Preset, projects: Array<{ projectCwd: string; preset: Preset }>): { ref: SchemeRef; preset: Preset } {
  const owner = owningProject(
    cwd,
    projects.map((p) => p.projectCwd),
  );
  if (owner !== null) {
    const proj = projects.find((p) => p.projectCwd === owner)!;
    return { ref: { scope: 'project', projectCwd: owner }, preset: overlayPreset(global, proj.preset) };
  }
  return { ref: { scope: isPresetEmpty(global) ? 'none' : 'user', projectCwd: null }, preset: global };
}

export function findPresetAgent(p: Preset, agentType: string | null): PresetAgent | null {
  if (!agentType) return null;
  return p.agents.find((a) => a.name === agentType) ?? p.agents.find((a) => a.name.toLowerCase() === agentType.toLowerCase()) ?? null;
}

export function verdictOf(checks: ConformanceCheck[], unplanned: boolean): ConformanceVerdict {
  if (unplanned) return 'unplanned';
  if (checks.some((c) => c.level === 'fail')) return 'mismatch';
  if (checks.some((c) => c.level !== 'info')) return 'match';
  return 'not-checked';
}

export interface ActualAgent {
  agentType: string | null;
  models: string[];
  primaryModel: string | null;
  efforts: string[];
  /** 父节点的 agent 类型（父节点是主会话时为 null） */
  parentAgentType?: string | null;
  /** 派发时传给 Agent 工具的 model 参数；没传为 null */
  requestedModel?: string | null;
}

/**
 * 派发时传的 model 参数和方案要求的是否算同一个：别名能匹配这个系列的完整 ID，反过来要求写完整 ID、实际传别名也算
 * （Agent 工具的 model 参数本来就常传别名）
 */
export function sameDispatchModel(expected: string, actual: string): boolean {
  if (matchModel(expected, actual).level === 'ok') return true;
  return isAlias(actual) && matchModel(actual, expected).level === 'ok';
}

/**
 * 父 agent 在方案里指定了往下派发的模型（dispatchModel）时，核对这次派发实际传的 model 参数。
 * 这是写在父 agent 提示词里的要求、不是硬性限制，所以不符合只给 warn，不判为不符合方案。
 * 父节点是主会话、父 agent 不在方案里、没指定或是内置类型（写不进定义文件）时返回 null
 */
export function checkDispatch(preset: Preset, parentAgentType: string | null | undefined, requestedModel: string | null | undefined): ConformanceCheck | null {
  const parent = findPresetAgent(preset, parentAgentType ?? null);
  const expected = parent?.dispatchModel;
  if (!parent || typeof expected !== 'string' || BUILTIN_AGENT_TYPES.some((b) => b.toLowerCase() === parent.name.toLowerCase())) return null;
  const actual = requestedModel ?? null;
  const head = `父 agent ${parent.name} 的提示词要求派发时传 ${expected}`;
  if (actual === null) {
    return {
      field: 'dispatch',
      level: 'warn',
      expected,
      actual: null,
      message: `${head}，这次没传 model 参数（下一层按自己定义里的模型或主会话的模型运行）。这是提示词里的要求，模型不一定照做`,
    };
  }
  if (sameDispatchModel(expected, actual)) return { field: 'dispatch', level: 'ok', expected, actual, message: `${head}，这次传的正是 ${actual}` };
  return { field: 'dispatch', level: 'warn', expected, actual, message: `${head}，这次传的是 ${actual}。这是提示词里的要求，模型不一定照做` };
}

/** 单个子 agent 的一致性 */
export function subagentConformance(preset: Preset, a: ActualAgent, mainPrimaryModel: string | null): Conformance {
  if (isPresetEmpty(preset)) return { verdict: 'not-checked', presetAgent: null, checks: [] };
  const checks: ConformanceCheck[] = [];
  const pa = findPresetAgent(preset, a.agentType);
  const type = a.agentType ?? '（未知类型）';
  // 派发它的父 agent 有没有按方案要求传 model 参数：和它自己的类型在不在方案里无关，放在最后
  const dc = checkDispatch(preset, a.parentAgentType, a.requestedModel);
  if (pa) {
    checks.push({ field: 'agent', level: 'ok', expected: pa.name, actual: a.agentType, message: `agent 类型 ${type} 在预设中` });
    const mc = checkModel(pa.model, a.models, a.primaryModel, mainPrimaryModel);
    if (mc) checks.push(mc);
    const ec = checkEffort(pa.effort, a.efforts);
    if (ec) checks.push(ec);
    // dispatch 只会是 ok 或 warn，不会让它变成不符合
    if (dc) checks.push(dc);
    return { verdict: verdictOf(checks, false), presetAgent: pa.name, checks };
  }
  const builtin = a.agentType !== null && BUILTIN_AGENT_TYPES.includes(a.agentType);
  if (builtin && preset.allowBuiltins) {
    checks.push({
      field: 'agent',
      level: 'info',
      expected: null,
      actual: a.agentType,
      message: `${type} 是内置类型，预设允许使用内置类型，不做模型和 effort 检查`,
    });
    if (dc) checks.push(dc);
    // 预设允许内置类型即视为符合计划
    return { verdict: 'match', presetAgent: null, checks };
  }
  checks.push({
    field: 'agent',
    level: 'fail',
    expected: preset.agents.map((x) => x.name).join(', ') || null,
    actual: a.agentType,
    message: builtin ? `${type} 是内置类型，但预设不允许使用内置类型` : `agent 类型 ${type} 不在预设里，属于计划外派发`,
  });
  if (dc) checks.push(dc);
  return { verdict: 'unplanned', presetAgent: null, checks };
}

export interface ActualMain {
  models: string[];
  primaryModel: string | null;
  efforts: string[];
  advisorModel: string | null;
  advisorCalls: number;
}

/** 会话级检查：主模型、主 effort、advisor 配置、advisor 调用 */
export function sessionChecks(preset: Preset, m: ActualMain): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const mc = checkModel(preset.main.model, m.models, m.primaryModel);
  if (mc) checks.push(mc);
  const ec = checkEffort(preset.main.effort, m.efforts);
  if (ec) checks.push(ec);
  const exp = preset.advisor.model;
  if (exp) {
    if (!m.advisorModel) {
      checks.push({
        field: 'advisor',
        level: 'fail',
        expected: exp,
        actual: null,
        message: '预设了 advisor，但日志记录上没有 advisorModel，advisor 没有被配置',
      });
    } else {
      const r = matchModel(exp, m.advisorModel);
      checks.push({ field: 'advisor', level: r.level, expected: exp, actual: m.advisorModel, message: `advisor 配置：${r.reason}` });
    }
    if (m.advisorCalls === 0) {
      checks.push({
        field: 'advisor',
        level: 'warn',
        expected: exp,
        actual: '0 次调用',
        message: '配置了 advisor，但这次会话没有触发过（可能是没有需要咨询的时机，也可能被静默停用：非官方 API、DISABLE_TELEMETRY、CLAUDE_CODE_DISABLE_ADVISOR_TOOL 等）',
      });
    } else {
      checks.push({
        field: 'advisor',
        level: 'ok',
        expected: exp,
        actual: `${m.advisorCalls} 次调用`,
        message: `advisor 实际被调用了 ${m.advisorCalls} 次`,
      });
    }
  } else if (m.advisorModel && m.advisorCalls === 0) {
    // 预设没指定 advisor：只要记录上配置了 advisor 而从未调用，就给一条提示（info 不计入 warn/fail，也不影响判定）
    checks.push({
      field: 'advisor',
      level: 'info',
      expected: null,
      actual: '0 次调用',
      message: `日志记录上配置了 advisor（${m.advisorModel}），但这次会话没有触发过。预设没有指定 advisor，仅作提示；可能是没有需要咨询的时机，也可能被静默停用（非官方 API、DISABLE_TELEMETRY、CLAUDE_CODE_DISABLE_ADVISOR_TOOL 等）`,
    });
  }
  return checks;
}

export function mainConformance(preset: Preset, checks: ConformanceCheck[]): Conformance {
  // 预设为空时只可能有 info 级提示，verdictOf 会给出 not-checked
  return { verdict: isPresetEmpty(preset) ? 'not-checked' : verdictOf(checks, false), presetAgent: null, checks };
}

// 模拟模式下的一致性检查：按 docs/spec.md 的规则简化实现，只用于演示数据。
// 真实判定由后端完成。
import type { AgentNode, Conformance, ConformanceCheck, ConformanceVerdict, Preset } from '../types';

export const BUILTIN_TYPES = [
  'general-purpose',
  'Explore',
  'Plan',
  'claude-code-guide',
  'statusline-setup',
  'claude',
  'output-style-setup',
];
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

function normalize(m: string): string {
  return m.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

function familyOf(m: string): string | null {
  const n = normalize(m).toLowerCase();
  return ALIASES.find((a) => n.includes(`-${a}-`) || n.endsWith(`-${a}`) || n === a) ?? null;
}

export function checkModel(expected: string | null, node: Pick<AgentNode, 'primaryModel' | 'models'>): ConformanceCheck | null {
  if (!expected) return null;
  const actual = node.primaryModel;
  if (!actual) {
    return { field: 'model', level: 'info', expected, actual: null, message: '日志里没有这个 agent 的模型信息，无法比较。' };
  }
  const all = node.models.map((m) => m.model);
  if (all.length > 1) {
    return {
      field: 'model',
      level: 'warn',
      expected,
      actual: all.join(', '),
      message: `这个 agent 中途用了 ${all.length} 个模型：${all.join('、')}。按请求最多的 ${actual} 比较，其余模型可能来自自动切换或回退。`,
    };
  }
  const n = normalize(actual);
  if (ALIASES.includes(expected)) {
    if (n.includes(`-${expected}-`) || n.endsWith(`-${expected}`)) {
      return { field: 'model', level: 'ok', expected, actual, message: `别名 ${expected} 解析为 ${actual}，符合预设。` };
    }
    return { field: 'model', level: 'fail', expected, actual, message: `预设为 ${expected} 系列，实际运行的是 ${actual}。` };
  }
  if (normalize(expected) === n) {
    return {
      field: 'model',
      level: 'ok',
      expected,
      actual,
      message: actual !== expected ? `去掉后缀后与预设一致（${actual}）。` : '与预设一致。',
    };
  }
  const fe = familyOf(expected);
  if (fe && fe === familyOf(actual)) {
    return {
      field: 'model',
      level: 'warn',
      expected,
      actual,
      message: `同属 ${fe} 系列但版本不同：预设 ${expected}，实际 ${actual}。可能是 availableModels 限制或该版本不可用时的替换。`,
    };
  }
  return { field: 'model', level: 'fail', expected, actual, message: `预设 ${expected}，实际运行的是 ${actual}，不属于同一系列。` };
}

export function checkEffort(expected: string | null, efforts: string[]): ConformanceCheck | null {
  if (!expected) return null;
  if (efforts.length === 0) {
    return { field: 'effort', level: 'info', expected, actual: null, message: '日志里没有记录 effort，无法比较。旧版本 Claude Code 不写这个字段。' };
  }
  const ei = EFFORT_ORDER.indexOf(expected);
  const actual = efforts.join(', ');
  const higher = efforts.filter((e) => EFFORT_ORDER.indexOf(e) > ei);
  const lower = efforts.filter((e) => EFFORT_ORDER.indexOf(e) < ei);
  if (higher.length) {
    return { field: 'effort', level: 'fail', expected, actual, message: `实际 effort（${higher.join('、')}）高于预设的 ${expected}，会多消耗 token。` };
  }
  if (lower.length) {
    return {
      field: 'effort',
      level: 'warn',
      expected,
      actual,
      message: `实际 effort（${lower.join('、')}）低于预设的 ${expected}。可能是模型不支持该级别被自动降级，或被环境变量 CLAUDE_CODE_EFFORT_LEVEL 覆盖。`,
    };
  }
  return { field: 'effort', level: 'ok', expected, actual, message: '与预设一致。' };
}

function verdictOf(checks: ConformanceCheck[]): ConformanceVerdict {
  if (checks.some((c) => c.level === 'fail')) return 'mismatch';
  if (checks.length === 0) return 'not-checked';
  return 'match';
}

export function agentConformance(node: AgentNode, preset: Preset): Conformance {
  const type = node.agentType ?? '';
  const pa = preset.agents.find((a) => a.name === type);
  if (pa) {
    const checks: ConformanceCheck[] = [
      { field: 'agent', level: 'ok', expected: pa.name, actual: type, message: '该类型在预设里。' },
    ];
    const m = checkModel(pa.model, node);
    if (m) checks.push(m);
    const e = checkEffort(pa.effort, node.efforts);
    if (e) checks.push(e);
    return { verdict: verdictOf(checks), presetAgent: pa.name, checks };
  }
  if (BUILTIN_TYPES.includes(type) && preset.allowBuiltins) {
    return {
      verdict: 'not-checked',
      presetAgent: null,
      checks: [
        {
          field: 'agent',
          level: 'info',
          expected: null,
          actual: type,
          message: `${type} 是内置类型，预设允许使用内置类型，不检查模型和 effort。`,
        },
      ],
    };
  }
  return {
    verdict: 'unplanned',
    presetAgent: null,
    checks: [
      {
        field: 'agent',
        level: 'fail',
        expected: preset.agents.map((a) => a.name).join(', ') || null,
        actual: type,
        message: BUILTIN_TYPES.includes(type)
          ? `${type} 是内置类型，但预设不允许使用内置类型。`
          : `${type} 不在预设的 agent 列表里，也不是内置类型。`,
      },
    ],
  };
}

export function sessionChecks(main: AgentNode, preset: Preset): ConformanceCheck[] {
  const out: ConformanceCheck[] = [];
  const m = checkModel(preset.main.model, main);
  if (m) out.push(m);
  const e = checkEffort(preset.main.effort, main.efforts);
  if (e) out.push(e);
  if (preset.advisor.model) {
    const actual = main.advisorModel;
    if (!actual) {
      out.push({
        field: 'advisor',
        level: 'fail',
        expected: preset.advisor.model,
        actual: null,
        message: '预设要求 advisor，但日志记录上没有配置 advisor 模型。',
      });
    } else {
      const c = checkModel(preset.advisor.model, { primaryModel: actual, models: [] });
      out.push({ ...(c as ConformanceCheck), field: 'advisor', message: `advisor 配置：${(c as ConformanceCheck).message}` });
    }
  }
  if (main.advisorModel && main.advisorCalls === 0) {
    out.push({
      field: 'advisor',
      // 与真实后端一致：配置了但未调用给 info
      level: 'info',
      expected: '至少调用 1 次',
      actual: '0 次',
      message: '配置了 advisor，但这次会话没有触发过。可能被环境变量禁用、走了代理，或 API 拒绝后被静默停用。',
    });
  }
  return out;
}

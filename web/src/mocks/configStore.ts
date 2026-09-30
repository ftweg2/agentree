// 第二阶段的模拟后端：内存里的"文件系统"、计划、应用、备份。
// 只在 VITE_USE_MOCK=1 时加载。行为按 docs/spec-phase2.md 简化实现，便于演示各种界面状态：
// - 应用默认模板：5 个文件变更全部成功（带 warn 和 info 提示）
// - 应用默认预设：test-runner.md 是只读文件，会在中途失败 → 部分失败
// - 编辑 researcher.md：打开 1 秒后模拟外部程序修改它 → 保存时冲突（仅第一次）
// - legacy-helper.md 的 frontmatter 没有结束标记 → 编辑它的计划 blocked
// - 设置 effort 为 max → blocked
import type {
  AgentDefinition,
  AgentDefinitionDetail,
  AgentFields,
  ApplyResult,
  BackupEntry,
  ChangePlan,
  ClaudeMdRuleState,
  ConfigAction,
  FileChange,
  PlanNote,
  Preset,
  PresetTemplate,
} from '../types';
import { ApiFailure } from '../api/client';
import { BUILTIN_TYPES } from './conformance';
import { parseDispatch, withDispatch } from '../../../shared/dispatch';
import { defaultRuleText } from '../../../shared/rule';

export const CONFIG_DIR = 'C:\\Users\\you\\.claude';
const SETTINGS = `${CONFIG_DIR}\\settings.json`;
const CLAUDE_MD = `${CONFIG_DIR}\\CLAUDE.md`;
const USER_AGENTS = `${CONFIG_DIR}\\agents`;
export const KNOWN_PROJECTS = ['C:\\Users\\you\\Desktop\\agentree', 'C:\\Users\\you\\Documents\\blog', 'C:\\Users\\you\\Documents\\notes'];
const projectAgents = (cwd: string) => `${cwd}\\.claude\\agents`;

const START = '<!-- agentree:advisor-rule:start -->';
const END = '<!-- agentree:advisor-rule:end -->';
export const DEFAULT_RULE = `## 何时咨询 advisor

- 动手做一个大的计划之前，先问 advisor 这个方向对不对
- 同一个错误第二次出现时，问 advisor 是不是走错了路
- 宣布一个耗时长的任务完成之前，问 advisor 有没有遗漏`;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SETTINGS_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

interface MockFile {
  content: string;
  readonly?: boolean;
}

const files = new Map<string, MockFile>();
const firstWritten = new Set<string>();
const backups: Array<{ entry: BackupEntry; content: string | null }> = [];
const plans = new Map<string, { plan: ChangePlan; used: boolean }>();
let conflictArmed = true;
let seq = 1;

// ---------- 初始文件 ----------

const agentFile = (fm: string[], body: string) => `---\n${fm.join('\n')}\n---\n\n${body}\n`;

files.set(
  SETTINGS,
  {
    content:
      JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/claude-code-settings.json',
          permissions: { allow: ['Bash(npm run test:*)', 'Read(~/.claude/**)'], deny: ['Read(./.env)'] },
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'powershell -File C:\\Users\\you\\.claude\\notify.ps1' }] }],
          },
          env: { DISABLE_TELEMETRY: '1' },
          modelSettings: { 'claude-sonnet-5': { effortLevel: 'high' } },
          autoCompactWindow: 500000,
        },
        null,
        2,
      ) + '\n',
  },
);
files.set(CLAUDE_MD, { content: '# 我的全局约定\n\n- 回答用中文\n- 改代码前先读相关文件\n- 不要自动提交 git\n' });
files.set(`${USER_AGENTS}\\code-reviewer.md`, {
  content: agentFile(
    ['name: code-reviewer', 'description: 审查代码改动，只读', 'model: sonnet', 'effort: high', 'tools: Read, Grep, Glob'],
    '你是代码审查员。只读，不修改文件。\n\n按严重程度列出问题，给出文件路径和行号。',
  ),
});
files.set(`${USER_AGENTS}\\test-runner.md`, {
  content: agentFile(['name: test-runner', 'description: 运行测试并汇报失败', 'model: haiku', 'effort: medium', 'tools: Bash, Read'], '运行项目的测试命令，汇报失败的用例和错误信息。'),
  readonly: true,
});
files.set(`${USER_AGENTS}\\researcher.md`, {
  content: agentFile(
    [
      'name: researcher',
      'description: >',
      '  调研文档和源码，',
      '  回答技术问题',
      'model: opus',
      'effort: high',
      'color: purple',
      '# 下面两项 agentree 不管理，会原样保留',
      'permissionMode: plan',
      'mcpServers:',
      '  - context7',
    ],
    '以官方文档为准，标明出处。查不到就说查不到。\n\n---\n\n（上面这条分隔线是正文的一部分，不是 frontmatter 边界）',
  ),
});
files.set(`${projectAgents(KNOWN_PROJECTS[0])}\\doc-writer.md`, {
  content: agentFile(['name: doc-writer', 'description: 维护 README 和文档', 'model: fable', 'tools: Read, Write, Edit'], '只改文档，不改代码。'),
});
files.set(`${projectAgents(KNOWN_PROJECTS[0])}\\perf-profiler.md`, {
  content: agentFile(['name: perf-profiler', 'description: 性能分析', 'model: inherit', 'effort: max', 'maxTurns: 40', 'skills:', '  - profiling'], '分析性能瓶颈，给出数据。'),
});
files.set(`${projectAgents(KNOWN_PROJECTS[0])}\\legacy-helper.md`, {
  content: '---\nname: legacy-helper\ndescription: 旧的助手，frontmatter 缺少结束标记\nmodel: sonnet\n\n这是正文，但上面的 frontmatter 没有用 --- 结束。\n',
});

function seedBackups() {
  const now = Date.now();
  const orig = JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)'] } }, null, 2) + '\n';
  backups.push(
    {
      entry: { id: 'bk-seed-2', filePath: SETTINGS, createdAt: new Date(now - 86400_000).toISOString(), kind: 'pre-change', existedBefore: true, size: 212 },
      content: JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)'] }, model: 'sonnet' }, null, 2) + '\n',
    },
    {
      entry: { id: 'bk-seed-1', filePath: SETTINGS, createdAt: new Date(now - 3 * 86400_000).toISOString(), kind: 'first-write', existedBefore: true, size: orig.length },
      content: orig,
    },
    {
      entry: { id: 'bk-seed-0', filePath: `${USER_AGENTS}\\old-explorer.md`, createdAt: new Date(now - 5 * 86400_000).toISOString(), kind: 'pre-change', existedBefore: true, size: 120 },
      content: agentFile(['name: old-explorer', 'description: 以前删掉的 agent', 'model: haiku'], '只读查找代码。'),
    },
  );
  firstWritten.add(SETTINGS);
}
seedBackups();

// ---------- 工具函数 ----------

export function mockHash(s: string | null): string {
  if (s == null) return '';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519);
  }
  const part = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return part.repeat(4);
}

const key = (p: string) => p.toLowerCase();
function getFile(p: string): MockFile | undefined {
  for (const [k, v] of files) if (key(k) === key(p)) return v;
  return undefined;
}
function realPath(p: string): string {
  for (const k of files.keys()) if (key(k) === key(p)) return k;
  return p;
}
const baseName = (p: string) => p.split('\\').pop()!.replace(/\.md$/i, '');

interface ParsedAgent {
  fm: string[];
  /** 结束 --- 之后的全部原文 */
  rest: string;
}

function parseAgent(content: string, filePath: string): ParsedAgent | { error: string } {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return { error: `${filePath} 第 1 行第 1 列：文件没有以 --- 开头的 frontmatter` };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { error: `${filePath} 第 1 行第 1 列：frontmatter 缺少结束的 ---，无法安全修改` };
  return { fm: lines.slice(1, end), rest: lines.slice(end + 1).join('\n') };
}

/** 定义文件正文末尾 agentree 写的派发块里的模型；文件不存在或没有块时为 null */
export function dispatchModelOf(filePath: string): string | null {
  const f = getFile(filePath);
  if (!f) return null;
  const parsed = parseAgent(f.content, filePath);
  return parseDispatch('rest' in parsed ? parsed.rest : f.content).model;
}

/** 按方案里的 dispatchModel 改正文：undefined 不动，null 删块，字符串写块。rest 是 frontmatter 之后的全部内容 */
function restWithDispatch(rest: string, model: string | null | undefined): string {
  if (model === undefined) return rest;
  // 要删块但本来就没有块：不动，免得只因空行不同而改文件
  if (model === null && parseDispatch(rest).model === null) return rest;
  const body = rest.replace(/^\n/, '').replace(/\n+$/, '');
  return `\n${withDispatch(body, model)}\n`;
}

/** 找到某个顶层键的行范围（含多行值的续行） */
function keyRange(fm: string[], k: string): [number, number] | null {
  const i = fm.findIndex((l) => new RegExp(`^${k}\\s*:`).test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < fm.length && /^\s+\S/.test(fm[j])) j++;
  return [i, j];
}

function readValue(fm: string[], k: string): string | null {
  const r = keyRange(fm, k);
  if (!r) return null;
  const first = fm[r[0]].replace(new RegExp(`^${k}\\s*:\\s*`), '');
  if (first === '>' || first === '|' || first === '>-' || first === '|-') {
    return fm
      .slice(r[0] + 1, r[1])
      .map((l) => l.trim())
      .join(first.startsWith('>') ? '' : '\n');
  }
  const v = first.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v || null;
}

function fmtValue(k: string, v: string): string {
  if (k === 'description' || /[:#'"{}[\]&*!|>%@`]|^\s|\s$/.test(v)) return JSON.stringify(v);
  return v;
}

const MANAGED = ['name', 'description', 'model', 'effort', 'tools'];

function otherFieldsOf(fm: string[]): string[] {
  return fm
    .map((l) => l.match(/^([A-Za-z_][\w-]*)\s*:/)?.[1])
    .filter((k): k is string => !!k && !MANAGED.includes(k));
}

function setKey(fm: string[], k: string, v: string | null): string[] {
  const out = [...fm];
  const r = keyRange(out, k);
  if (v == null) {
    if (r) out.splice(r[0], r[1] - r[0]);
    return out;
  }
  const line = `${k}: ${fmtValue(k, v)}`;
  if (r) out.splice(r[0], r[1] - r[0], line);
  else out.push(line);
  return out;
}

function templateFor(name: string): { description: string; tools: string | null; body: string } {
  switch (name) {
    case 'explorer':
      return {
        description: '只读地查找和阅读代码，回答"某某在哪里""某某是怎么实现的"',
        tools: 'Read, Grep, Glob',
        body: '你只读代码，不修改任何文件。\n\n- 回答要给出文件路径和行号\n- 说清楚哪些是确认过的，哪些是推测',
      };
    case 'worker':
      return {
        description: '需要新建或修改文件、写代码、跑测试时使用。主会话把要求和验收标准写清楚后交给它',
        tools: null,
        body: '- 只改任务要求的范围\n- 改完运行相关测试\n- 如实报告测试结果，失败就说失败',
      };
    case 'researcher':
      return {
        description: '查阅文档和资料，回答技术问题',
        tools: 'Read, Grep, Glob, WebFetch, WebSearch',
        body: '- 以官方文档为准\n- 标明出处\n- 查不到就说查不到',
      };
    default:
      return { description: '', tools: null, body: '这是 agentree 生成的占位说明。请编辑这段正文，写清楚这个 agent 负责什么、怎么做、不做什么。' };
  }
}

function buildAgent(name: string, fields: AgentFields, body: string): string {
  let fm: string[] = [`name: ${name}`];
  fm = setKey(fm, 'description', fields.description);
  fm = setKey(fm, 'model', fields.model);
  fm = setKey(fm, 'effort', fields.effort);
  fm = setKey(fm, 'tools', fields.tools);
  return agentFile(fm, body.replace(/\n+$/, ''));
}

// ---------- 读接口 ----------

function agentPaths(): string[] {
  return [...files.keys()].filter((p) => /\\agents\\[^\\]+\.md$/i.test(p));
}

export function definitions(): AgentDefinition[] {
  return agentPaths()
    .map((p) => {
      const content = files.get(p)!.content;
      const parsed = parseAgent(content, p);
      const isUser = key(p).startsWith(key(USER_AGENTS));
      const projectCwd = isUser ? null : KNOWN_PROJECTS.find((c) => key(p).startsWith(key(projectAgents(c)))) ?? null;
      const fm = 'fm' in parsed ? parsed.fm : [];
      return {
        name: readValue(fm, 'name') ?? baseName(p),
        source: isUser ? ('user' as const) : ('project' as const),
        filePath: p,
        description: readValue(fm, 'description'),
        model: readValue(fm, 'model'),
        effort: readValue(fm, 'effort'),
        tools: readValue(fm, 'tools'),
        projectCwd,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

export function settingsSnapshot() {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(files.get(SETTINGS)?.content ?? '{}');
  } catch {
    obj = {};
  }
  const ms = (obj.modelSettings ?? {}) as Record<string, { effortLevel?: string }>;
  const modelEffort: Record<string, string> = {};
  for (const [m, v] of Object.entries(ms)) if (v && typeof v.effortLevel === 'string') modelEffort[m] = v.effortLevel;
  return {
    effortLevel: typeof obj.effortLevel === 'string' ? obj.effortLevel : null,
    model: typeof obj.model === 'string' ? obj.model : null,
    advisorModel: typeof obj.advisorModel === 'string' ? obj.advisorModel : null,
    modelEffort,
    autoCompactWindow: typeof obj.autoCompactWindow === 'number' ? obj.autoCompactWindow : null,
    autoCompactEnabled: typeof obj.autoCompactEnabled === 'boolean' ? obj.autoCompactEnabled : null,
  };
}

export function agentDetail(filePath: string): AgentDefinitionDetail {
  const f = getFile(filePath);
  if (!f) throw new ApiFailure('notfound', `文件不存在：${filePath}`, 404);
  const path = realPath(filePath);
  const def = definitions().find((d) => key(d.filePath) === key(path))!;
  const parsed = parseAgent(f.content, path);
  // 模拟"打开之后被其他程序修改"：第一次打开 researcher.md 1 秒后改动它
  if (conflictArmed && /\\researcher\.md$/i.test(path)) {
    conflictArmed = false;
    setTimeout(() => {
      const cur = files.get(path);
      if (cur) cur.content = cur.content.replace(/\n$/, '') + '\n\n（另一个编辑器在 agentree 之外追加了这一行）\n';
    }, 1000);
  }
  return {
    ...def,
    body: 'rest' in parsed ? parsed.rest.replace(/^\n/, '').replace(/\n$/, '') : f.content,
    otherFields: 'fm' in parsed ? otherFieldsOf(parsed.fm) : [],
    hash: mockHash(f.content),
  };
}

/** preset 是模拟后端保存的方案：默认文字按它生成，方案为空时用 advisor 三条（和真实后端一致） */
export function ruleState(preset?: Preset): ClaudeMdRuleState {
  const f = getFile(CLAUDE_MD);
  const c = f?.content ?? '';
  const s = c.indexOf(START);
  const e = c.indexOf(END);
  const enabled = s >= 0 && e > s;
  const starts = c.split(START).length - 1;
  const ends = c.split(END).length - 1;
  const error =
    starts > 1 || ends > 1 || starts !== ends || (s >= 0 && e >= 0 && e < s)
      ? `CLAUDE.md 里的 agentree 规则标记不成对或出现多次（开始标记 ${starts} 个，结束标记 ${ends} 个），请手动修复后再操作。`
      : null;
  return {
    error,
    filePath: CLAUDE_MD,
    fileExists: !!f,
    enabled,
    text: enabled ? c.slice(s + START.length, e).replace(/^\n/, '').replace(/\n$/, '') : null,
    defaultText: (preset ? defaultRuleText(preset) : '') || DEFAULT_RULE,
  };
}

/** 仅用于演示：让 CLAUDE.md 只剩一个开始标记（规则状态会带 error） */
export function breakRuleForDemo() {
  const f = getFile(CLAUDE_MD);
  if (f) f.content = f.content.replace(/\n*$/, '\n\n') + START + '\n（结束标记丢失了）\n';
}

export function templates(): PresetTemplate[] {
  return [
    {
      id: 'fable-main-opus-agents',
      name: 'Fable 5.1 统筹 + Opus 5.5 干活',
      description: '主会话用 Fable 5.1 拆任务和验收，三个 Opus 5.5 子 agent 分别读代码、改代码、查资料，可以同时跑。适合能拆开的大任务。不设顾问。',
      preset: {
        version: 1,
        main: { model: 'claude-fable-5-1', effort: 'high', autoCompactWindow: null },
        advisor: { model: null },
        agents: [
          { name: 'explorer', model: 'opus', effort: 'medium', note: '读代码' },
          { name: 'worker', model: 'opus', effort: 'medium', note: '改代码' },
          { name: 'researcher', model: 'opus', effort: 'medium', note: '查文档' },
        ],
        allowBuiltins: true,
        updatedAt: null,
      },
      includeRule: true,
    },
    {
      id: 'opus-main-fable-advisor',
      name: 'Opus 5.5 主力 + Fable 5.1 顾问',
      description: '主会话用 Opus 5.5 自己干活，在关键节点咨询 Fable 5.1。不带子 agent，单线进行。适合普通的单线任务，比上一种省。',
      preset: {
        version: 1,
        main: { model: 'claude-opus-5-5', effort: 'high', autoCompactWindow: null },
        advisor: { model: 'fable' },
        agents: [],
        allowBuiltins: true,
        updatedAt: null,
      },
      includeRule: true,
    },
  ];
}

export function backupList(): BackupEntry[] {
  return backups.map((b) => b.entry).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- 生成计划 ----------

class Draft {
  /** 路径 → 修改后的内容（null 表示删除） */
  work = new Map<string, string | null>();
  summaries = new Map<string, string[]>();
  order: string[] = [];
  notes: PlanNote[] = [];
  errors: string[] = [];
  conflicts: string[] = [];

  current(p: string): string | null {
    const rp = realPath(p);
    if (this.work.has(rp)) return this.work.get(rp)!;
    return getFile(rp)?.content ?? null;
  }
  set(p: string, content: string | null, summary: string) {
    const rp = realPath(p);
    if (!this.order.includes(rp)) this.order.push(rp);
    this.work.set(rp, content);
    this.summaries.set(rp, [...(this.summaries.get(rp) ?? []), summary]);
  }
  note(level: PlanNote['level'], message: string) {
    if (!this.notes.some((n) => n.message === message)) this.notes.push({ level, message });
  }
}

function settingsEdit(d: Draft, mutate: (o: Record<string, unknown>) => string | null) {
  const before = d.current(SETTINGS);
  let obj: Record<string, unknown> = {};
  if (before != null) {
    try {
      obj = JSON.parse(before);
    } catch (e) {
      d.errors.push(`${SETTINGS} 解析失败：${(e as Error).message}`);
      return;
    }
  }
  const summary = mutate(obj);
  if (summary == null) return;
  const text = JSON.stringify(obj, null, 2) + (before == null || before.endsWith('\n') ? '\n' : '');
  if (text !== before) d.set(SETTINGS, text, summary);
  d.note('warn', '本机的会话都是从桌面版启动的，桌面版在界面上按会话选择模型和 effort。settings.json 里的这些设置对命令行启动的会话有效，对桌面版是否生效尚未验证。');
}

function setTop(d: Draft, k: 'model' | 'advisorModel', v: string | null, label: string) {
  settingsEdit(d, (o) => {
    const old = (o[k] as string | undefined) ?? null;
    if (old === v) return null;
    if (v == null) delete o[k];
    else o[k] = v;
    return v == null ? `删除 ${label}（原来是 ${old}）` : old ? `把 ${label} 从 ${old} 改为 ${v}` : `设置 ${label} 为 ${v}`;
  });
  d.note('warn', '检测到 cc-switch：它切换供应商时会覆盖 settings.json 里的 model 和 advisorModel。');
}

function setCompact(d: Draft, v: number | null) {
  if (v != null && (!Number.isInteger(v) || v < 100000 || v > 1000000)) {
    d.errors.push(`自动压缩阈值必须是 100000 到 1000000 之间的整数（token 数），现在是 ${v}。`);
    return;
  }
  settingsEdit(d, (o) => {
    const old = (o.autoCompactWindow as number | undefined) ?? null;
    if (old === v) return null;
    if (v == null) delete o.autoCompactWindow;
    else o.autoCompactWindow = v;
    if (v != null && o.autoCompactEnabled === false) d.note('warn', '设置文件里 autoCompactEnabled 为 false：自动压缩已经关闭，写入的 autoCompactWindow 不会生效。');
    return v == null ? `删除 autoCompactWindow（原来是 ${old}）` : `把 autoCompactWindow 从 ${old ?? '未设置'} 改为 ${v}`;
  });
}

function setEffort(d: Draft, model: string | null, v: string | null) {
  if (v != null && !SETTINGS_EFFORTS.includes(v)) {
    d.errors.push(`settings.json 的 effortLevel 只接受 low、medium、high、xhigh，不接受 ${v}。请改选其他级别。`);
    return;
  }
  settingsEdit(d, (o) => {
    if (model == null) {
      const old = (o.effortLevel as string | undefined) ?? null;
      if (old === v) return null;
      if (v == null) delete o.effortLevel;
      else o.effortLevel = v;
      d.note('info', '顶层的 effortLevel 对 Opus 5.5 及之后的模型不生效，这些模型只看 modelSettings.<模型>.effortLevel。');
      return v == null ? `删除全局 effortLevel（原来是 ${old}）` : `把全局 effortLevel 从 ${old ?? '未设置'} 改为 ${v}`;
    }
    const ms = ((o.modelSettings as Record<string, Record<string, unknown>>) ??= {});
    const entry = (ms[model] ??= {});
    const old = (entry.effortLevel as string | undefined) ?? null;
    if (old === v) return null;
    if (v == null) {
      delete entry.effortLevel;
      if (Object.keys(entry).length === 0) delete ms[model];
    } else entry.effortLevel = v;
    return v == null ? `删除 ${model} 的 effort` : `把 ${model} 的 effort 从 ${old ?? '未设置'} 改为 ${v}`;
  });
}

function rule(d: Draft, enabled: boolean, text: string | null) {
  const before = d.current(CLAUDE_MD);
  const c = before ?? '';
  const starts = c.split(START).length - 1;
  const ends = c.split(END).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) {
    d.errors.push(`${CLAUDE_MD}：规则块的开始和结束标记不配对或出现多次，请手动处理后再试。`);
    return;
  }
  const block = `${START}\n${(text ?? DEFAULT_RULE).replace(/\n+$/, '')}\n${END}`;
  let after: string;
  if (enabled) {
    if (starts === 1) after = c.slice(0, c.indexOf(START)) + block + c.slice(c.indexOf(END) + END.length);
    else after = before == null || c === '' ? block + '\n' : c.replace(/\n*$/, '') + '\n\n' + block + '\n';
  } else {
    if (starts === 0) return;
    const s = c.indexOf(START);
    const e = c.indexOf(END) + END.length;
    const head = c.slice(0, s).replace(/\n\n$/, '\n');
    const tail = c.slice(e).replace(/^\n/, '');
    after = head + tail;
    if (head === '\n' && tail === '') after = '';
  }
  if (after === before) return;
  d.set(CLAUDE_MD, after, enabled ? (starts ? '更新 agentree 规则块的内容' : '在末尾追加 agentree 规则块，原有内容不变') : '删除 agentree 规则块，原有内容不变');
}

function agentUpsert(d: Draft, a: Extract<ConfigAction, { type: 'agent.upsert' }>) {
  if (!NAME_RE.test(a.name) || WIN_RESERVED.test(a.name)) {
    d.errors.push(`名字"${a.name}"不合法：只能用字母、数字、- 和 _，以字母或数字开头，最长 64 个字符，且不能是 Windows 保留名`);
    return;
  }
  if (BUILTIN_TYPES.includes(a.name)) {
    d.errors.push(`${a.name} 是内置类型，内置类型无法通过定义文件修改`);
    return;
  }
  let dir: string;
  if (a.scope === 'user') dir = USER_AGENTS;
  else {
    if (!a.projectCwd || !KNOWN_PROJECTS.some((c) => key(c) === key(a.projectCwd!))) {
      d.errors.push(`项目目录 ${a.projectCwd ?? '（空）'} 不在索引过的会话工作目录里，拒绝写入`);
      return;
    }
    dir = projectAgents(a.projectCwd);
  }
  const target = `${dir}\\${a.name}.md`;
  const srcPath = a.originalName ? `${dir}\\${a.originalName}.md` : target;
  const src = d.current(srcPath);

  if (a.baseHash == null) {
    if (d.current(target) != null) {
      d.errors.push(`同名文件已存在：${target}。请在列表里编辑它，而不是新建。`);
      return;
    }
    const tpl = templateFor(a.name);
    const content = buildAgent(a.name, { ...a.fields, description: a.fields.description || tpl.description }, a.body ?? tpl.body);
    d.set(target, content, `新建 agent 定义 ${a.name}${a.body == null ? '（正文用模板）' : ''}`);
  } else {
    if (src == null) {
      d.errors.push(`文件不存在：${srcPath}`);
      return;
    }
    if (mockHash(src) !== a.baseHash) {
      d.errors.push(`文件在你打开之后被其他程序修改过（hash 不一致）：${srcPath}。请重新加载后再编辑。`);
      d.conflicts.push(realPath(srcPath));
      return;
    }
    const parsed = parseAgent(src, srcPath);
    if ('error' in parsed) {
      d.errors.push(parsed.error);
      return;
    }
    let fm = setKey(parsed.fm, 'name', a.name);
    const changes: string[] = [];
    const old = (k: string) => readValue(parsed.fm, k);
    for (const [k, v] of [
      ['description', a.fields.description || null],
      ['model', a.fields.model],
      ['effort', a.fields.effort],
      ['tools', a.fields.tools],
    ] as const) {
      if ((old(k) ?? null) !== v) {
        fm = setKey(fm, k, v);
        changes.push(v == null ? `删除 ${k}` : old(k) ? `${k} 从 ${old(k)} 改为 ${k === 'description' ? '新描述' : v}` : `设置 ${k} 为 ${v}`);
      }
    }
    const rest = a.body == null ? parsed.rest : `\n${a.body.replace(/\n+$/, '')}\n`;
    if (a.body != null && rest !== parsed.rest) changes.push('修改正文');
    const content = `---\n${fm.join('\n')}\n---\n${rest}`;
    if (a.originalName && a.originalName !== a.name) {
      if (d.current(target) != null) {
        d.errors.push(`改名失败：${target} 已存在`);
        return;
      }
      d.set(target, content, `由 ${a.originalName} 改名为 ${a.name}${changes.length ? '，' + changes.join('，') : ''}`);
      d.set(srcPath, null, `改名后删除旧文件 ${a.originalName}.md（移到备份）`);
    } else if (content !== src) {
      d.set(target, content, changes.join('，') || '调整格式');
    }
  }
  d.note('info', '定义文件修改后几秒内生效；如果 agents 目录是这次新建的，需要重启会话才能识别。');
}

function presetApply(d: Draft, p: Preset, includeRule: boolean, ruleText?: string | null) {
  if (p.main.model) setTop(d, 'model', p.main.model, 'model');
  if (p.main.effort) {
    const m = p.main.model;
    if (m && /^claude-(opus|fable)-(5-[5-9]|[6-9])/.test(m)) setEffort(d, m, p.main.effort);
    else {
      setEffort(d, null, p.main.effort);
      d.note('warn', `主模型${m ? `是 ${m}` : '没有指定'}，effort 只能写到顶层 effortLevel；如果实际用的是 Opus 5.5 及之后的模型，这个设置不会生效。`);
    }
  }
  if (p.advisor.model) setTop(d, 'advisorModel', p.advisor.model, 'advisorModel');
  if (p.main.autoCompactWindow != null) setCompact(d, p.main.autoCompactWindow);
  for (const a of p.agents) {
    if (BUILTIN_TYPES.includes(a.name)) {
      d.note('info', `${a.name} 是内置类型，内置类型无法通过定义文件修改，已跳过。`);
      continue;
    }
    const path = `${USER_AGENTS}\\${a.name}.md`;
    const cur = d.current(path);
    if (cur == null) {
      const tpl = templateFor(a.name);
      const body = a.dispatchModel ? withDispatch(tpl.body, a.dispatchModel) : tpl.body;
      d.set(path, buildAgent(a.name, { description: tpl.description || `${a.name}（请补充描述）`, model: a.model, effort: a.effort, tools: tpl.tools }, body), `新建 agent 定义 ${a.name}（用模板）`);
    } else {
      const parsed = parseAgent(cur, path);
      if ('error' in parsed) {
        d.errors.push(parsed.error);
        continue;
      }
      let fm = parsed.fm;
      const ch: string[] = [];
      if (a.model && readValue(fm, 'model') !== a.model) {
        ch.push(`model 从 ${readValue(fm, 'model') ?? '未设置'} 改为 ${a.model}`);
        fm = setKey(fm, 'model', a.model);
      }
      if (a.effort && readValue(fm, 'effort') !== a.effort) {
        ch.push(`effort 从 ${readValue(fm, 'effort') ?? '未设置'} 改为 ${a.effort}`);
        fm = setKey(fm, 'effort', a.effort);
      }
      const rest = restWithDispatch(parsed.rest, a.dispatchModel);
      if (rest !== parsed.rest) {
        const was = parseDispatch(parsed.rest).model;
        ch.push(a.dispatchModel ? `往下派发的模型从 ${was ?? '未指定'} 改为 ${a.dispatchModel}` : `去掉往下派发的模型 ${was}`);
      }
      if (ch.length) d.set(path, `---\n${fm.join('\n')}\n---\n${rest}`, ch.join('，'));
    }
    d.note('info', '定义文件修改后几秒内生效；如果 agents 目录是这次新建的，需要重启会话才能识别。');
  }
  if (includeRule) {
    // 没给自定义文字时按方案生成；生成的为空（没有子 agent 也没有 advisor）时不写规则块，已有的删掉
    const text = ruleText?.trim() ? ruleText : defaultRuleText(p);
    if (text) rule(d, true, text);
    else rule(d, false, null);
  }
}

function finish(d: Draft): ChangePlan {
  const changes: FileChange[] = [];
  for (const p of d.order) {
    const before = getFile(p)?.content ?? null;
    const after = d.work.get(p) ?? null;
    if (before === after) continue;
    changes.push({
      filePath: p,
      kind: before == null ? 'create' : after == null ? 'delete' : 'modify',
      before,
      after,
      baseHash: before == null ? null : mockHash(before),
      summary: d.summaries.get(p)!.join('；'),
    });
  }
  const now = Date.now();
  const plan: ChangePlan = {
    id: `plan-${now.toString(36)}-${seq++}`,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    // 计划被阻止时仍然列出能算出来的修改，方便用户理解，但不能应用
    changes,
    notes: changes.length || d.errors.length ? d.notes : [],
    blocked: d.errors.length > 0,
    errors: d.errors,
    conflicts: d.conflicts,
  };
  plans.set(plan.id, { plan, used: false });
  return plan;
}

export function makePlan(actions: ConfigAction[], envWarnings: PlanNote[]): ChangePlan {
  const d = new Draft();
  if (!Array.isArray(actions) || actions.length === 0) throw new ApiFailure('http', '后端返回错误：actions 不能为空', 400);
  for (const a of actions) {
    switch (a.type) {
      case 'agent.upsert':
        agentUpsert(d, a);
        break;
      case 'agent.delete': {
        const cur = d.current(a.filePath);
        if (cur == null) d.errors.push(`文件不存在：${a.filePath}`);
        else if (mockHash(cur) !== a.baseHash) {
          d.errors.push(`文件在你打开之后被其他程序修改过（hash 不一致）：${a.filePath}。请重新加载后再删除。`);
          d.conflicts.push(realPath(a.filePath));
        }
        else {
          d.set(a.filePath, null, `删除 agent 定义 ${baseName(a.filePath)}（移到 agentree 备份目录，可以恢复）`);
          d.note('info', '定义文件修改后几秒内生效；如果 agents 目录是这次新建的，需要重启会话才能识别。');
        }
        break;
      }
      case 'settings.mainModel':
        setTop(d, 'model', a.value, 'model');
        break;
      case 'settings.advisorModel':
        setTop(d, 'advisorModel', a.value, 'advisorModel');
        break;
      case 'settings.autoCompactWindow':
        setCompact(d, a.value);
        break;
      case 'settings.effort':
        setEffort(d, a.model, a.value);
        break;
      case 'claudeMd.rule':
        rule(d, a.enabled, a.text);
        break;
      case 'preset.apply':
        presetApply(d, a.preset, a.includeRule, a.ruleText);
        break;
    }
  }
  const touchesSettings = d.order.some((p) => key(p) === key(SETTINGS));
  if (touchesSettings || d.order.some((p) => /\\agents\\/i.test(p))) for (const n of envWarnings) d.note(n.level, n.message);
  return finish(d);
}

export function restorePlan(backupId: string): ChangePlan {
  const b = backups.find((x) => x.entry.id === backupId);
  if (!b) throw new ApiFailure('notfound', `备份 ${backupId} 不存在`, 404);
  const d = new Draft();
  const when = new Date(b.entry.createdAt).toLocaleString('zh-CN');
  d.set(b.entry.filePath, b.entry.existedBefore ? b.content : null, b.entry.existedBefore ? `恢复到 ${when} 的备份` : `这份备份表示当时文件不存在，恢复即删除当前文件（移到备份）`);
  d.note('info', '恢复前会对文件的当前状态再做一次备份，恢复本身也可以撤销。');
  return finish(d);
}

// ---------- 应用 ----------

function backup(path: string, content: string | null, kind: BackupEntry['kind']): string {
  const id = `bk-${Date.now().toString(36)}-${seq++}`;
  backups.push({
    entry: { id, filePath: path, createdAt: new Date().toISOString(), kind, existedBefore: content != null, size: content?.length ?? 0 },
    content,
  });
  return id;
}

export function applyPlan(planId: string): Omit<ApplyResult, 'config'> {
  const rec = plans.get(planId);
  // 与真实后端一致：用过或过期返回 409；blocked 的计划返回 200，失败原因放在 failed 里
  if (!rec) throw new ApiFailure('conflict', '计划不存在或已过期，请重新生成', 409);
  if (rec.used) throw new ApiFailure('conflict', '这个计划已经应用过一次，请重新生成', 409);
  if (Date.now() > new Date(rec.plan.expiresAt).getTime()) throw new ApiFailure('conflict', '计划已过期（10 分钟），请重新生成', 409);
  rec.used = true;
  if (rec.plan.blocked) {
    return {
      planId,
      applied: [],
      failed: rec.plan.changes.map((c) => ({ filePath: c.filePath, code: 'blocked' as const, reason: `计划被阻止，没有写入：${rec.plan.errors.join('；')}` })),
    };
  }

  const applied: ApplyResult['applied'] = [];
  const failed: ApplyResult['failed'] = [];
  let stopped = false;
  for (const c of rec.plan.changes) {
    if (stopped) {
      failed.push({ filePath: c.filePath, code: 'skipped', reason: '前面的文件失败后停止，没有执行' });
      continue;
    }
    const f = getFile(c.filePath);
    const cur = f?.content ?? null;
    if (c.baseHash == null ? cur != null : mockHash(cur) !== c.baseHash) {
      failed.push({ filePath: c.filePath, code: 'conflict', reason: '生成计划之后文件被其他程序修改过（hash 不一致），没有写入。' });
      stopped = true;
      continue;
    }
    if (f?.readonly) {
      failed.push({ filePath: c.filePath, code: 'permission', reason: `EPERM: operation not permitted, open '${c.filePath}'（文件是只读的，请去掉只读属性后重试）` });
      stopped = true;
      continue;
    }
    if (!firstWritten.has(c.filePath)) {
      backup(c.filePath, cur, 'first-write');
      firstWritten.add(c.filePath);
    }
    const backupId = cur != null ? backup(c.filePath, cur, 'pre-change') : null;
    if (c.after == null) files.delete(realPath(c.filePath));
    else if (f) f.content = c.after;
    else files.set(c.filePath, { content: c.after });
    applied.push({ filePath: c.filePath, kind: c.kind, backupId, backupPath: backupId ? `C:\\Users\\you\\.agentree\\backups\\${backupId}.bak` : null });
  }
  return { planId, applied, failed };
}

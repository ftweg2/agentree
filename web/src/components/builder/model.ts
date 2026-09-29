import type { EffectItem, EffectReport, Preset, PresetAgent } from '../../types';
import type { Pt } from '../canvas/useCanvasView';

/**
 * 搭建页的数据模型。
 *
 * 所有连线都连着主会话：
 *   advisor ──▶ 主会话 ──▶ 子 agent
 *   规则    ──▶
 * 连到主会话的节点属于方案；没连上的节点只是草稿，画成虚线。
 */

export type Kind = 'main' | 'advisor' | 'rule' | 'agent';

export interface BNode {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  name: string;
  model: string | null;
  effort: string | null;
  /** 什么时候该把任务交给它 */
  description: string;
  /** 工具白名单；null 表示继承全部工具 */
  tools: string | null;
  /** 工具黑名单 */
  disallowedTools: string | null;
  /** 系统提示词 */
  prompt: string;
}

export interface Graph {
  nodes: BNode[];
  /** 连到主会话的节点 id */
  linked: string[];
  allowBuiltins: boolean;
  /** CLAUDE.md 规则的文案；null 表示用默认文案（已有规则块时保持原样） */
  ruleText: string | null;
  /** 项目方案的画布上有一个"全局方案"节点，这是它的位置 */
  globalPos?: Pt;
}

export const BW = 292;
export const HEAD = 34;
const PORT_TOP = 4;
const PORT_H = 26;
/** 第 i 行接口的圆心相对节点顶部的高度 */
export const portY = (i: number) => HEAD + PORT_TOP + PORT_H * i + PORT_H / 2;

/** 各类节点的大致高度，只用于自动排列和适应窗口 */
export const NODE_H: Record<Kind, number> = {
  main: 240,
  advisor: 162,
  rule: 134,
  agent: 310,
};

export const KIND_LABEL: Record<Kind, string> = {
  main: '主会话',
  advisor: 'advisor',
  rule: 'CLAUDE.md 规则',
  agent: '子 agent',
};
export const KIND_COLOR: Record<Kind, string> = {
  main: 'var(--accent)',
  advisor: 'var(--c-advisor)',
  rule: 'var(--c-rule)',
  agent: 'var(--c-agent)',
};
export const BUILTIN = ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'claude', 'output-style-setup'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const STORE_KEY = 'agentree.builder.v2';
const OLD_STORE_KEY = 'agentree.builder.v1';
/** 每个范围各存各的：全局方案一份，每个项目方案一份 */
const storeKey = (cwd: string | null) => (cwd ? `${STORE_KEY}:${cwd.replace(/\\/g, '/').toLowerCase()}` : STORE_KEY);

let seq = 1;
export const newId = () => `n${Date.now().toString(36)}${seq++}`;

export const isBuiltin = (name: string) => BUILTIN.some((b) => b.toLowerCase() === name.trim().toLowerCase());

export function blankNode(kind: Kind, init?: Partial<BNode>): BNode {
  return {
    id: kind === 'main' ? 'main' : newId(),
    kind,
    x: 0,
    y: 0,
    name: '',
    model: null,
    effort: null,
    description: '',
    tools: null,
    disallowedTools: null,
    prompt: '',
    ...init,
  };
}

/**
 * 存在本机的内容，和预设本身分开：
 *   draft  画布上的整张图。还没应用、没保存的修改也在里面，刷新或重启后接着改
 *   其余   节点位置、草稿节点、规则，用在"撤销修改"时按保存的预设重新建图
 */
export interface Stored {
  pos: Record<string, Pt>;
  loose: BNode[];
  rule: boolean;
  ruleText: string | null;
  draft: Graph | null;
}

const KINDS: Kind[] = ['main', 'advisor', 'rule', 'agent'];

function readNode(raw: unknown): BNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<BNode> & { note?: string };
  if (!n.kind || !KINDS.includes(n.kind)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return blankNode(n.kind, {
    ...(n.kind !== 'main' && typeof n.id === 'string' && n.id ? { id: n.id } : {}),
    x: Number.isFinite(n.x) ? Math.round(n.x as number) : 0,
    y: Number.isFinite(n.y) ? Math.round(n.y as number) : 0,
    name: str(n.name),
    model: opt(n.model),
    effort: opt(n.effort),
    description: str(n.description) || str(n.note),
    tools: opt(n.tools),
    disallowedTools: opt(n.disallowedTools),
    prompt: str(n.prompt),
  });
}

/** 存下来的图可能来自旧版本或者被改坏了，不合规矩的部分丢掉；整张图不能用时返回 null */
function readDraft(raw: unknown): Graph | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<Graph>;
  if (!Array.isArray(g.nodes)) return null;
  const nodes: BNode[] = [];
  const ids = new Set<string>();
  for (const r of g.nodes) {
    const n = readNode(r);
    if (!n || ids.has(n.id)) continue;
    // 主会话、advisor、规则各只能有一个
    if (n.kind !== 'agent' && nodes.some((x) => x.kind === n.kind)) continue;
    ids.add(n.id);
    nodes.push(n);
  }
  if (!nodes.some((n) => n.kind === 'main')) return null;
  return {
    nodes,
    linked: Array.isArray(g.linked) ? [...new Set(g.linked.filter((id): id is string => typeof id === 'string' && ids.has(id) && id !== 'main'))] : [],
    allowBuiltins: g.allowBuiltins !== false,
    ruleText: typeof g.ruleText === 'string' ? g.ruleText : null,
    ...(g.globalPos && Number.isFinite(g.globalPos.x) && Number.isFinite(g.globalPos.y) ? { globalPos: { x: Math.round(g.globalPos.x), y: Math.round(g.globalPos.y) } } : {}),
  };
}

export function loadStored(cwd: string | null = null): Stored {
  const empty: Stored = {
    pos: {},
    loose: [],
    rule: false,
    ruleText: null,
    draft: null,
  };
  try {
    const raw = localStorage.getItem(storeKey(cwd)) ?? (cwd ? null : localStorage.getItem(OLD_STORE_KEY));
    if (!raw) return empty;
    const s = JSON.parse(raw) as Partial<Stored>;
    return {
      pos: s.pos ?? {},
      loose: Array.isArray(s.loose) ? s.loose.map(readNode).filter((n): n is BNode => !!n && n.kind !== 'main') : [],
      rule: !!s.rule,
      ruleText: typeof s.ruleText === 'string' ? s.ruleText : null,
      draft: readDraft(s.draft),
    };
  } catch {
    return empty;
  }
}

export function clearStored(cwd: string | null = null) {
  try {
    localStorage.removeItem(storeKey(cwd));
    if (!cwd) localStorage.removeItem(OLD_STORE_KEY);
  } catch {
    /* 忽略 */
  }
}

export function saveStored(g: Graph, cwd: string | null = null) {
  const linked = new Set(g.linked);
  const s: Stored = {
    pos: {},
    loose: [],
    rule: g.nodes.some((n) => n.kind === 'rule' && linked.has(n.id)),
    ruleText: g.ruleText,
    draft: g,
  };
  for (const n of g.nodes) {
    if (n.kind === 'main' || linked.has(n.id)) s.pos[keyOf(n)] = { x: n.x, y: n.y };
    else s.loose.push(n);
  }
  try {
    localStorage.setItem(storeKey(cwd), JSON.stringify(s));
    if (!cwd) localStorage.removeItem(OLD_STORE_KEY);
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

export const keyOf = (n: BNode) => (n.kind === 'agent' ? `agent:${n.name.trim()}` : n.kind);

export function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

/** "全局方案"节点的宽度和大致高度 */
export const GLOBAL_W = 292;
export const globalHeight = (agents: number) => 150 + (Math.max(1, agents) + 1) * 30;

/** "全局方案"节点自动排列时的位置：左边一列，排在 advisor 和规则下面 */
export function globalHome(nodes: BNode[], linked: Set<string>): Pt {
  const agents = nodes.filter((n) => n.kind === 'agent' && linked.has(n.id)).length;
  const colH = Math.max(1, agents) * (NODE_H.agent + 26) - 26;
  const mainY = Math.round(Math.max(0, colH / 2 - NODE_H.main / 2));
  return { x: 0, y: mainY - 70 + NODE_H.advisor + 26 + NODE_H.rule + 26 };
}

/** 自动排列：输入在左，主会话居中，子 agent 在右边排成一列，草稿放在最下面 */
export function arrange(nodes: BNode[], linked: Set<string>): BNode[] {
  const agents = nodes.filter((n) => n.kind === 'agent' && linked.has(n.id));
  const loose = nodes.filter((n) => n.kind !== 'main' && !linked.has(n.id));
  const GAP = 26;
  const step = NODE_H.agent + GAP;
  const colH = Math.max(1, agents.length) * step - GAP;
  const mainY = Math.round(Math.max(0, colH / 2 - NODE_H.main / 2));
  const out = new Map<string, Pt>();
  for (const n of nodes) {
    if (n.kind === 'main') out.set(n.id, { x: 410, y: mainY });
    else if (n.kind === 'advisor' && linked.has(n.id)) out.set(n.id, { x: 0, y: mainY - 70 });
    else if (n.kind === 'rule' && linked.has(n.id)) out.set(n.id, { x: 0, y: mainY + NODE_H.advisor - 70 + GAP });
  }
  agents.forEach((n, i) => out.set(n.id, { x: 820, y: i * step }));
  const looseY = Math.max(colH, mainY + NODE_H.main, mainY + NODE_H.advisor + NODE_H.rule) + 70;
  loose.forEach((n, i) => out.set(n.id, { x: i * (BW + 28), y: looseY }));
  return nodes.map((n) => ({ ...n, ...(out.get(n.id) ?? { x: n.x, y: n.y }) }));
}

/**
 * 预设 -> 图。
 * disk 是磁盘上现有的定义（从"当前配置"读出来的）：预设里没有记录的字段用磁盘上的值补上，
 * 这样旧预设（只有名字、模型、effort）打开后也能看到完整的内容。
 */
export function graphFromPreset(p: Preset, stored: Omit<Stored, 'draft'>, disk: PresetAgent[] = []): Graph {
  const nodes: BNode[] = [];
  const linked: string[] = [];
  nodes.push(
    blankNode('main', {
      model: p.main?.model ?? null,
      effort: p.main?.effort ?? null,
    }),
  );
  if (p.advisor?.model) {
    const n = blankNode('advisor', { model: p.advisor.model });
    nodes.push(n);
    linked.push(n.id);
  }
  if (stored.rule) {
    const n = blankNode('rule');
    nodes.push(n);
    linked.push(n.id);
  }
  const onDisk = new Map(disk.map((a) => [a.name, a]));
  for (const a of p.agents ?? []) {
    const d = onDisk.get(a.name);
    const n = blankNode('agent', {
      name: a.name,
      model: a.model ?? null,
      effort: a.effort ?? null,
      description: a.description ?? a.note ?? d?.description ?? '',
      tools: a.tools !== undefined ? a.tools : (d?.tools ?? null),
      disallowedTools: a.disallowedTools !== undefined ? a.disallowedTools : (d?.disallowedTools ?? null),
      prompt: a.prompt ?? d?.prompt ?? '',
    });
    nodes.push(n);
    linked.push(n.id);
  }
  // 没连上的草稿节点：同类的单例节点（advisor、规则）已经存在时不重复加
  for (const l of stored.loose) {
    if (l.kind === 'main') continue;
    if ((l.kind === 'advisor' || l.kind === 'rule') && nodes.some((n) => n.kind === l.kind)) continue;
    if (l.kind === 'agent' && l.name.trim() && nodes.some((n) => n.kind === 'agent' && n.name.trim() === l.name.trim())) continue;
    nodes.push({ ...l, id: newId() });
  }
  const arranged = arrange(nodes, new Set(linked));
  return {
    nodes: arranged.map((n) => ({ ...n, ...(stored.pos[keyOf(n)] ?? {}) })),
    linked,
    allowBuiltins: p.allowBuiltins ?? true,
    ruleText: stored.ruleText,
  };
}

function agentFromNode(n: BNode): PresetAgent {
  const name = n.name.trim();
  const a: PresetAgent = {
    name,
    model: clean(n.model),
    effort: clean(n.effort),
  };
  // 内置类型没有定义文件，只用来检查
  if (isBuiltin(name)) return a;
  const d = n.description.trim();
  if (d) a.description = d;
  a.tools = normalizeTools(n.tools);
  a.disallowedTools = normalizeTools(n.disallowedTools);
  a.prompt = normalizePrompt(n.prompt);
  return a;
}

/** 图 -> 预设。skipInvalid 为 true 时跳过名字不合法的节点（用于生效检查，后端不接受空名字） */
export function presetFromGraph(g: Graph, updatedAt: string | null, skipInvalid = false): Preset {
  const linked = new Set(g.linked);
  const main = g.nodes.find((n) => n.kind === 'main')!;
  const advisor = g.nodes.find((n) => n.kind === 'advisor' && linked.has(n.id));
  const seen = new Set<string>();
  const agents: PresetAgent[] = [];
  for (const n of g.nodes) {
    if (n.kind !== 'agent' || !linked.has(n.id)) continue;
    const name = n.name.trim();
    if (skipInvalid && (nameError(name) || seen.has(name))) continue;
    seen.add(name);
    agents.push(agentFromNode(n));
  }
  return {
    version: 1,
    main: { model: clean(main.model), effort: clean(main.effort) },
    advisor: { model: advisor ? clean(advisor.model) : null },
    agents,
    allowBuiltins: g.allowBuiltins,
    updatedAt,
  };
}

export function comparable(p: Preset) {
  return JSON.stringify({
    main: { model: clean(p.main?.model), effort: clean(p.main?.effort) },
    advisor: { model: clean(p.advisor?.model) },
    agents: (p.agents ?? [])
      .map((a) => ({
        name: a.name,
        model: clean(a.model),
        effort: clean(a.effort),
        description: clean(a.description ?? a.note),
        tools: a.tools === undefined ? undefined : normalizeTools(a.tools),
        disallowedTools: a.disallowedTools === undefined ? undefined : normalizeTools(a.disallowedTools),
        prompt: a.prompt === undefined ? undefined : normalizePrompt(a.prompt),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allowBuiltins: p.allowBuiltins,
  });
}

export function nameError(name: string): string | null {
  if (!name) return '还没有填名字';
  if (!NAME_RE.test(name)) return '名字只能用字母、数字、下划线和连字符，且以字母或数字开头';
  if (WIN_RESERVED.test(name)) return `${name} 是 Windows 保留名，不能用作文件名`;
  return null;
}

export interface NodeIssue {
  /** error 会阻止保存和应用；warn 只是提醒 */
  level: 'error' | 'warn';
  field: 'name' | 'description' | 'prompt' | 'model';
  text: string;
}

export function validate(g: Graph): Map<string, NodeIssue[]> {
  const out = new Map<string, NodeIssue[]>();
  const seen = new Set<string>();
  for (const n of g.nodes) {
    const issues: NodeIssue[] = [];
    if (n.kind === 'agent') {
      const name = n.name.trim();
      const ne = nameError(name);
      if (ne) issues.push({ level: 'error', field: 'name', text: ne });
      else if (seen.has(name))
        issues.push({
          level: 'error',
          field: 'name',
          text: `名字重复：${name}`,
        });
      else seen.add(name);
      if (!isBuiltin(name)) {
        if (!n.description.trim())
          issues.push({
            level: 'error',
            field: 'description',
            text: '还没写什么时候用它。主会话靠这段话决定要不要把任务交给它',
          });
        if (!n.prompt.trim())
          issues.push({
            level: 'warn',
            field: 'prompt',
            text: '还没写系统提示词，它不知道该怎么干活',
          });
      }
    }
    if (n.kind === 'advisor' && !clean(n.model))
      issues.push({
        level: 'error',
        field: 'model',
        text: '还没选 advisor 用哪个模型',
      });
    if (issues.length) out.set(n.id, issues);
  }
  return out;
}

// ───────── 工具 ─────────

export function splitTools(v: string | null | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  // 括号里可能有逗号，如 Agent(a, b)，不能直接按逗号拆
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return [...new Set(out)];
}

export function normalizeTools(v: string | null | undefined): string | null {
  const list = splitTools(v);
  return list.length ? list.join(', ') : null;
}

export function normalizePrompt(v: string): string {
  const t = v.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return t ? `${t}\n` : '';
}

export interface ToolGroup {
  id: string;
  label: string;
  tools: { name: string; label: string }[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'read',
    label: '读',
    tools: [
      { name: 'Read', label: '读文件' },
      { name: 'Grep', label: '搜内容' },
      { name: 'Glob', label: '找文件' },
    ],
  },
  {
    id: 'write',
    label: '改',
    tools: [
      { name: 'Edit', label: '修改文件' },
      { name: 'Write', label: '新建文件' },
      { name: 'NotebookEdit', label: '改笔记本' },
    ],
  },
  {
    id: 'run',
    label: '执行',
    tools: [
      { name: 'Bash', label: 'Bash 命令' },
      { name: 'PowerShell', label: 'PowerShell 命令' },
    ],
  },
  {
    id: 'web',
    label: '联网',
    tools: [
      { name: 'WebFetch', label: '打开网页' },
      { name: 'WebSearch', label: '搜索' },
    ],
  },
  {
    id: 'other',
    label: '其他',
    tools: [
      { name: 'Skill', label: '调用 skill' },
      { name: 'TodoWrite', label: '任务清单' },
    ],
  },
];

const KNOWN_TOOLS = new Set(TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name)));
const isAgentTool = (t: string) => /^(Agent|Task)(\(.*\))?$/.test(t);

export interface ToolPreset {
  id: 'all' | 'read' | 'read-web' | 'custom';
  label: string;
  hint: string;
  tools: string[] | null;
}

export const TOOL_PRESETS: ToolPreset[] = [
  {
    id: 'all',
    label: '全部',
    hint: '和主会话一样，什么工具都能用',
    tools: null,
  },
  {
    id: 'read',
    label: '只读',
    hint: '只能查找和阅读，改不了任何东西',
    tools: ['Read', 'Grep', 'Glob'],
  },
  {
    id: 'read-web',
    label: '只读 + 联网',
    hint: '能读代码，也能查网上的资料',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
  { id: 'custom', label: '自己选', hint: '逐个勾选', tools: [] },
];

/** 当前的工具设置对应哪个预置；派发工具（Agent）不参与比较 */
export function toolPresetOf(tools: string | null): ToolPreset['id'] {
  if (tools === null) return 'all';
  const list = splitTools(tools)
    .filter((t) => !isAgentTool(t))
    .sort();
  for (const p of TOOL_PRESETS) {
    if (!p.tools || p.id === 'custom') continue;
    const want = [...p.tools].sort();
    if (want.length === list.length && want.every((t, i) => t === list[i])) return p.id;
  }
  return 'custom';
}

/** 白名单里不在勾选清单上的项，如 MCP 工具 */
export function extraTools(tools: string | null): string[] {
  return splitTools(tools).filter((t) => !KNOWN_TOOLS.has(t) && !isAgentTool(t));
}

/** 这个 agent 能不能再往下派发子 agent */
export function canSpawn(n: Pick<BNode, 'tools' | 'disallowedTools'>): boolean {
  if (splitTools(n.disallowedTools).some(isAgentTool)) return false;
  if (n.tools === null) return true;
  return splitTools(n.tools).some(isAgentTool);
}

export function setSpawn(n: Pick<BNode, 'tools' | 'disallowedTools'>, allow: boolean): Pick<BNode, 'tools' | 'disallowedTools'> {
  const dis = splitTools(n.disallowedTools).filter((t) => !isAgentTool(t));
  if (n.tools === null) {
    // 继承全部工具时，靠黑名单去掉派发能力
    if (!allow) dis.push('Agent');
    return { tools: null, disallowedTools: dis.length ? dis.join(', ') : null };
  }
  const list = splitTools(n.tools).filter((t) => !isAgentTool(t));
  if (allow) list.push('Agent');
  // 白名单为空会让 agent 无法启动，至少留一个 Read
  return {
    tools: (list.length ? list : ['Read']).join(', '),
    disallowedTools: dis.length ? dis.join(', ') : null,
  };
}

/** 换一组工具，保持"能不能再派发"不变 */
export function withTools(n: Pick<BNode, 'tools' | 'disallowedTools'>, tools: string[] | null): Pick<BNode, 'tools' | 'disallowedTools'> {
  const spawn = canSpawn(n);
  const base = {
    tools: tools === null ? null : tools.join(', ') || 'Read',
    disallowedTools: n.disallowedTools,
  };
  return setSpawn(base, spawn);
}

/** 节点上显示的一句话 */
export function toolSummary(n: Pick<BNode, 'tools' | 'disallowedTools'>): string {
  const id = toolPresetOf(n.tools);
  if (id === 'all') return '全部工具';
  const count = splitTools(n.tools).filter((t) => !isAgentTool(t)).length;
  if (id === 'custom') return `自己选的 ${count} 个`;
  return TOOL_PRESETS.find((p) => p.id === id)!.label;
}

export function promptSummary(prompt: string): string | null {
  const t = prompt.trim();
  if (!t) return null;
  const lines = t.split(/\r?\n/).filter((l) => l.trim()).length;
  return `${lines} 行 · ${t.length} 字`;
}

export const PROMPT_SKELETON = `你是……，负责……。

## 工作方式
-
-

## 汇报
你看不到主会话之前的对话，主会话也只会收到你最后的汇报。所以汇报要能独立看懂：
- 先直接给出结论
-
`;

// ───────── 生效状态 ─────────

/**
 * 节点上显示的状态。按"离生效还差几步"排：
 *   draft    没连到主会话，不属于方案
 *   invalid  还没填完
 *   pending  还没写入 Claude Code，或者写入的内容和画布不一样
 *   manual   写配置文件对这一项没用（桌面版的主模型和 effort），要用户自己在桌面版里选
 *   written  已写入，之后还没有会话加载它
 *   loaded   已写入，新会话已经加载了它，但还没被派发过
 *   live     实际运行里出现过并且符合
 *   off      实际运行不符合
 *   none     没有需要显示的状态
 */
export type NodeState = 'draft' | 'invalid' | 'pending' | 'manual' | 'written' | 'loaded' | 'live' | 'off' | 'none';

export const STATE_LABEL: Record<NodeState, string> = {
  draft: '未连接',
  invalid: '没填完',
  pending: '未写入',
  manual: '需手动选',
  written: '已写入',
  loaded: '已加载',
  live: '已生效',
  off: '不符合',
  none: '',
};

/** 这一项现在应用的话会不会改动文件 */
export const needsWrite = (it: EffectItem) => it.written.state === 'no' || it.written.state === 'differs' || it.written.state === 'extra';

export function itemState(it: EffectItem): NodeState {
  const effective = it.writeEffective !== false;
  if (effective && needsWrite(it)) return 'pending';
  if (it.observed.state === 'mismatch') return 'off';
  if (it.observed.state === 'match') return 'live';
  if (!effective) return it.expected ? 'manual' : 'none';
  if (it.written.state === 'yes') return it.loaded?.state === 'yes' ? 'loaded' : 'written';
  return 'none';
}

const RANK: NodeState[] = ['none', 'live', 'loaded', 'written', 'manual', 'off', 'pending', 'invalid', 'draft'];
export const worst = (states: NodeState[]): NodeState => states.reduce<NodeState>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), 'none');

export function itemsOf(n: BNode, report: EffectReport | null): EffectItem[] {
  if (!report) return [];
  if (n.kind === 'main') return report.items.filter((i) => i.kind === 'main-model' || i.kind === 'main-effort');
  if (n.kind === 'advisor') return report.items.filter((i) => i.kind === 'advisor');
  if (n.kind === 'rule') return report.items.filter((i) => i.kind === 'rule');
  return report.items.filter((i) => i.kind === 'agent' && i.name === n.name.trim());
}

export function nodeState(n: BNode, isLinked: boolean, issues: NodeIssue[] | undefined, report: EffectReport | null): NodeState {
  if (!isLinked) return 'draft';
  if (issues?.some((i) => i.level === 'error')) return 'invalid';
  return worst(itemsOf(n, report).map(itemState));
}

/** 方案里还没写入的项数（只算写了有用的） */
export function pendingCount(report: EffectReport | null): number {
  if (!report) return 0;
  return report.items.filter((i) => itemState(i) === 'pending').length;
}

/** 现在应用的话会改动的项数 */
export function writableCount(report: EffectReport | null): number {
  if (!report) return 0;
  return report.items.filter(needsWrite).length;
}

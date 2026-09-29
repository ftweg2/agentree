// 读取 Claude Code 配置（只读）：agent 定义文件、settings.json、环境变量。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition, CheckLevel, ClaudeConfigSnapshot, EnvCheck, Preset, PresetAgent } from '../../shared/types.ts';
import { BUILTIN_AGENT_TYPES, claudeConfigDirs } from './config.ts';
import { parseAgentDoc, type AgentDoc } from './config/frontmatter.ts';
import { readTextFile } from './config/text.ts';

// ---------------- frontmatter ----------------

/** 解析 markdown 顶部的 YAML frontmatter（只取顶层标量字段） */
export function parseFrontmatter(text: string): Record<string, string> {
  const t = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(t);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      // 多行块：收集后续缩进行
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value.startsWith('>') ? ' ' : '\n');
    } else if (value === '') {
      // 可能是列表
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, '').trim());
      if (items.length) value = items.join(', ');
    } else if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .join(', ');
    }
    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    out[key] = value;
  }
  return out;
}

async function readDefinitions(dir: string, source: 'user' | 'project', projectCwd: string | null): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const filePath = path.join(dir, e.name);
    try {
      const raw = (await fs.readFile(filePath, 'utf8')).replace(/^﻿/, '');
      let fm: Record<string, string>;
      try {
        // 与写入用同一个解析器（支持多行 description、YAML 列表等）
        const doc = parseAgentDoc(raw);
        fm = {};
        for (const f of doc.fields) if (f.value !== null) fm[f.key] = f.value;
      } catch {
        fm = parseFrontmatter(raw);
      }
      const s = (k: string) => (fm[k] && fm[k].trim() ? fm[k].trim() : null);
      out.push({
        name: s('name') ?? e.name.replace(/\.md$/i, ''),
        source,
        filePath,
        description: s('description'),
        model: s('model'),
        effort: s('effort'),
        tools: s('tools'),
        projectCwd,
      });
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out;
}

// ---------------- settings.json ----------------

export async function readSettings(configDir: string): Promise<Record<string, any>> {
  return readJsonObject(path.join(configDir, 'settings.json'));
}

/** 读一个 JSON 对象文件；不存在、解析失败或根不是对象时返回 {} */
async function readJsonObject(file: string): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const o = JSON.parse(raw.replace(/^﻿/, ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** modelSettings.<model>.effortLevel 的映射 */
function modelEffortOf(settings: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  if (settings.modelSettings && typeof settings.modelSettings === 'object') {
    for (const [m, v] of Object.entries(settings.modelSettings as Record<string, any>)) {
      const e = v && typeof v === 'object' ? strOrNull((v as any).effortLevel) : null;
      if (e) out[m] = e;
    }
  }
  return out;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ---------------- 环境变量 ----------------

const ENV_VARS: Array<{ name: string; impact: string; setLevel: CheckLevel }> = [
  { name: 'CLAUDE_CODE_EFFORT_LEVEL', impact: '覆盖所有 effort 设置，包括子 agent 配置文件里的 effort', setLevel: 'warn' },
  { name: 'CLAUDE_CODE_SUBAGENT_MODEL', impact: '子 agent 没有指定模型时使用的默认模型', setLevel: 'info' },
  { name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', impact: '强制所有子 agent 使用同一个模型，配置文件里的 model 不再生效', setLevel: 'warn' },
  { name: 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', impact: '禁用 advisor，配置了 advisor 也不会被调用', setLevel: 'warn' },
  { name: 'DISABLE_TELEMETRY', impact: '会导致功能开关无法拉取，advisor 可能不可用', setLevel: 'warn' },
  { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', impact: '会导致功能开关无法拉取，advisor 可能不可用', setLevel: 'warn' },
  { name: 'CLAUDE_CONFIG_DIR', impact: '改变了 Claude Code 配置目录的位置', setLevel: 'info' },
  { name: 'ANTHROPIC_BASE_URL', impact: '请求走了代理或第三方服务，advisor 可能不可用', setLevel: 'warn' },
];

/** 值超过 12 个字符时只返回前 4 位加省略号 */
export function maskValue(v: string): string {
  return v.length > 12 ? `${v.slice(0, 4)}…` : v;
}

function regQuery(key: string): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Map());
    execFile('reg', ['query', key], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      const map = new Map<string, string>();
      if (err || !stdout) return resolve(map);
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s{2,}(\S+)\s+(REG_\w+)\s*(.*)$/.exec(line);
        if (m) map.set(m[1].toUpperCase(), m[3].trim());
      }
      resolve(map);
    });
  });
}

let regCache: { at: number; user: Map<string, string>; machine: Map<string, string> } | null = null;
async function registryEnv() {
  if (regCache && Date.now() - regCache.at < 10_000) return regCache;
  const [user, machine] = await Promise.all([
    regQuery('HKCU\\Environment'),
    regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
  ]);
  regCache = { at: Date.now(), user, machine };
  return regCache;
}

export async function envChecks(settingsEnv: Record<string, unknown>): Promise<{ checks: EnvCheck[]; rawBaseUrls: string[] }> {
  const reg = await registryEnv();
  const checks: EnvCheck[] = [];
  const rawBaseUrls: string[] = [];
  const settingsUpper = new Map<string, string>();
  for (const [k, v] of Object.entries(settingsEnv ?? {})) {
    if (v !== null && v !== undefined) settingsUpper.set(k.toUpperCase(), String(v));
  }
  // 非 Windows 没有注册表，用进程环境变量代替用户级
  const userSource = process.platform === 'win32' ? reg.user : new Map(Object.entries(process.env).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  for (const v of ENV_VARS) {
    const found: EnvCheck[] = [];
    const sources: Array<[EnvCheck['scope'], Map<string, string>]> = [
      ['user', userSource],
      ['machine', reg.machine],
      ['settings', settingsUpper],
    ];
    for (const [scope, map] of sources) {
      const val = map.get(v.name);
      if (val === undefined || val === '') continue;
      if (v.name === 'ANTHROPIC_BASE_URL') rawBaseUrls.push(val);
      found.push({ name: v.name, value: maskValue(val), scope, level: v.setLevel, impact: v.impact });
    }
    if (found.length) checks.push(...found);
    else checks.push({ name: v.name, value: null, scope: 'user', level: 'ok', impact: `未设置。${v.impact}` });
  }
  return { checks, rawBaseUrls };
}

// ---------------- 汇总 ----------------

export async function configSnapshot(projectCwds: string[]): Promise<ClaudeConfigSnapshot> {
  const configDir = claudeConfigDirs()[0];
  const settings = await readSettings(configDir);
  const definitions: AgentDefinition[] = [];
  for (const dir of claudeConfigDirs()) definitions.push(...(await readDefinitions(path.join(dir, 'agents'), 'user', null)));
  const cwds = [...new Set(projectCwds.filter(Boolean))];
  for (const cwd of cwds) {
    definitions.push(...(await readDefinitions(path.join(cwd, '.claude', 'agents'), 'project', cwd)));
  }
  const modelEffort = modelEffortOf(settings);
  const envObj = settings.env && typeof settings.env === 'object' ? (settings.env as Record<string, unknown>) : {};
  const { checks, rawBaseUrls } = await envChecks(envObj);
  const ccSwitchDetected =
    existsSync(path.join(os.homedir(), '.cc-switch', 'live-state.json')) ||
    rawBaseUrls.some((u) => /(127\.0\.0\.1|localhost):15721/i.test(u));
  return {
    configDir,
    definitions,
    settings: {
      effortLevel: strOrNull(settings.effortLevel),
      model: strOrNull(settings.model),
      advisorModel: strOrNull(settings.advisorModel),
      modelEffort,
    },
    env: checks,
    builtinAgentTypes: [...BUILTIN_AGENT_TYPES],
    ccSwitchDetected,
    projectCwds: cwds,
  };
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 读一个定义文件并解析 frontmatter；读不了或格式异常返回 null（这时不知道正文和 disallowedTools，预设里不写这两项） */
function readAgentDoc(filePath: string): AgentDoc | null {
  try {
    const t = readTextFile(filePath);
    if (!t.exists || t.text === null) return null;
    return parseAgentDoc(t.text, t.bom);
  } catch {
    return null;
  }
}

/** settings.json 没有主模型 / effort / advisor 时的兜底来源 */
export interface PresetFallback {
  /** 桌面版会话元数据里最近活跃会话的 model / effort */
  model: string | null;
  effort: string | null;
  /** 最近活跃会话日志记录上的 advisorModel */
  advisorModel: string | null;
}

/**
 * 根据配置生成预设（不保存）。agents 只取用户级定义：preset.apply 只写用户级文件，
 * 合并项目级会让"从配置生成 -> 应用"把项目级 agent 复制成用户级文件。
 * 桌面版不把模型和 effort 写进 settings.json，所以 settings 里没有时用 fallback 兜底。
 */
export function presetFromConfig(snap: ClaudeConfigSnapshot, fallback: PresetFallback | null = null): Preset {
  const validEffort = (e: string | null | undefined) => (e && EFFORTS.includes(e.toLowerCase()) ? e.toLowerCase() : null);
  const mainModel = snap.settings.model ?? fallback?.model ?? null;
  let mainEffort = validEffort(snap.settings.effortLevel);
  if (mainModel && snap.settings.modelEffort[mainModel]) mainEffort = validEffort(snap.settings.modelEffort[mainModel]) ?? mainEffort;
  if (!mainEffort) mainEffort = validEffort(fallback?.effort);
  return {
    version: 1,
    main: { model: mainModel, effort: mainEffort },
    advisor: { model: snap.settings.advisorModel ?? fallback?.advisorModel ?? null },
    agents: presetAgentsFrom(snap.definitions.filter((x) => x.source === 'user')),
    allowBuiltins: true,
    updatedAt: null,
  };
}

/**
 * 根据一个项目自己的配置生成项目方案（不保存）：只读 <项目>/.claude/agents 下的定义和
 * <项目>/.claude/settings.local.json 里的 model / effort / advisorModel，不包含全局的，也不用桌面版兜底
 */
export async function presetFromProject(projectCwd: string): Promise<Preset> {
  const settings = await readJsonObject(path.join(projectCwd, '.claude', 'settings.local.json'));
  const validEffort = (e: unknown) => (typeof e === 'string' && EFFORTS.includes(e.trim().toLowerCase()) ? e.trim().toLowerCase() : null);
  const mainModel = strOrNull(settings.model);
  const modelEffort = modelEffortOf(settings);
  const mainEffort = (mainModel ? validEffort(modelEffort[mainModel]) : null) ?? validEffort(settings.effortLevel);
  const defs = await readDefinitions(path.join(projectCwd, '.claude', 'agents'), 'project', projectCwd);
  return {
    version: 1,
    main: { model: mainModel, effort: mainEffort },
    advisor: { model: strOrNull(settings.advisorModel) },
    agents: presetAgentsFrom(defs),
    allowBuiltins: true,
    updatedAt: null,
  };
}

/** 定义文件 -> 预设里的 agent（同名时后面的覆盖前面的） */
function presetAgentsFrom(definitions: AgentDefinition[]): PresetAgent[] {
  const byName = new Map<string, PresetAgent>();
  for (const d of definitions) {
    const model = d.model && d.model.toLowerCase() !== 'inherit' ? d.model : null;
    const effort = d.effort && EFFORTS.includes(d.effort.toLowerCase()) ? d.effort.toLowerCase() : null;
    const pa: PresetAgent = { name: d.name, model, effort };
    if (d.model && d.model.toLowerCase() === 'inherit') pa.note = '配置文件里 model 为 inherit（继承主会话模型）';
    // 定义文件的内容：描述、工具、正文。没有 tools / disallowedTools 字段记为 null（继承全部工具 / 不禁用）
    if (d.description) pa.description = d.description;
    pa.tools = d.tools;
    const doc = readAgentDoc(d.filePath);
    if (doc) {
      pa.disallowedTools = doc.fields.find((f) => f.key === 'disallowedTools')?.value?.trim() || null;
      pa.prompt = doc.body;
    }
    byName.set(d.name, pa);
  }
  return [...byName.values()];
}

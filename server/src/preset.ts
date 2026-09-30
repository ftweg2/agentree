// 预设（方案）：全局方案存在 ~/.agentree/preset.json，项目方案存在 ~/.agentree/presets/，都不写入 Claude Code 配置。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DISPATCH_MODEL_RE } from '../../shared/dispatch.ts';
import type { Preset, PresetAgent, SchemeInfo, SchemeRef } from '../../shared/types.ts';
import { agentreeHome, AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, EFFORT_ORDER, isValidAutoCompactWindow } from './config.ts';
import { PathError, validateAgentName } from './config/paths.ts';
import { normalizeDir, schemeForSession } from './conformance.ts';

export function defaultPreset(): Preset {
  return {
    version: 1,
    main: { model: null, effort: null, autoCompactWindow: null },
    advisor: { model: null },
    agents: [],
    allowBuiltins: true,
    updatedAt: null,
  };
}

function presetPath() {
  return path.join(agentreeHome(), 'preset.json');
}

function optStr(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error(`${field} 必须是字符串或 null`);
  const t = v.trim();
  return t ? t : null;
}

function optEffort(v: unknown, field: string): string | null {
  const s = optStr(v, field);
  if (s !== null && !EFFORT_ORDER.includes(s.toLowerCase())) {
    throw new Error(`${field} 必须是 ${EFFORT_ORDER.join('、')} 之一或 null`);
  }
  return s === null ? null : s.toLowerCase();
}

/** 自动压缩阈值：null / 缺失表示不指定；否则必须是 Claude Code 接受范围内的整数 */
function optWindow(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (!isValidAutoCompactWindow(v)) throw new Error(`${field} 必须是 ${AUTO_COMPACT_MIN} 到 ${AUTO_COMPACT_MAX} 之间的整数（token 数）或 null`);
  return v;
}

export const DESCRIPTION_MAX = 4000;
export const PROMPT_MAX = 200_000;
export const TOOLS_MAX = 4000;

/** 工具列表规范化：按逗号拆分、去空白、去重，再用 ", " 连接；拆完为空返回 null */
export function normalizeTools(v: string): string | null {
  const seen = new Set<string>();
  for (const t of v.split(',').map((x) => x.trim())) if (t) seen.add(t);
  return seen.size ? [...seen].join(', ') : null;
}

/** 两个工具列表是否相同（忽略空白和顺序） */
export function sameTools(a: string | null, b: string | null): boolean {
  const set = (v: string | null) =>
    v === null
      ? null
      : [
          ...new Set(
            v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ]
          .sort()
          .join(',');
  return set(a) === set(b);
}

/** description、prompt：只接受字符串；null 当作缺失。返回 undefined 表示缺失 */
function optText(v: unknown, field: string, max: number, trim: boolean): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${field} 必须是字符串`);
  const s = trim ? v.trim() : v;
  if (trim && !s) return undefined;
  if (s.length > max) throw new Error(`${field} 太长：最多 ${max} 个字符，现在是 ${s.length} 个`);
  return s;
}

/** tools、disallowedTools：字符串或 null。返回 undefined 表示缺失 */
function optTools(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`${field} 必须是逗号分隔的字符串或 null`);
  const s = normalizeTools(v);
  if (s !== null && s.length > TOOLS_MAX) throw new Error(`${field} 太长：最多 ${TOOLS_MAX} 个字符，现在是 ${s.length} 个`);
  return s;
}

/**
 * dispatchModel：缺失返回 undefined（应用时不动已有的块），null 表示明确不要，字符串必须是别名或完整模型 ID。
 * 去掉首尾空白后为空的字符串当作 null，和 model 等字段的空值处理一致
 */
function optDispatchModel(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error(`${field} 必须是字符串或 null`);
  const s = v.trim();
  if (!s) return null;
  if (!DISPATCH_MODEL_RE.test(s)) throw new Error(`${field} 不合法：只能是模型别名（如 haiku）或完整模型 ID，不能有空格和特殊符号`);
  return s;
}

/** 校验并规范化；不合法时抛出带中文说明的错误 */
export function validatePreset(input: unknown): Preset {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预设必须是 JSON 对象');
  const o = input as Record<string, any>;
  if (o.version !== undefined && o.version !== 1) throw new Error('version 必须是 1');
  const main = o.main ?? {};
  const advisor = o.advisor ?? {};
  if (typeof main !== 'object' || Array.isArray(main)) throw new Error('main 必须是对象');
  if (typeof advisor !== 'object' || Array.isArray(advisor)) throw new Error('advisor 必须是对象');
  const agentsRaw = o.agents ?? [];
  if (!Array.isArray(agentsRaw)) throw new Error('agents 必须是数组');
  const seen = new Set<string>();
  const agents: PresetAgent[] = agentsRaw.map((a: any, i: number) => {
    if (!a || typeof a !== 'object') throw new Error(`agents[${i}] 必须是对象`);
    const name = optStr(a.name, `agents[${i}].name`);
    if (!name) throw new Error(`agents[${i}].name 不能为空`);
    // 和写入时同一条规则：名字就是定义文件名，不合法的名字连保存都不接受
    try {
      validateAgentName(name);
    } catch (e) {
      if (e instanceof PathError) throw new Error(`agents[${i}].name 不合法：${e.message}`);
      throw e;
    }
    if (seen.has(name)) throw new Error(`agents 里有重复的名字 ${name}`);
    seen.add(name);
    const pa: PresetAgent = {
      name,
      model: optStr(a.model, `agents[${i}].model`),
      effort: optEffort(a.effort, `agents[${i}].effort`),
    };
    if (a.note !== undefined && a.note !== null) {
      if (typeof a.note !== 'string') throw new Error(`agents[${i}].note 必须是字符串`);
      pa.note = a.note;
    }
    // 定义文件的内容：缺失（不写这个键）和 null 含义不同，只有真正给了值才放进对象
    const description = optText(a.description, `agents[${i}].description`, DESCRIPTION_MAX, true);
    if (description !== undefined) pa.description = description;
    const tools = optTools(a.tools, `agents[${i}].tools`);
    if (tools !== undefined) pa.tools = tools;
    const disallowedTools = optTools(a.disallowedTools, `agents[${i}].disallowedTools`);
    if (disallowedTools !== undefined) pa.disallowedTools = disallowedTools;
    const prompt = optText(a.prompt, `agents[${i}].prompt`, PROMPT_MAX, false);
    if (prompt !== undefined) pa.prompt = prompt;
    // 往下派发的模型：缺失、null、字符串三种含义不同（见 PresetAgent.dispatchModel），缺失时不放进对象
    const dispatchModel = optDispatchModel(a.dispatchModel, `agents[${i}].dispatchModel`);
    if (dispatchModel !== undefined) pa.dispatchModel = dispatchModel;
    return pa;
  });
  if (o.allowBuiltins !== undefined && typeof o.allowBuiltins !== 'boolean') throw new Error('allowBuiltins 必须是布尔值');
  return {
    version: 1,
    main: {
      model: optStr(main.model, 'main.model'),
      effort: optEffort(main.effort, 'main.effort'),
      // 旧方案没有这个字段：当作不指定
      autoCompactWindow: optWindow(main.autoCompactWindow, 'main.autoCompactWindow'),
    },
    advisor: { model: optStr(advisor.model, 'advisor.model') },
    agents,
    allowBuiltins: o.allowBuiltins ?? true,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
  };
}

// ---------------- 应用记录 ----------------

/** 主会话 effort 写在哪里：顶层 effortLevel，或 modelSettings.<model>.effortLevel */
export interface EffortLocation {
  where: 'top' | 'modelSettings';
  /** where 为 modelSettings 时是规范化后的模型 ID；top 为 null */
  model: string | null;
}

/** agentree 写过的主会话 effort：位置和写入的值 */
export interface WrittenEffort extends EffortLocation {
  value: string;
}

/**
 * 上一次通过 preset.apply 成功应用的记录，存在 ~/.agentree/applied.json。
 * wrote 记录 agentree 写进 settings.json 的值（null 表示没写过）：prune 只移除
 * "现在的值还和记录的值完全相同"的键，被用户或 cc-switch 改过的不动。
 */
export interface AppliedRecord {
  appliedAt: string;
  includeRule: boolean;
  wrote: {
    model: string | null;
    advisorModel: string | null;
    effort: WrittenEffort | null;
    /** 写过的 autoCompactWindow；旧记录没有这个字段时为 null */
    autoCompactWindow: number | null;
  };
}

function appliedPath() {
  return path.join(agentreeHome(), 'applied.json');
}

/**
 * 读取应用记录；不存在或格式不对返回 null。
 * 旧格式里的布尔值（true 表示写过但不知道值）按 null 处理：不知道值就无法确认现在的值还是 agentree 的，不删
 */
export function readApplied(): AppliedRecord | null {
  try {
    return parseApplied(JSON.parse(fs.readFileSync(appliedPath(), 'utf8')));
  } catch {
    return null;
  }
}

/** 原子写入全局方案的应用记录 */
export function writeApplied(rec: AppliedRecord): void {
  writeJsonAtomic(appliedPath(), rec);
}

/** 原子写入 JSON（先写临时文件再重命名） */
function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------- 项目方案 ----------------

/** 项目方案文件：~/.agentree/presets/<项目目录规范化路径的 sha256 前 16 位>.json */
export interface ProjectScheme {
  projectCwd: string;
  preset: Preset;
  /** 这个项目的应用记录；没应用过为 null */
  applied: AppliedRecord | null;
}

function presetsDir() {
  return path.join(agentreeHome(), 'presets');
}

/** 项目方案的文件名：规范化（path.resolve，Windows 上转小写）后的路径的 sha256 前 16 位 */
export function projectSchemeFile(projectCwd: string): string {
  const key = crypto.createHash('sha256').update(normalizeDir(projectCwd)).digest('hex').slice(0, 16);
  return path.join(presetsDir(), `${key}.json`);
}

/** 解析应用记录；格式不对返回 null。旧格式里的布尔值按 null 处理（见 readApplied） */
function parseApplied(o: any): AppliedRecord | null {
  if (!o || typeof o !== 'object' || typeof o.appliedAt !== 'string') return null;
  const w = o.wrote && typeof o.wrote === 'object' ? o.wrote : {};
  const e = w.effort;
  const effort: WrittenEffort | null =
    e && typeof e === 'object' && typeof e.value === 'string' && (e.where === 'top' || (e.where === 'modelSettings' && typeof e.model === 'string'))
      ? { where: e.where, model: e.where === 'top' ? null : e.model, value: e.value }
      : null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    appliedAt: o.appliedAt,
    includeRule: o.includeRule === true,
    wrote: { model: str(w.model), advisorModel: str(w.advisorModel), effort, autoCompactWindow: num(w.autoCompactWindow) },
  };
}

/** 读一个项目方案文件；读不了或格式不对返回 null（当作不存在，不抛错） */
function readProjectScheme(file: string): ProjectScheme | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || typeof o !== 'object' || typeof o.projectCwd !== 'string' || !path.isAbsolute(o.projectCwd)) return null;
    // 文件名和内容里的目录对不上（被手工改过）：不认
    if (path.resolve(projectSchemeFile(o.projectCwd)) !== path.resolve(file)) return null;
    return { projectCwd: o.projectCwd, preset: validatePreset(o.preset), applied: parseApplied(o.applied) };
  } catch {
    return null;
  }
}

export class PresetScopeError extends Error {}

/** 项目目录参数的基本检查：必须是绝对路径。是否是索引里出现过的目录由调用方检查 */
export function checkProjectCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new PresetScopeError('项目目录不能为空');
  if (cwd.includes('\0') || !path.isAbsolute(cwd)) throw new PresetScopeError(`项目目录必须是绝对路径：${cwd}`);
  return path.resolve(cwd);
}

/**
 * 方案存储。全局方案是 preset.json + applied.json（格式不变）；项目方案在 presets/ 下每个项目一个文件。
 * 方法里 projectCwd 为 null / 缺失表示全局方案。任何方案变化都会让 version 加一（一致性检查的缓存靠它失效）
 */
export class PresetStore {
  private cached: Preset | null = null;
  /** 项目方案的缓存，键为 normalizeDir(projectCwd)；null 表示还没从磁盘读过 */
  private projectCache: Map<string, ProjectScheme> | null = null;
  version = 0;

  get(projectCwd: string | null = null): Preset {
    if (projectCwd !== null) return this.project(projectCwd)?.preset ?? defaultPreset();
    if (this.cached) return this.cached;
    try {
      this.cached = validatePreset(JSON.parse(fs.readFileSync(presetPath(), 'utf8')));
    } catch {
      this.cached = defaultPreset();
    }
    return this.cached;
  }

  save(input: unknown, projectCwd: string | null = null): Preset {
    const p = validatePreset(input);
    p.updatedAt = new Date().toISOString();
    if (projectCwd === null) {
      writeJsonAtomic(presetPath(), p);
      this.cached = p;
    } else {
      const cwd = checkProjectCwd(projectCwd);
      const prev = this.project(cwd);
      this.writeProject({ projectCwd: prev?.projectCwd ?? cwd, preset: p, applied: prev?.applied ?? null });
    }
    this.version++;
    return p;
  }

  /** 删除项目方案（只删 agentree 自己的记录）。不存在返回 false */
  remove(projectCwd: string): boolean {
    const cwd = checkProjectCwd(projectCwd);
    if (!this.project(cwd)) return false;
    fs.rmSync(projectSchemeFile(cwd), { force: true });
    this.projects().delete(normalizeDir(cwd));
    this.version++;
    return true;
  }

  /** 应用记录：全局在 applied.json，项目在项目方案文件里 */
  getApplied(projectCwd: string | null = null): AppliedRecord | null {
    return projectCwd === null ? readApplied() : (this.project(projectCwd)?.applied ?? null);
  }

  setApplied(rec: AppliedRecord, projectCwd: string | null = null): void {
    if (projectCwd === null) writeApplied(rec);
    else {
      const cwd = checkProjectCwd(projectCwd);
      const prev = this.project(cwd);
      this.writeProject({ projectCwd: prev?.projectCwd ?? cwd, preset: prev?.preset ?? defaultPreset(), applied: rec });
    }
    this.version++;
  }

  /** 全部项目方案 */
  listProjects(): ProjectScheme[] {
    return [...this.projects().values()];
  }

  /** GET /api/presets：全局方案排第一（即使还没保存过），后面是项目方案，按最近保存排序 */
  list(): SchemeInfo[] {
    const g = this.get();
    const out: SchemeInfo[] = [{ scope: 'user', projectCwd: null, agents: g.agents.length, updatedAt: g.updatedAt, appliedAt: readApplied()?.appliedAt ?? null }];
    const projects = this.listProjects().sort((a, b) => (b.preset.updatedAt ?? '').localeCompare(a.preset.updatedAt ?? ''));
    for (const p of projects) {
      out.push({ scope: 'project', projectCwd: p.projectCwd, agents: p.preset.agents.length, updatedAt: p.preset.updatedAt, appliedAt: p.applied?.appliedAt ?? null });
    }
    return out;
  }

  /** 一个会话按哪份方案检查（项目方案叠在全局方案上） */
  schemeFor(cwd: string | null): { ref: SchemeRef; preset: Preset } {
    return schemeForSession(cwd, this.get(), this.listProjects());
  }

  private project(projectCwd: string): ProjectScheme | null {
    return this.projects().get(normalizeDir(projectCwd)) ?? null;
  }

  private projects(): Map<string, ProjectScheme> {
    if (this.projectCache) return this.projectCache;
    const map = new Map<string, ProjectScheme>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(presetsDir()).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {
      /* 目录不存在：没有项目方案 */
    }
    for (const n of names) {
      const s = readProjectScheme(path.join(presetsDir(), n));
      if (s) map.set(normalizeDir(s.projectCwd), s);
    }
    this.projectCache = map;
    return map;
  }

  private writeProject(s: ProjectScheme) {
    fs.mkdirSync(presetsDir(), { recursive: true });
    writeJsonAtomic(projectSchemeFile(s.projectCwd), s);
    this.projects().set(normalizeDir(s.projectCwd), s);
  }
}

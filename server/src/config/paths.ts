// 写入范围白名单。所有读写配置文件的路径都必须经过这里。
import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDirs } from '../config.ts';

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
  'COM0', 'LPT0',
]);

export type WritableKind = 'settings' | 'claudeMd' | 'agent';

export interface WritableTarget {
  kind: WritableKind;
  /** 解析后的绝对路径（实际读写的路径，符号链接已解析） */
  path: string;
  /** agent 定义的名字（kind 为 agent 时） */
  agentName: string | null;
  scope: 'user' | 'project' | null;
  projectCwd: string | null;
}

export class PathError extends Error {}

/** agent 名字校验：只允许字母数字开头的 [A-Za-z0-9_-]，最长 64；拒绝 Windows 保留名 */
export function validateAgentName(name: unknown): string {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new PathError(`agent 名字 ${JSON.stringify(name)} 不合法：只能用字母、数字、下划线和连字符，以字母或数字开头，最长 64 个字符`);
  }
  if (WINDOWS_RESERVED.has(name.toUpperCase())) throw new PathError(`agent 名字 ${name} 是 Windows 保留名，不能用作文件名`);
  return name;
}

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 解析真实路径；文件不存在时解析最近的已存在祖先目录再拼回去 */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realpathLoose(parent), path.basename(abs));
  }
}

export function userAgentsDir(configDir = claudeConfigDirs()[0]): string {
  return path.join(configDir, 'agents');
}

export function projectAgentsDir(cwd: string): string {
  return path.join(cwd, '.claude', 'agents');
}

export function isKnownProjectCwd(cwd: string, knownCwds: string[]): boolean {
  const n = norm(cwd);
  return knownCwds.some((c) => norm(c) === n);
}

interface AllowedDirs {
  roots: Map<string, string>; // norm -> 原路径
  userAgents: Map<string, string>;
  projectAgents: Map<string, string>; // norm(dir) -> cwd
  /** 项目根目录（可写 CLAUDE.md）：norm(cwd) -> cwd */
  projectRoots: Map<string, string>;
  /** 项目的 .claude 目录（可写 settings.local.json）：norm(dir) -> cwd */
  projectDotClaude: Map<string, string>;
}

/**
 * 白名单目录。real 为 true 时只解析根目录（配置目录、项目目录）本身的符号链接，
 * 其下的 agents、.claude/agents 按字面拼接：这样整个 ~/.claude 是链接的用户仍可用，
 * 而 agents 目录被链接到别处时，真实路径对不上，会被拒绝。
 */
function allowedDirs(knownCwds: string[], real: boolean): AllowedDirs {
  const base = (p: string) => (real ? realpathLoose(p) : path.resolve(p));
  const roots = new Map<string, string>();
  const userAgents = new Map<string, string>();
  for (const cd of claudeConfigDirs()) {
    roots.set(norm(base(cd)), cd);
    userAgents.set(norm(path.join(base(cd), 'agents')), cd);
  }
  const projectAgents = new Map<string, string>();
  const projectRoots = new Map<string, string>();
  const projectDotClaude = new Map<string, string>();
  for (const cwd of knownCwds) {
    projectAgents.set(norm(path.join(base(cwd), '.claude', 'agents')), cwd);
    projectRoots.set(norm(base(cwd)), cwd);
    projectDotClaude.set(norm(path.join(base(cwd), '.claude')), cwd);
  }
  return { roots, userAgents, projectAgents, projectRoots, projectDotClaude };
}

function classify(p: string, dirs: AllowedDirs): Omit<WritableTarget, 'path'> | null {
  const dir = norm(path.dirname(p));
  const base = path.basename(p);
  if (dirs.roots.has(dir)) {
    if (base.toLowerCase() === 'settings.json') return { kind: 'settings', agentName: null, scope: null, projectCwd: null };
    if (base.toLowerCase() === 'claude.md') return { kind: 'claudeMd', agentName: null, scope: null, projectCwd: null };
    return null;
  }
  // 项目级：<项目>/CLAUDE.md 和 <项目>/.claude/settings.local.json。
  // <项目>/.claude/settings.json 通常进版本库、团队共用，不放开；<项目>/.claude/CLAUDE.md 也不放开
  const projRoot = dirs.projectRoots.get(dir);
  if (projRoot !== undefined && base.toLowerCase() === 'claude.md') return { kind: 'claudeMd', agentName: null, scope: 'project', projectCwd: projRoot };
  const projDot = dirs.projectDotClaude.get(dir);
  if (projDot !== undefined && base.toLowerCase() === 'settings.local.json') return { kind: 'settings', agentName: null, scope: 'project', projectCwd: projDot };
  const m = /^(.+)\.md$/i.exec(base);
  if (!m) return null;
  try {
    validateAgentName(m[1]);
  } catch {
    return null;
  }
  if (dirs.userAgents.has(dir)) return { kind: 'agent', agentName: m[1], scope: 'user', projectCwd: null };
  const cwd = dirs.projectAgents.get(dir);
  if (cwd) return { kind: 'agent', agentName: m[1], scope: 'project', projectCwd: cwd };
  return null;
}

/**
 * 检查一个路径是否允许写入。解析成绝对路径后判断（防 .. 穿越），
 * 再解析符号链接后的真实路径，真实路径也必须在白名单内。不允许时抛 PathError。
 */
export function checkWritable(target: string, knownCwds: string[]): WritableTarget {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw new PathError('路径为空或含非法字符');
  if (!path.isAbsolute(target)) throw new PathError(`必须是绝对路径：${target}`);
  const abs = path.resolve(target);
  const c1 = classify(abs, allowedDirs(knownCwds, false));
  if (!c1) throw new PathError(`不在允许写入的范围内：${abs}`);
  const real = realpathLoose(abs);
  const c2 = classify(real, allowedDirs(knownCwds, true));
  if (!c2 || c2.kind !== c1.kind || c2.scope !== c1.scope) throw new PathError(`路径经符号链接解析后不在允许写入的范围内：${real}`);
  return { ...c1, path: real };
}

/** 由 scope + 名字得到 agent 定义文件路径（并过白名单） */
export function agentFilePath(scope: 'user' | 'project', name: string, projectCwd: string | null, knownCwds: string[]): WritableTarget {
  validateAgentName(name);
  let dir: string;
  if (scope === 'user') dir = userAgentsDir();
  else {
    if (!projectCwd) throw new PathError('项目级 agent 必须指定 projectCwd');
    if (!isKnownProjectCwd(projectCwd, knownCwds)) throw new PathError(`项目目录 ${projectCwd} 没有在索引过的会话里出现过，拒绝写入`);
    dir = projectAgentsDir(projectCwd);
  }
  return checkWritable(path.join(dir, `${name}.md`), knownCwds);
}

/** 项目方案的设置文件：<项目>/.claude/settings.local.json（个人用，不进版本库） */
export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json');
}

/** 项目方案的规则文件：<项目>/CLAUDE.md（不用 <项目>/.claude/CLAUDE.md） */
export function projectClaudeMdPath(cwd: string): string {
  return path.join(cwd, 'CLAUDE.md');
}

/** 项目目录下的 .claude 就是 Claude Code 的用户配置目录（比如把用户目录当成了项目）：不能当项目方案用 */
export function isConfigDirProject(cwd: string): boolean {
  const dot = norm(path.join(cwd, '.claude'));
  return claudeConfigDirs().some((d) => norm(d) === dot);
}

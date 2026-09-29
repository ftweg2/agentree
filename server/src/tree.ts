// 建树：用 meta.json 的 toolUseId 精确匹配父级 tool_use 块。纯函数。
import type { MetaRow } from './db.ts';
import { AGENT_TOOL_NAMES } from './parser.ts';

export interface ToolUseLoc {
  /** tool_use 所在的文件：'main' 或子 agent id */
  agent: string;
  id: string;
  name: string;
  ts: string | null;
  subagentType: string | null;
  description: string | null;
  model: string | null;
  background: boolean | null;
}

export interface ResultLoc {
  /** 工具结果所在的文件 */
  agent: string;
  toolUseId: string;
  agentId: string;
  status: string | null;
  isAsync: boolean;
  durationMs: number | null;
  resolvedModel: string | null;
  agentType: string | null;
  description: string | null;
  ts: string | null;
}

export type LinkMethod = 'meta' | 'result' | 'fallback';

export interface ResolvedLink {
  parentId: string;
  depth: number;
  toolUseId: string | null;
  link: LinkMethod;
  toolUse: ToolUseLoc | null;
  result: ResultLoc | null;
}

export interface TreeInput {
  agentIds: string[];
  metas: Map<string, MetaRow>;
  /** 按 tool_use id 查找；同一个 id 出现在多个文件时优先主文件 */
  toolUses: Map<string, ToolUseLoc>;
  /** 工具结果，按 agentId 分组 */
  results: Map<string, ResultLoc[]>;
}

/** 挑出属于派发子 agent 的工具结果（排除 SendMessage 之类也带 agentId 的结果） */
function pickResult(agentId: string, input: TreeInput, preferToolUseId: string | null): ResultLoc | null {
  const list = input.results.get(agentId) ?? [];
  const valid = list.filter((r) => {
    const tu = input.toolUses.get(r.toolUseId);
    return !tu || AGENT_TOOL_NAMES.has(tu.name);
  });
  if (!valid.length) return null;
  if (preferToolUseId) {
    const exact = valid.find((r) => r.toolUseId === preferToolUseId);
    if (exact) return exact;
  }
  // 同一个 agent 可能有启动结果（async_launched）和完成结果；优先非 async 的完成结果
  const done = valid.find((r) => !r.isAsync);
  if (done) return done;
  return [...valid].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))[0];
}

export function resolveTree(input: TreeInput): Map<string, ResolvedLink> {
  const known = new Set(input.agentIds);
  const raw = new Map<string, Omit<ResolvedLink, 'depth'> & { fallbackDepth: number }>();
  for (const id of input.agentIds) {
    const meta = input.metas.get(id) ?? null;
    let parentId: string | null = null;
    let link: LinkMethod = 'fallback';
    let toolUse: ToolUseLoc | null = null;
    let toolUseId: string | null = meta?.toolUseId ?? null;
    // 1. meta.json 的 toolUseId
    if (meta?.toolUseId) {
      const tu = input.toolUses.get(meta.toolUseId);
      if (tu && tu.agent !== id && (tu.agent === 'main' || known.has(tu.agent))) {
        parentId = tu.agent;
        link = 'meta';
        toolUse = tu;
      }
    }
    const result = pickResult(id, input, toolUseId);
    // 2. 工具结果里的 agentId 对应的 tool_use_id
    if (!parentId && result) {
      const tu = input.toolUses.get(result.toolUseId);
      if (tu && tu.agent !== id && (tu.agent === 'main' || known.has(tu.agent))) {
        parentId = tu.agent;
        toolUse = tu;
      } else if (result.agent !== id && (result.agent === 'main' || known.has(result.agent))) {
        parentId = result.agent;
      }
      if (parentId) {
        link = 'result';
        toolUseId = result.toolUseId;
      }
    }
    if (!toolUse && toolUseId) toolUse = input.toolUses.get(toolUseId) ?? null;
    // 3. 兜底：挂到 main
    if (!parentId) {
      parentId = 'main';
      link = 'fallback';
    }
    raw.set(id, {
      parentId,
      toolUseId,
      link,
      toolUse,
      result,
      fallbackDepth: meta?.spawnDepth && meta.spawnDepth > 0 ? meta.spawnDepth : 1,
    });
  }

  // 深度：父节点深度 + 1；兜底节点用 spawnDepth；有环时断开挂到 main
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (id === 'main') return 0;
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const r = raw.get(id);
    if (!r) return 0;
    if (r.link === 'fallback') {
      depth.set(id, r.fallbackDepth);
      return r.fallbackDepth;
    }
    if (visiting.has(id)) {
      r.parentId = 'main';
      r.link = 'fallback';
      depth.set(id, r.fallbackDepth);
      return r.fallbackDepth;
    }
    visiting.add(id);
    const d = depthOf(r.parentId) + 1;
    visiting.delete(id);
    if (!depth.has(id)) depth.set(id, d);
    return depth.get(id)!;
  };
  const out = new Map<string, ResolvedLink>();
  for (const id of input.agentIds) {
    const d = depthOf(id);
    const r = raw.get(id)!;
    out.set(id, { parentId: r.parentId, depth: d, toolUseId: r.toolUseId, link: r.link, toolUse: r.toolUse, result: r.result });
  }
  return out;
}

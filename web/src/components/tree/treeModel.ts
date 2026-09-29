import type { AgentNode, SessionDetail } from '../../types';

export type UsageMode = 'own' | 'subtree';

export interface TreeIndex {
  byId: Map<string, AgentNode>;
  root: AgentNode | null;
  /** 每个节点的后代数量（不含自己） */
  descendants: Map<string, number>;
  /** 每个节点子树里正在运行的后代数量（不含自己） */
  runningBelow: Map<string, number>;
  /** 子节点列表：优先用 children，缺失时用 parentId 反推 */
  kids: Map<string, string[]>;
}

export function buildIndex(detail: SessionDetail): TreeIndex {
  const byId = new Map<string, AgentNode>();
  for (const a of detail.agents) byId.set(a.id, a);
  const root = detail.agents.find((a) => a.kind === 'main') ?? detail.agents[0] ?? null;

  // 以 children 为准；某些节点的父节点不在列表里时挂到根下，避免丢节点
  const kids = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const a of detail.agents) {
    const list = (a.children ?? []).filter((c) => byId.has(c) && c !== a.id);
    kids.set(a.id, list);
    list.forEach((c) => seen.add(c));
  }
  for (const a of detail.agents) {
    if (a === root || seen.has(a.id)) continue;
    const pid = a.parentId && byId.has(a.parentId) ? a.parentId : root?.id;
    if (!pid || pid === a.id) continue;
    kids.get(pid)!.push(a.id);
    seen.add(a.id);
  }

  const descendants = new Map<string, number>();
  const runningBelow = new Map<string, number>();
  const visiting = new Set<string>();
  function count(id: string): [number, number] {
    if (descendants.has(id)) return [descendants.get(id)!, runningBelow.get(id)!];
    if (visiting.has(id)) return [0, 0]; // 防御环
    visiting.add(id);
    let d = 0;
    let r = 0;
    for (const c of kids.get(id) ?? []) {
      const [cd, cr] = count(c);
      d += cd + 1;
      r += cr + (byId.get(c)?.status === 'running' ? 1 : 0);
    }
    visiting.delete(id);
    descendants.set(id, d);
    runningBelow.set(id, r);
    return [d, r];
  }
  for (const a of detail.agents) count(a.id);
  return { byId, root, descendants, runningBelow, kids };
}

export function hasWarn(node: AgentNode): boolean {
  return node.conformance.checks.some((c) => c.level === 'warn');
}

export function usageOf(node: AgentNode, mode: UsageMode) {
  if (mode === 'own') {
    return { requests: node.requests, tokens: node.tokens, costUsd: node.costUsd, toolCalls: node.toolCalls };
  }
  return {
    requests: node.subtree.requests,
    tokens: node.subtree.tokens,
    costUsd: node.subtree.costUsd,
    toolCalls: node.subtree.toolCalls,
  };
}

export function nodeLabel(node: AgentNode): string {
  return node.kind === 'main' ? '主会话' : node.agentType ?? '未知类型';
}

/** 从根到某节点的路径（用于确保选中节点的祖先都展开） */
export function ancestors(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  let cur = index.byId.get(id);
  const guard = new Set<string>();
  while (cur && cur.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.push(cur.parentId);
    cur = index.byId.get(cur.parentId);
  }
  return out;
}

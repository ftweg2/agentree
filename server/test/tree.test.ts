import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetaRow } from '../src/db.ts';
import { resolveTree, type ResultLoc, type ToolUseLoc } from '../src/tree.ts';

function tu(agent: string, id: string, name = 'Agent'): ToolUseLoc {
  return { agent, id, name, ts: null, subagentType: 'Explore', description: 'd', model: null, background: null };
}
function meta(toolUseId: string | null, spawnDepth: number | null = 1): MetaRow {
  return { agentType: 'Explore', description: 'd', toolUseId, spawnDepth, model: null, requestShape: null };
}
function res(agent: string, toolUseId: string, agentId: string, isAsync = false): ResultLoc {
  return { agent, toolUseId, agentId, status: isAsync ? 'async_launched' : 'completed', isAsync, durationMs: 1, resolvedModel: null, agentType: 'Explore', description: null, ts: null };
}

test('建树：meta.toolUseId 在主文件里找到 -> 父节点 main；在另一个子 agent 文件里找到 -> 嵌套', () => {
  const out = resolveTree({
    agentIds: ['A', 'B', 'C'],
    metas: new Map([
      ['A', meta('t1', 1)],
      ['B', meta('t2', 2)],
      ['C', meta('t3', 3)],
    ]),
    toolUses: new Map([
      ['t1', tu('main', 't1')],
      ['t2', tu('A', 't2')],
      ['t3', tu('B', 't3')],
    ]),
    results: new Map(),
  });
  assert.deepEqual(
    ['A', 'B', 'C'].map((id) => [out.get(id)!.parentId, out.get(id)!.depth, out.get(id)!.link]),
    [
      ['main', 1, 'meta'],
      ['A', 2, 'meta'],
      ['B', 3, 'meta'],
    ],
  );
});

test('建树兜底 2：没有 meta.json 时用工具结果里的 agentId 找 tool_use_id', () => {
  const out = resolveTree({
    agentIds: ['A', 'X'],
    metas: new Map([['A', meta('t1')]]),
    toolUses: new Map([
      ['t1', tu('main', 't1')],
      ['t9', tu('A', 't9')],
    ]),
    results: new Map([['X', [res('A', 't9', 'X')]]]),
  });
  const x = out.get('X')!;
  assert.equal(x.parentId, 'A');
  assert.equal(x.depth, 2);
  assert.equal(x.link, 'result');
  assert.equal(x.toolUseId, 't9');
});

test('建树兜底 3：都找不到时挂到 main，深度用 spawnDepth', () => {
  const out = resolveTree({
    agentIds: ['Z'],
    metas: new Map([['Z', meta('missing', 2)]]),
    toolUses: new Map(),
    results: new Map(),
  });
  assert.deepEqual([out.get('Z')!.parentId, out.get('Z')!.depth, out.get('Z')!.link], ['main', 2, 'fallback']);
});

test('建树：SendMessage 之类也带 agentId 的结果不能当成派发关系', () => {
  const out = resolveTree({
    agentIds: ['A', 'B'],
    metas: new Map([['A', meta('t1')]]),
    toolUses: new Map([
      ['t1', tu('main', 't1')],
      ['s1', tu('A', 's1', 'SendMessage')],
    ]),
    // B 没有 meta，唯一的结果来自 A 里的 SendMessage，不应据此把 B 挂到 A 下
    results: new Map([['B', [res('A', 's1', 'B')]]]),
  });
  assert.equal(out.get('B')!.link, 'fallback');
  assert.equal(out.get('B')!.parentId, 'main');
});

test('建树：异常数据形成环时断开，不死循环', () => {
  const out = resolveTree({
    agentIds: ['A', 'B'],
    metas: new Map([
      ['A', meta('tb', 1)],
      ['B', meta('ta', 1)],
    ]),
    toolUses: new Map([
      ['tb', tu('B', 'tb')],
      ['ta', tu('A', 'ta')],
    ]),
    results: new Map(),
  });
  const roots = ['A', 'B'].filter((id) => out.get(id)!.parentId === 'main');
  assert.equal(roots.length, 1);
});

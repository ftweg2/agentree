// 增量解析与端到端建树：用临时的 CLAUDE_CONFIG_DIR，不碰真实日志
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { Analyzer } from '../src/aggregate.ts';
import { Pricing } from '../src/pricing.ts';
import { Desktop } from '../src/desktop.ts';
import { PresetStore } from '../src/preset.ts';
import { assistant, cleanupTmp, notification, tmpDir, toolResult, userPrompt } from './helpers.ts';

const root = tmpDir();
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const proj = path.join(cfg, 'projects', 'C--proj');
const sid = '11111111-2222-3333-4444-555555555555';
const mainFile = path.join(proj, `${sid}.jsonl`);
const subDir = path.join(proj, sid, 'subagents');
let store: Store;
let indexer: Indexer;

before(() => {
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.AGENTREE_HOME = home;
  process.env.AGENTREE_DESKTOP_DIR = '';
  fs.mkdirSync(subDir, { recursive: true });
  store = new Store(path.join(home, 'agentree.db'));
  indexer = new Indexer(store);
});
after(() => {
  store.close();
  cleanupTmp();
});

const fileRow = () => store.db.prepare('SELECT offset, size, skipped FROM files WHERE path = ?').get(mainFile) as any;
const req = (key: string) => store.db.prepare('SELECT * FROM requests WHERE session_id = ? AND key = ?').get(sid, key) as any;
const count = () => (store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?').get(sid) as any).n;

test('增量：半行不会被吞掉，只读新增部分', async () => {
  const l1 = userPrompt('帮我做个东西') + '\n';
  const l2 = assistant({ id: 'm1', u: { i: 1, o: 10 } }) + '\n';
  const l3 = assistant({ id: 'm2', u: { i: 2, o: 20 } });
  const half = l3.slice(0, 40);
  fs.writeFileSync(mainFile, l1 + l2 + half);
  await indexer.fullScan();
  assert.equal(count(), 1, '半行不应被解析');
  assert.equal(fileRow().offset, Buffer.byteLength(l1 + l2), '偏移量停在最后一个完整换行之后');
  assert.equal(fileRow().skipped, 0, '半行不能算成坏行');

  // 补齐半行并追加新行
  fs.appendFileSync(mainFile, l3.slice(40) + '\n' + assistant({ id: 'm1', u: { i: 1, o: 99 } }) + '\n');
  await indexer.fullScan();
  assert.equal(count(), 2);
  assert.equal(req('m2').output, 20, '被拆开写入的那一行完整解析');
  assert.equal(req('m1').output, 99, '同一请求后续行取最大值');
  assert.equal(fileRow().offset, fs.statSync(mainFile).size);

  // 证明只读了新增部分：把已经读过的第一行原地改坏（大小不变），再追加一行。
  // 如果从头重读，坏行计数会加一。
  const buf = fs.readFileSync(mainFile);
  buf.fill(0x78, 0, 10); // 'xxxxxxxxxx'
  fs.writeFileSync(mainFile, buf);
  fs.appendFileSync(mainFile, assistant({ id: 'm3', u: { o: 3 } }) + '\n');
  await indexer.fullScan();
  assert.equal(fileRow().skipped, 0, '已读过的部分没有被重新解析');
  assert.equal(count(), 3);
});

test('增量：文件变小时从头重新解析，靠去重键不重复计数', async () => {
  fs.writeFileSync(mainFile, userPrompt('重写后的会话') + '\n' + assistant({ id: 'm1', u: { i: 1, o: 5 } }) + '\n');
  await indexer.fullScan();
  assert.equal(count(), 3, '数据只增不删，已入库的 m2/m3 保留');
  assert.equal(req('m1').output, 99, '去重取最大值，不重复');
  assert.equal(fileRow().offset, fs.statSync(mainFile).size);
});

test('增量：大小和修改时间都没变时跳过', async () => {
  const before = fileRow();
  const changed = await indexer.processFile(
    { path: mainFile, sessionId: sid, projectDir: 'C--proj', agent: 'main', subagentDir: null },
    fs.statSync(mainFile).size,
    fs.statSync(mainFile).mtimeMs,
  );
  assert.equal(changed, false);
  assert.deepEqual(fileRow(), before);
});

test('端到端：嵌套建树、子 agent 自己累加、跨文件去重、状态', async () => {
  // 主会话派发 A（前台）和 B（后台）；A 又派发 C
  fs.appendFileSync(
    mainFile,
    [
      assistant({ id: 'm10', u: { i: 1, o: 1 }, toolUses: [{ id: 'tA', name: 'Agent', input: { subagent_type: 'Explore', description: '看看', model: 'haiku' } }] }),
      assistant({ id: 'm11', u: { i: 1, o: 1 }, toolUses: [{ id: 'tB', name: 'Agent', input: { subagent_type: 'general-purpose', description: '后台干活', run_in_background: true } }] }),
      toolResult({ toolUseId: 'tA', result: { status: 'completed', agentId: 'aaa', agentType: 'Explore', totalTokens: 1, totalDurationMs: 1234 } }),
      toolResult({ toolUseId: 'tB', result: { status: 'async_launched', isAsync: true, agentId: 'bbb', description: '后台干活' } }),
      notification('bbb', 'completed'),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(subDir, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'Explore', description: '看看', toolUseId: 'tA', spawnDepth: 1 }));
  fs.writeFileSync(path.join(subDir, 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: '后台干活', toolUseId: 'tB', spawnDepth: 1 }));
  fs.writeFileSync(path.join(subDir, 'agent-ccc.meta.json'), JSON.stringify({ agentType: 'Plan', description: '嵌套', toolUseId: 'tC', spawnDepth: 2 }));
  fs.writeFileSync(
    path.join(subDir, 'agent-aaa.jsonl'),
    [
      assistant({ id: 'a1', agentId: 'aaa', u: { i: 1, o: 10, cr: 100 }, ts: '2026-09-28T10:01:00.000Z' }),
      assistant({ id: 'a1', agentId: 'aaa', u: { i: 1, o: 30, cr: 100 }, ts: '2026-09-28T10:01:00.000Z' }),
      assistant({ id: 'a2', agentId: 'aaa', u: { i: 1, o: 5, cr: 200 }, ts: '2026-09-28T10:02:00.000Z', toolUses: [{ id: 'tC', name: 'Agent', input: { subagent_type: 'Plan' } }, { id: 'r1', name: 'Read' }] }),
      // 与主会话重复的记录：应算给主会话
      assistant({ id: 'm10', agentId: 'aaa', u: { i: 1, o: 1 } }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(subDir, 'agent-bbb.jsonl'), assistant({ id: 'b1', agentId: 'bbb', u: { i: 5, o: 5 } }) + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-ccc.jsonl'), assistant({ id: 'c1', agentId: 'ccc', model: 'claude-fable-5-1', u: { o: 7 } }) + '\n');
  // journal.jsonl 要跳过
  fs.writeFileSync(path.join(subDir, 'journal.jsonl'), assistant({ id: 'j1', u: { o: 1000 } }) + '\n');
  await indexer.fullScan();

  const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), new PresetStore());
  const d = analyzer.sessionDetail(sid)!;
  assert.ok(d);
  const byId = new Map(d.agents.map((n) => [n.id, n]));
  assert.equal(d.agents[0].id, 'main');
  const a = byId.get('aaa')!;
  const b = byId.get('bbb')!;
  const c = byId.get('ccc')!;
  assert.deepEqual([a.parentId, a.depth, b.parentId, b.depth, c.parentId, c.depth], ['main', 1, 'main', 1, 'aaa', 2]);
  assert.equal(a.requests, 2, 'a1 去重、m10 归主会话');
  assert.equal(a.tokens.total, 2 + 30 + 300 + 5);
  assert.equal(a.toolCalls, 2);
  assert.equal(a.requestedModel, 'haiku');
  assert.equal(a.status, 'completed');
  assert.equal(a.durationMs, 1234);
  assert.equal(b.status, 'completed', '后台 agent 靠任务通知判定完成');
  assert.equal(b.background, true);
  assert.equal(c.agentType, 'Plan');
  assert.equal(c.primaryModel, 'claude-fable-5-1');
  assert.equal(a.subtree.agents, 1);
  assert.equal(a.subtree.tokens.total, a.tokens.total + c.tokens.total);
  assert.deepEqual(a.children, ['ccc']);
  assert.equal(d.summary.agentCount, 3);
  assert.equal(d.summary.maxDepth, 2);
  assert.equal(d.summary.title, '帮我做个东西', '标题兜底用首条用户消息，且只取第一次看到的');
  assert.ok(!d.agents.some((n) => n.models.some((m) => m.tokens.total >= 1000)), 'journal.jsonl 未被计入');
  const mainNode = byId.get('main')!;
  assert.equal(mainNode.requests, 5, 'm1 m2 m3 m10 m11');
});

test('端到端：killed 通知 -> stopped；等待长时间工具结果的 agent 在 30 分钟内算 running，也出现在实时接口里', async () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  fs.appendFileSync(
    mainFile,
    [
      assistant({ id: 'm20', u: { o: 1 }, toolUses: [
        { id: 'tK', name: 'Agent', input: { subagent_type: 'Explore', run_in_background: true } },
        { id: 'tP', name: 'Agent', input: { subagent_type: 'Explore', run_in_background: true } },
        { id: 'tO', name: 'Agent', input: { subagent_type: 'Explore', run_in_background: true } },
      ] }),
      toolResult({ toolUseId: 'tK', result: { status: 'async_launched', isAsync: true, agentId: 'kkk' } }),
      toolResult({ toolUseId: 'tP', result: { status: 'async_launched', isAsync: true, agentId: 'ppp' } }),
      toolResult({ toolUseId: 'tO', result: { status: 'async_launched', isAsync: true, agentId: 'ooo' } }),
      notification('kkk', 'killed', iso(40 * 60_000)),
    ].join('\n') + '\n',
  );
  const write = (id: string, tu: string, ageMs: number) => {
    const f = path.join(subDir, `agent-${id}.jsonl`);
    fs.writeFileSync(f, assistant({ id: `${id}1`, agentId: id, u: { o: 1 }, ts: iso(ageMs), toolUses: [{ id: tu, name: 'Bash' }] }) + '\n');
    const t = new Date(now - ageMs);
    fs.utimesSync(f, t, t);
    fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: tu === 'x' ? 'tK' : tu === 'y' ? 'tP' : 'tO', spawnDepth: 1 }));
  };
  write('kkk', 'x', 45 * 60_000); // 被中止
  write('ppp', 'y', 10 * 60_000); // 10 分钟前发起了 Bash，还没结果
  write('ooo', 'z', 45 * 60_000); // 45 分钟前发起，仍没结果 -> unknown
  // 主会话和上一个测试留下的子 agent 文件改成 1 小时前写入，避免干扰
  const old = new Date(now - 60 * 60_000);
  fs.utimesSync(mainFile, old, old);
  for (const id of ['aaa', 'bbb', 'ccc']) fs.utimesSync(path.join(subDir, `agent-${id}.jsonl`), old, old);
  await indexer.fullScan();

  const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), new PresetStore());
  const d = analyzer.sessionDetail(sid)!;
  const byId = new Map(d.agents.map((n) => [n.id, n]));
  assert.equal(byId.get('kkk')!.status, 'stopped');
  assert.ok(byId.get('kkk')!.endedAt);
  assert.equal(byId.get('ppp')!.status, 'running');
  assert.equal(byId.get('ooo')!.status, 'unknown');
  assert.equal(byId.get('main')!.status, 'running', '有子 agent 在运行时主节点也是 running');
  const live = analyzer.live();
  const s = live.sessions.find((x) => x.sessionId === sid);
  assert.ok(s, '会话出现在实时接口里，即使 120 秒内没有写入');
  assert.deepEqual(s!.runningAgents.map((a) => [a.id, a.currentTool]), [['ppp', 'Bash']]);
});

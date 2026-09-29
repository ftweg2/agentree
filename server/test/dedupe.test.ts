import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LineBatch, extractNotifications, readUsage } from '../src/parser.ts';
import { Store } from '../src/db.ts';
import { assistant, cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

test('去重：同一 message.id 多行时逐字段取最大值，而不是保留第一条或最后一条', () => {
  const b = new LineBatch(true);
  // 第一行 output 小、第二行 cache_read 小：只有逐字段取最大才能得到正确结果
  b.addLine(assistant({ id: 'm1', u: { i: 10, o: 5, cr: 1000, c1: 200 } }));
  b.addLine(assistant({ id: 'm1', u: { i: 10, o: 80, cr: 900, c1: 200 } }));
  b.addLine(assistant({ id: 'm1', u: { i: 3, o: 20, cr: 0, c1: 0 } }));
  assert.equal(b.requests.size, 1);
  const r = b.requests.get('m1')!;
  assert.deepEqual(
    { i: r.usage.input, o: r.usage.output, cr: r.usage.cacheRead, cc: r.usage.cacheCreate, c1: r.usage.cw1h },
    { i: 10, o: 80, cr: 1000, cc: 200, c1: 200 },
  );
});

test('去重键：message.id 缺失用 requestId，都缺失用 uuid', () => {
  const b = new LineBatch(true);
  b.addLine(assistant({ id: null, requestId: 'req_1', uuid: 'a', u: { o: 1 } }));
  b.addLine(assistant({ id: null, requestId: 'req_1', uuid: 'b', u: { o: 7 } }));
  b.addLine(assistant({ id: null, requestId: null, uuid: 'only-uuid', u: { o: 3 } }));
  assert.deepEqual([...b.requests.keys()].sort(), ['only-uuid', 'req_1']);
  assert.equal(b.requests.get('req_1')!.usage.output, 7);
});

test('宽松解析：坏行计数并跳过，字段缺失不丢整行，未知类型忽略', () => {
  const b = new LineBatch(true);
  b.addLine('{"type":"assistant",');
  b.addLine('not json');
  b.addLine(JSON.stringify({ type: 'assistant', uuid: 'x', message: { id: 'm2', model: null, usage: null } }));
  b.addLine(JSON.stringify({ type: 'some-future-type', foo: 1 }));
  assert.equal(b.badLines, 2);
  assert.equal(b.requests.size, 1);
  assert.equal(b.requests.get('m2')!.usage.output, 0);
});

test('缓存写入分 5 分钟和 1 小时两档；没有拆分时计入 5 分钟档', () => {
  const u = readUsage({ input_tokens: 1, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } });
  assert.equal(u.cw5m, 100);
  assert.equal(u.cw1h, 200);
  const v = readUsage({ cache_creation_input_tokens: 50 });
  assert.equal(v.cw5m, 50);
  assert.equal(v.cw1h, 0);
});

test('advisor 迭代单独记录，不混入顶层 usage', () => {
  const b = new LineBatch(true);
  b.addLine(
    assistant({
      id: 'm3',
      u: { i: 5, o: 5 },
      iterations: [{ type: 'message', input_tokens: 5 }, { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 20 }],
    }),
  );
  const r = b.requests.get('m3')!;
  assert.equal(r.usage.input, 5);
  assert.equal(r.advisor.length, 1);
  assert.equal(r.advisor[0].usage.input, 100);
});

test('任务通知：提取 task-id 与 status', () => {
  const n = extractNotifications('<task-notification><task-id>abc</task-id><status>completed</status></task-notification> <task-notification><task-id>b1</task-id><status>failed</status></task-notification>');
  assert.deepEqual(n, [
    { taskId: 'abc', status: 'completed' },
    { taskId: 'b1', status: 'failed' },
  ]);
  assert.deepEqual(extractNotifications('说明文字里提到 <task-notification> 但没有 id'), []);
});

test('跨文件去重：同一 message.id 同时在主文件和子 agent 文件里时算给主文件，取最大值，不重复计数', () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 't.db'));
  const file = (agent: string) => ({
    path: path.join(dir, `${agent}.jsonl`),
    session_id: 'S',
    project_dir: 'P',
    agent,
    size: 1,
    mtime_ms: 1,
    offset: 1,
    fingerprint: '',
    skipped: 0,
    first_ts: null,
    last_ts: null,
    pending_tools: null,
  });
  // 子 agent 文件先被索引
  const sub = new LineBatch(false);
  sub.addLine(assistant({ id: 'shared', u: { i: 1, o: 50, cr: 10 } }));
  sub.addLine(assistant({ id: 'own', u: { i: 2, o: 2 } }));
  store.commitBatch(file('a1'), sub);
  const main = new LineBatch(true);
  main.addLine(assistant({ id: 'shared', u: { i: 1, o: 40, cr: 99 } }));
  store.commitBatch(file('main'), main);
  // 再次索引子 agent 文件（例如文件被重写后从头解析），归属不能被抢回
  store.commitBatch(file('a1'), sub);
  const rows = store.db.prepare('SELECT key, agent, input, output, cache_read FROM requests ORDER BY key').all() as any[];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { key: 'own', agent: 'a1', input: 2, output: 2, cache_read: 0 },
      { key: 'shared', agent: 'main', input: 1, output: 50, cache_read: 99 },
    ],
  );
  store.close();
});

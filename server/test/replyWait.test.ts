// 回复等待（等第一段内容的时间、整次回复耗时）、中断次数、"正在等回复"的判定。临时目录，不碰真实日志。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, Store } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { Analyzer, SLOW_REPLY_MS } from '../src/aggregate.ts';
import { Pricing } from '../src/pricing.ts';
import { Desktop } from '../src/desktop.ts';
import { PresetStore } from '../src/preset.ts';
import { isInterruptText, LineBatch, parsePending } from '../src/parser.ts';
import { assistant, cleanupTmp, tmpDir, toolResult } from './helpers.ts';

const root = tmpDir('agentree-wait-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const proj = path.join(cfg, 'projects', 'C--proj');
const sid = 'cccccccc-0000-0000-0000-000000000001';
const mainFile = path.join(proj, `${sid}.jsonl`);
const subDir = path.join(proj, sid, 'subagents');
const dbPath = path.join(home, 'agentree.db');

before(() => {
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.AGENTREE_HOME = home;
  process.env.AGENTREE_DESKTOP_DIR = '';
  fs.mkdirSync(subDir, { recursive: true });
});
after(() => cleanupTmp());

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 8, 28, 10, min, sec)).toISOString();
const user = (text: string | unknown[], ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', uuid: Math.random().toString(36).slice(2), timestamp: ts, message: { role: 'user', content: text }, ...extra });
const interruptStr = (ts: string, uuid?: string) =>
  JSON.stringify({ type: 'user', uuid: uuid ?? Math.random().toString(36).slice(2), timestamp: ts, message: { role: 'user', content: '[Request interrupted by user]' } });
const interruptArr = (ts: string, uuid?: string) =>
  JSON.stringify({
    type: 'user',
    uuid: uuid ?? Math.random().toString(36).slice(2),
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  });
/** 一次回复的一个内容块：同一个 message.id，output_tokens 是整次回复的总数 */
const block = (id: string, ts: string, o: number, agentId?: string, toolUses?: Array<{ id: string; name: string }>) => assistant({ id, requestId: `req-${id}`, u: { i: 10, o }, ts, agentId, toolUses });

test('识别中断标记的两种写法，普通文字不算', () => {
  assert.equal(isInterruptText('[Request interrupted by user]'), true);
  assert.equal(isInterruptText(' [Request interrupted by user for tool use] '), true);
  assert.equal(isInterruptText('请不要 [Request interrupted by user]'), false);
  assert.equal(isInterruptText('[Request interrupted]'), false);
});

test('解析：一次回复多块时，等待 = 第一块 - 前一条用户记录，耗时 = 最后一块 - 前一条用户记录；下一次回复从工具结果算起', () => {
  const b = new LineBatch(true);
  b.addLine(user('写一个页面', T(0)));
  b.addLine(block('r1', T(6, 8), 43_616)); // thinking：6 分 08 秒后才完成
  b.addLine(block('r1', T(7, 0), 43_616)); // text
  b.addLine(block('r1', T(8, 30), 43_616, undefined, [{ id: 'tu1', name: 'Write' }])); // tool_use
  b.addLine(toolResult({ toolUseId: 'tu1', result: {}, ts: T(8, 31) }));
  b.addLine(block('r2', T(9, 1), 200));
  const r1 = b.requests.get('r1')!;
  assert.deepEqual([r1.promptTs, r1.ts, r1.endTs], [T(0), T(6, 8), T(8, 30)]);
  const r2 = b.requests.get('r2')!;
  assert.deepEqual([r2.promptTs, r2.ts, r2.endTs], [T(8, 31), T(9, 1), T(9, 1)]);
  // 回复完成后不在等
  assert.equal(b.pending.awaiting, null);
});

test('解析：中断标记两种写法都记，同一批里重复的 uuid 只记一次；不当成标题；中断后不算在等回复', () => {
  const b = new LineBatch(true);
  b.addLine(interruptStr(T(0), 'i0'));
  b.addLine(user('真正的第一句', T(1)));
  assert.equal(b.pending.awaiting, T(1));
  b.addLine(interruptStr(T(2), 'i1'));
  assert.equal(b.pending.awaiting, null);
  b.addLine(interruptArr(T(3), 'i2'));
  b.addLine(interruptArr(T(3), 'i2'));
  // 中断前等了多久：中断标记的时间 - 它之前最近的一条记录（文件第一条就是中断时不知道）
  assert.deepEqual(
    b.interrupts.map((x) => [x.key, x.waitMs]),
    [
      ['i0', null],
      ['i1', 60_000],
      ['i2', 60_000],
    ],
  );
  assert.equal(b.session.firstPrompt, '真正的第一句');
  assert.ok(!JSON.stringify(b.interrupts).includes('Request'), '不保留内容');
});

test('解析：是否在等回复——用户消息和工具结果之后在等；回复、本地命令输出、压缩摘要之后不在等；isMeta 不改变状态；等工具结果时交给 pending 判定', () => {
  const b = new LineBatch(true);
  b.addLine(user('<command-name>/model</command-name>', T(0)));
  assert.equal(b.pending.awaiting, T(0));
  b.addLine(user('<local-command-stdout>Set model to opus</local-command-stdout>', T(0, 1)));
  assert.equal(b.pending.awaiting, null);
  b.addLine(user('你好', T(1)));
  b.addLine(user('<system-reminder>x</system-reminder>', T(1, 1), { isMeta: true }));
  assert.equal(b.pending.awaiting, T(1), 'isMeta 不改变状态');
  b.addLine(block('a1', T(2), 5, undefined, [{ id: 't1', name: 'Bash' }]));
  assert.equal(b.pending.awaiting, null);
  assert.deepEqual(b.pending.ids, ['t1']);
  b.addLine(toolResult({ toolUseId: 't1', result: {}, ts: T(3) }));
  assert.equal(b.pending.awaiting, T(3));
  assert.deepEqual(b.pending.ids, []);
  b.addLine(user('summary', T(4), { isCompactSummary: true }));
  assert.equal(b.pending.awaiting, null);
  // 状态经 JSON 存进 files.pending_tools，跨增量读取延续
  const restored = parsePending(JSON.stringify(b.pending));
  assert.equal(restored.anchor, T(4));
  assert.equal(restored.reply, 'a1');
  assert.equal(parsePending('{"msg":null,"ids":[]}').anchor, null, '旧格式没有这些字段');
});

function writeLogs() {
  fs.writeFileSync(
    mainFile,
    [
      user('写一个页面', T(0)),
      interruptStr(T(3), 'int-1'),
      user('继续', T(4)),
      interruptArr(T(5), 'int-2'),
      user('继续写', T(10)),
      block('m1', T(16, 8), 43_616),
      block('m1', T(17), 43_616, undefined, [{ id: 'tuA', name: 'Agent' }]),
      toolResult({ toolUseId: 'tuA', result: { status: 'completed', agentId: 'sub1', agentType: 'Explore', totalDurationMs: 60_000 }, ts: T(20) }),
      block('m2', T(20, 30), 800),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(subDir, 'agent-sub1.jsonl'),
    [
      JSON.stringify({ type: 'user', uuid: 's0', agentId: 'sub1', timestamp: T(17, 1), message: { role: 'user', content: '去看看' } }),
      block('s1', T(17, 11), 300, 'sub1', [{ id: 'tuS', name: 'Read' }]),
      toolResult({ toolUseId: 'tuS', result: {}, ts: T(17, 12) }),
      block('s2', T(19, 42), 9000, 'sub1'),
    ].join('\n') + '\n',
  );
}

const newAnalyzer = (store: Store, indexer: Indexer) => new Analyzer(store, indexer, new Pricing(), new Desktop(), new PresetStore());

test('端到端：主会话和子 agent 文件里的回复各算各的；中断次数；从头重读不重复计数', async () => {
  writeLogs();
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.fullScan();
  const check = () => {
    const d = newAnalyzer(store, indexer).sessionDetail(sid)!;
    const main = d.agents.find((n) => n.id === 'main')!;
    const sub = d.agents.find((n) => n.id === 'sub1')!;
    assert.deepEqual(main.replyWait, {
      replies: 2,
      slowReplies: 1,
      longest: { waitMs: 6 * 60_000 + 8_000, durationMs: 7 * 60_000, outputTokens: 43_616, at: T(16, 8) },
    });
    assert.deepEqual(d.summary.replyWait, main.replyWait);
    assert.equal(d.summary.interrupts, 2);
    assert.equal(d.summary.interruptMaxWaitMs, 3 * 60_000, '用户消息之后 3 分钟被中断');
    assert.deepEqual(sub.replyWait, {
      replies: 2,
      slowReplies: 1,
      longest: { waitMs: 2 * 60_000 + 30_000, durationMs: 2 * 60_000 + 30_000, outputTokens: 9000, at: T(19, 42) },
    });
    assert.ok(SLOW_REPLY_MS === 120_000);
    // 最后一条是回复，不在等
    assert.equal(d.summary.awaitingReply, null);
  };
  check();
  // 文件被重写（这里用重置读取进度模拟）后从头重读：去重键保证不重复计数
  store.db.exec(`UPDATE files SET offset = 0, size = -1, mtime_ms = -1, fingerprint = ''`);
  await new Indexer(store).fullScan();
  check();
  store.close();
});

// 真实日志里的形状：先调用 advisor（1 秒就有第一块），拿到结果后思考了 6 分 08 秒才写出 thinking 块；
// 之前还有一次用户消息之后 11 分钟没有任何输出、最后被中断
const H = (h: number, m: number, sec: number) => new Date(Date.UTC(2026, 8, 29, h, m, sec)).toISOString();
const advisorSession = () => [
  user('写一个页面', H(5, 14, 17)),
  interruptArr(H(5, 25, 19), 'adv-int'),
  user('继续', H(5, 26, 0)),
  block('x0', H(5, 26, 30), 90, undefined, [{ id: 'tuR', name: 'Read' }]),
  toolResult({ toolUseId: 'tuR', result: {}, ts: H(5, 31, 22) }),
  block('x1', H(5, 31, 23), 43_616), // server_tool_use（advisor）
  block('x1', H(5, 31, 52), 43_616), // advisor_tool_result
  block('x1', H(5, 38, 0), 43_616), // thinking：这里沉默了 6 分 08 秒
  block('x1', H(5, 39, 21), 43_616, undefined, [{ id: 'tuW', name: 'Write' }]),
];

test('解析：长思考在块和块之间时，取同一次回复里最长的一段沉默；中断前等了 11 分钟', () => {
  const b = new LineBatch(true);
  for (const l of advisorSession()) b.addLine(l);
  const x1 = b.requests.get('x1')!;
  assert.equal(x1.maxGapMs, 368_000);
  assert.equal(x1.gapTs, H(5, 38, 0));
  assert.deepEqual([x1.promptTs, x1.ts, x1.endTs], [H(5, 31, 22), H(5, 31, 23), H(5, 39, 21)]);
  assert.equal(b.requests.get('x0')!.maxGapMs, 30_000);
  assert.deepEqual(
    b.interrupts.map((x) => x.waitMs),
    [11 * 60_000 + 2_000],
  );
});

test('端到端：advisor 在前、长思考在后的回复得到约 368 秒；中断前最长等待；从头重读不重复', async () => {
  const sid5 = 'cccccccc-0000-0000-0000-000000000005';
  fs.writeFileSync(path.join(proj, `${sid5}.jsonl`), advisorSession().join('\n') + '\n');
  const store = new Store(dbPath);
  const check = async (indexer: Indexer) => {
    await indexer.fullScan();
    const s = newAnalyzer(store, indexer).sessionDetail(sid5)!.summary;
    assert.deepEqual(s.replyWait, {
      replies: 2,
      slowReplies: 1,
      longest: { waitMs: 368_000, durationMs: 7 * 60_000 + 59_000, outputTokens: 43_616, at: H(5, 38, 0) },
    });
    assert.equal(s.interrupts, 1);
    assert.equal(s.interruptMaxWaitMs, 11 * 60_000 + 2_000);
  };
  await check(new Indexer(store));
  store.db.exec(`UPDATE files SET offset = 0, size = -1, mtime_ms = -1, fingerprint = ''`);
  await check(new Indexer(store));
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM interrupts WHERE session_id = ?').get(sid5) as any).n, 1);
  store.close();
});

test('增量：等待起点和回复的一部分在上一次读取里，下一次读取接着算', async () => {
  const sid2 = 'cccccccc-0000-0000-0000-000000000002';
  const f = path.join(proj, `${sid2}.jsonl`);
  fs.writeFileSync(f, [user('问', T(30)), block('n1', T(33), 50)].join('\n') + '\n');
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.fullScan();
  // 同一次回复的后续块、下一次用户消息和回复追加到文件末尾
  fs.appendFileSync(f, [block('n1', T(34), 60), user('再问', T(35)), block('n2', T(35, 40), 70)].join('\n') + '\n');
  await indexer.fullScan();
  const row = (k: string) => store.db.prepare('SELECT prompt_ts, ts, end_ts, output FROM requests WHERE session_id = ? AND key = ?').get(sid2, k) as any;
  assert.deepEqual({ ...row('n1') }, { prompt_ts: T(30), ts: T(33), end_ts: T(34), output: 60 });
  assert.deepEqual({ ...row('n2') }, { prompt_ts: T(35), ts: T(35, 40), end_ts: T(35, 40), output: 70 });
  const w = newAnalyzer(store, indexer).sessionDetail(sid2)!.summary.replyWait;
  assert.deepEqual(w, { replies: 2, slowReplies: 1, longest: { waitMs: 3 * 60_000, durationMs: 4 * 60_000, outputTokens: 60, at: T(33) } });
  store.close();
});

test('从 v5 升级：requests 补上回复计时的四列、新建 interrupts 表，日志还在的文件重读补上；日志已被清理的文件不动', async () => {
  let store = new Store(dbPath);
  const summary = () => {
    const d = newAnalyzer(store, new Indexer(store)).sessionDetail(sid)!;
    return { wait: d.summary.replyWait, interrupts: d.summary.interrupts, interruptMaxWaitMs: d.summary.interruptMaxWaitMs };
  };
  const before = summary();
  assert.equal(before.interrupts, 2);
  const reqs = () => ({ ...(store.db.prepare('SELECT COUNT(*) AS n, SUM(output) AS o FROM requests').get() as any) });
  const reqBefore = reqs();
  store.db.prepare("INSERT INTO files (path, session_id, project_dir, agent, size, mtime_ms, offset, fingerprint, present) VALUES ('gone.jsonl', 'old', 'P', 'main', 500, 1, 500, 'fp', 0)").run();
  store.close();

  // 模拟 v5 留下的库：requests 没有这两列，没有 interrupts 表
  const raw = new DatabaseSync(dbPath);
  raw.exec(
    'ALTER TABLE requests DROP COLUMN prompt_ts; ALTER TABLE requests DROP COLUMN end_ts; ALTER TABLE requests DROP COLUMN max_gap_ms; ALTER TABLE requests DROP COLUMN gap_ts; DROP TABLE interrupts; PRAGMA user_version = 5;',
  );
  raw.close();

  store = new Store(dbPath);
  assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 6);
  const cols = (store.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(['prompt_ts', 'end_ts', 'max_gap_ms', 'gap_ts'].every((c) => cols.includes(c)));
  const files = store.db.prepare('SELECT path, offset, size, present FROM files').all().map((r) => ({ ...r })) as any[];
  for (const f of files.filter((x) => x.present === 1)) assert.deepEqual([f.offset, f.size], [0, -1], `${f.path} 重置读取进度`);
  assert.deepEqual(files.find((f) => f.path === 'gone.jsonl'), { path: 'gone.jsonl', offset: 500, size: 500, present: 0 });
  // 重读之前没有计时数据
  assert.deepEqual(summary(), { wait: { replies: 0, slowReplies: 0, longest: null }, interrupts: 0, interruptMaxWaitMs: null });
  await new Indexer(store).fullScan();
  assert.deepEqual(summary(), before, '重读后补上');
  assert.deepEqual(reqs(), reqBefore, '重读不会重复计数');
  store.close();
});

test('开发中的 v6 库缺少后加的列（max_gap_ms、gap_ts、interrupts.wait_ms）：补列后从头重读补上', async () => {
  let store = new Store(dbPath);
  const snap = () => {
    const d = newAnalyzer(store, new Indexer(store)).sessionDetail(sid)!;
    return { wait: d.summary.replyWait, interruptMaxWaitMs: d.summary.interruptMaxWaitMs };
  };
  const before = snap();
  store.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec('ALTER TABLE requests DROP COLUMN max_gap_ms; ALTER TABLE requests DROP COLUMN gap_ts; ALTER TABLE interrupts DROP COLUMN wait_ms; PRAGMA user_version = 6;');
  raw.close();
  store = new Store(dbPath);
  const present = store.db.prepare('SELECT offset, size FROM files WHERE present = 1').all() as any[];
  assert.ok(present.length > 0 && present.every((f) => f.offset === 0 && f.size === -1), '重置读取进度');
  await new Indexer(store).fullScan();
  assert.deepEqual(snap(), before);
  store.close();
  // 已经是完整的 v6 库：再打开不重置
  store = new Store(dbPath);
  assert.ok((store.db.prepare('SELECT offset FROM files WHERE present = 1').all() as any[]).every((f) => f.offset > 0));
  store.close();
});

test('正在等回复：最后一条是用户消息，30 分钟内算在等，会话算运行中并出现在实时接口；回复到了、中断了、太久没写入都不算', async () => {
  const sid3 = 'cccccccc-0000-0000-0000-000000000003';
  const f = path.join(proj, `${sid3}.jsonl`);
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const setAge = (ms: number) => {
    const t = new Date(now - ms);
    fs.utimesSync(f, t, t);
  };
  fs.writeFileSync(f, [user('第一句', iso(20 * 60_000)), block('w1', iso(19 * 60_000), 10), user('写一个页面', iso(5 * 60_000))].join('\n') + '\n');
  setAge(5 * 60_000);
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.fullScan();
  let a = newAnalyzer(store, indexer);
  let d = a.sessionDetail(sid3)!;
  assert.equal(d.summary.isActive, false, '5 分钟没有写入');
  assert.equal(d.summary.awaitingReply?.since, iso(5 * 60_000));
  assert.ok(Math.abs(d.summary.awaitingReply!.waitedMs - 5 * 60_000) < 5_000);
  assert.equal(d.agents[0].status, 'running', '在等回复的会话算运行中');
  const live = a.live().sessions.find((s) => s.sessionId === sid3);
  assert.ok(live, '出现在实时接口里');
  assert.equal(live!.mainActive, true);
  assert.equal(live!.awaitingReply?.since, iso(5 * 60_000));

  // 太久没写入：不算在等（可能已经放弃）
  const sid4 = 'cccccccc-0000-0000-0000-000000000004';
  const f4 = path.join(proj, `${sid4}.jsonl`);
  fs.writeFileSync(f4, user('没人回的一句', iso(40 * 60_000)) + '\n');
  const t4 = new Date(now - 40 * 60_000);
  fs.utimesSync(f4, t4, t4);
  await indexer.fullScan();
  a = newAnalyzer(store, indexer);
  const d4 = a.sessionDetail(sid4)!;
  assert.equal(d4.summary.awaitingReply, null);
  assert.equal(d4.agents[0].status, 'completed');
  assert.ok(!a.live().sessions.some((s) => s.sessionId === sid4));

  // 中断了：不在等，中断次数 + 1
  fs.appendFileSync(f, interruptStr(iso(60_000)) + '\n');
  setAge(60_000);
  await indexer.fullScan();
  d = newAnalyzer(store, indexer).sessionDetail(sid3)!;
  assert.equal(d.summary.awaitingReply, null);
  assert.equal(d.summary.interrupts, 1);

  // 再发一句，回复到了：不在等
  fs.appendFileSync(f, [user('继续', iso(50_000)), block('w2', iso(10_000), 20)].join('\n') + '\n');
  setAge(10_000);
  await indexer.fullScan();
  d = newAnalyzer(store, indexer).sessionDetail(sid3)!;
  assert.equal(d.summary.awaitingReply, null);
  assert.equal(d.summary.replyWait.replies, 2);
  store.close();
});

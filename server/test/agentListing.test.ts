// agent 类型清单（agent_listing_delta）的解析、增量入库、从 v3 升级。临时目录，不碰真实日志。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { LineBatch } from '../src/parser.ts';
import { assistant, cleanupTmp, tmpDir } from './helpers.ts';

const root = tmpDir();
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const proj = path.join(cfg, 'projects', 'C--proj');
const sid = 'bbbbbbbb-0000-0000-0000-000000000001';
const mainFile = path.join(proj, `${sid}.jsonl`);
const subDir = path.join(proj, sid, 'subagents');
const dbPath = path.join(home, 'agentree.db');

const delta = (ts: string, added: string[], removed: string[] = []) =>
  JSON.stringify({
    type: 'attachment',
    timestamp: ts,
    attachment: { type: 'agent_listing_delta', isInitial: removed.length === 0, addedTypes: added, addedLines: added.map((a) => `- ${a}: 这是描述文本`), removedTypes: removed, showConcurrencyNote: false },
  });

before(() => {
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.AGENTREE_HOME = home;
  process.env.AGENTREE_DESKTOP_DIR = '';
  fs.mkdirSync(subDir, { recursive: true });
});
after(() => cleanupTmp());

const rows = (store: Store) =>
  store.db.prepare('SELECT agent_type, first_added_at, last_added_at, removed_at FROM agent_listings WHERE session_id = ? ORDER BY agent_type').all(sid).map((r) => ({ ...r })) as any[];

test('解析：只取类型名，不保留 addedLines 的描述文本', () => {
  const b = new LineBatch(true);
  b.addLine(delta('2026-09-28T10:00:00.000Z', ['Explore', 'reviewer', 'reviewer'], []));
  b.addLine(delta('2026-09-28T10:05:00.000Z', [], ['Explore']));
  b.addLine(JSON.stringify({ type: 'attachment', timestamp: 'x', attachment: { type: 'agent_listing_delta', addedTypes: [], removedTypes: [] } }));
  assert.deepEqual(b.listings, [
    { ts: '2026-09-28T10:00:00.000Z', added: ['Explore', 'reviewer'], removed: [] },
    { ts: '2026-09-28T10:05:00.000Z', added: [], removed: ['Explore'] },
  ]);
  assert.ok(!JSON.stringify(b.listings).includes('描述文本'));
  assert.equal(b.isEmpty, false);
});

test('入库：主会话和子 agent 的清单都算；移除记 removed_at，再次加入清空；增量追加', async () => {
  fs.writeFileSync(
    mainFile,
    [delta('2026-09-28T10:00:00.000Z', ['general-purpose', 'Explore']), assistant({ id: 'm1', u: { o: 1 }, ts: '2026-09-28T10:00:01.000Z' }), delta('2026-09-28T10:10:00.000Z', [], ['Explore'])].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(subDir, 'agent-x1.jsonl'), [delta('2026-09-28T10:02:00.000Z', ['reviewer']), assistant({ id: 'x1', agentId: 'x1', u: { o: 1 }, ts: '2026-09-28T10:02:01.000Z' })].join('\n') + '\n');
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.fullScan();
  assert.deepEqual(rows(store), [
    { agent_type: 'Explore', first_added_at: '2026-09-28T10:00:00.000Z', last_added_at: '2026-09-28T10:00:00.000Z', removed_at: '2026-09-28T10:10:00.000Z' },
    { agent_type: 'general-purpose', first_added_at: '2026-09-28T10:00:00.000Z', last_added_at: '2026-09-28T10:00:00.000Z', removed_at: null },
    { agent_type: 'reviewer', first_added_at: '2026-09-28T10:02:00.000Z', last_added_at: '2026-09-28T10:02:00.000Z', removed_at: null },
  ]);
  // 增量：定义热加载后又加回来
  fs.appendFileSync(mainFile, delta('2026-09-28T10:20:00.000Z', ['Explore', 'writer']) + '\n');
  await indexer.fullScan();
  const r = rows(store);
  assert.deepEqual(r.find((x) => x.agent_type === 'Explore'), { agent_type: 'Explore', first_added_at: '2026-09-28T10:00:00.000Z', last_added_at: '2026-09-28T10:20:00.000Z', removed_at: null });
  assert.ok(r.some((x) => x.agent_type === 'writer'));
  store.close();
});

test('从 v3 升级：日志还在的文件重读补上清单，不重复计数；日志已被清理的文件（present = 0）不动', async () => {
  let store = new Store(dbPath);
  const before = rows(store);
  const reqs = (s: Store) => ({ ...(s.db.prepare('SELECT COUNT(*) AS n, SUM(output) AS o FROM requests WHERE session_id = ?').get(sid) as any) });
  const reqBefore = reqs(store);
  store.db.prepare("INSERT INTO files (path, session_id, project_dir, agent, size, mtime_ms, offset, fingerprint, present) VALUES ('gone.jsonl', 'old', 'P', 'main', 500, 1, 500, 'fp', 0)").run();
  store.db.prepare("INSERT INTO requests (session_id, key, agent, model, ts, output) VALUES ('old', 'k', 'main', 'claude-opus-5', '2026-08-01T00:00:00.000Z', 7)").run();
  store.close();

  // 模拟 v3 留下的库：没有清单数据
  const raw = new DatabaseSync(dbPath);
  raw.exec('DELETE FROM agent_listings; PRAGMA user_version = 3;');
  raw.close();

  store = new Store(dbPath);
  assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 5);
  const files = store.db.prepare('SELECT path, offset, size, present FROM files').all().map((r) => ({ ...r })) as any[];
  for (const f of files.filter((x) => x.present === 1)) assert.deepEqual([f.offset, f.size], [0, -1], `${f.path} 重置读取进度`);
  assert.deepEqual(files.find((f) => f.path === 'gone.jsonl'), { path: 'gone.jsonl', offset: 500, size: 500, present: 0 }, '已清理的文件不动');
  assert.deepEqual(rows(store), []);
  await new Indexer(store).fullScan();
  assert.deepEqual(rows(store), before, '重读后清单补上');
  assert.deepEqual(reqs(store), reqBefore, '重读不会重复计数');
  assert.equal((store.db.prepare("SELECT output FROM requests WHERE session_id = 'old'").get() as any).output, 7, '日志已清理的会话数据保留');
  store.close();
});

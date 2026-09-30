// 会话的项目目录取会话开始时的 cwd，中途切换目录不改变项目归属
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { assistant, cleanupTmp, tmpDir } from './helpers.ts';

const root = tmpDir();
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const proj = path.join(cfg, 'projects', 'C--proj');
const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
const mainFile = path.join(proj, `${sid}.jsonl`);
const dbPath = path.join(home, 'agentree.db');

const rec = (cwd: string, ts: string) => JSON.stringify({ type: 'user', uuid: Math.random().toString(36).slice(2), timestamp: ts, cwd, message: { role: 'user', content: 'x' } });
const cwdOf = (store: Store) => (store.db.prepare('SELECT cwd FROM sessions WHERE session_id = ?').get(sid) as { cwd: string | null }).cwd;

before(() => {
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.AGENTREE_HOME = home;
  process.env.AGENTREE_DESKTOP_DIR = '';
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
after(() => cleanupTmp());

test('同一批里目录变了：记第一次出现的目录', async () => {
  fs.writeFileSync(
    mainFile,
    [rec('C:\\proj', '2026-09-28T10:00:00.000Z'), assistant({ id: 'm1', u: { o: 1 } }), rec('C:\\proj\\server', '2026-09-28T10:01:00.000Z')].join('\n') + '\n',
  );
  const store = new Store(dbPath);
  await new Indexer(store).fullScan();
  assert.equal(cwdOf(store), 'C:\\proj');
  store.close();
});

test('之后追加的记录切换了目录：项目目录保持不变', async () => {
  fs.appendFileSync(mainFile, rec('C:\\proj\\web', '2026-09-28T10:02:00.000Z') + '\n' + assistant({ id: 'm2', u: { o: 2 } }) + '\n');
  const store = new Store(dbPath);
  await new Indexer(store).fullScan();
  assert.equal(cwdOf(store), 'C:\\proj');
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?').get(sid) as { n: number }).n, 2);
  store.close();
});

test('从旧版本升级：旧库里记的是最后一次的目录，升级后重读得到开始时的目录', async () => {
  // 模拟旧版本留下的状态：版本号 2，cwd 是最后一次的目录
  const raw = new DatabaseSync(dbPath);
  raw.exec(`UPDATE sessions SET cwd = 'C:\\proj\\web'; PRAGMA user_version = 2;`);
  raw.close();

  const store = new Store(dbPath);
  assert.equal(cwdOf(store), null, '日志还在的会话：清掉旧值，等重读');
  await new Indexer(store).fullScan();
  assert.equal(cwdOf(store), 'C:\\proj');
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?').get(sid) as { n: number }).n, 2, '重读不会重复计数');
  // 直接升级到当前版本（v4 增加了 agent_listings，同一次重读补上）
  assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
  store.close();
});

test('从旧版本升级：日志已经被清理的会话保留旧的目录', async () => {
  fs.rmSync(mainFile);
  let store = new Store(dbPath);
  await new Indexer(store).fullScan(); // 把文件标记为不存在
  store.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec(`UPDATE sessions SET cwd = 'C:\\old-value'; PRAGMA user_version = 2;`);
  raw.close();

  store = new Store(dbPath);
  assert.equal(cwdOf(store), 'C:\\old-value', '没法重读，保留旧值');
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE session_id = ?').get(sid) as { n: number }).n, 2, '已入库的数据保留');
  store.close();
});

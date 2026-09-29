// 联调补充的契约字段：ChangePlan.conflicts、ApplyResult.failed[].code / applied[].backupPath、ClaudeConfigSnapshot.projectCwds。
// 全部在临时目录下进行，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupTmp, tmpDir } from './helpers.ts';

const root = tmpDir('agentree-cfg-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const project = path.join(root, 'proj');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
fs.mkdirSync(project, { recursive: true });
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { PresetStore } = await import('../src/preset.ts');
const { sha256 } = await import('../src/config/text.ts');

const store = new Store(path.join(home, 'agentree.db'));
store.db.prepare('INSERT INTO sessions (session_id, project_dir, cwd) VALUES (?, ?, ?)').run('s1', 'P', project);
const TOKEN = 't';
const app = createApp({
  analyzer: {} as any,
  indexer: { status: {}, requestFullScan() {} } as any,
  presets: new PresetStore(),
  store,
  desktop: {} as any,
  token: TOKEN,
  staticDir: null,
});
after(() => {
  store.close();
  cleanupTmp();
});

const H = { host: '127.0.0.1:4777' };
const W = { ...H, 'x-agentree-token': TOKEN, 'content-type': 'application/json' };
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = W) {
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
const plan = async (actions: unknown[]) => (await call('POST', '/api/config/plan', { actions })).body;
const apply = async (planId: string) => (await call('POST', '/api/config/apply', { planId })).body;

const agentsDir = path.join(cfg, 'agents');
const settingsPath = path.join(cfg, 'settings.json');
const read = (p: string) => fs.readFileSync(p);
const mk = (name: string) => ({
  type: 'agent.upsert',
  scope: 'user',
  projectCwd: null,
  name,
  originalName: null,
  fields: { description: name, model: null, effort: null, tools: null },
  body: 'b',
  baseHash: null,
});

test('ChangePlan.conflicts：baseHash 对不上的文件路径（修改、改名、删除、打开后被删），其他情况为空数组', async () => {
  const f = path.join(agentsDir, 'cf.md');
  fs.writeFileSync(f, '---\nname: cf\ndescription: x\n---\n\nbody\n');
  const real = fs.realpathSync.native(f);
  const fields = { description: 'x', model: 'opus', effort: null, tools: null };
  assert.deepEqual((await plan([{ type: 'settings.mainModel', value: 'm' }])).conflicts, []);

  const up = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'cf', originalName: null, fields, body: null, baseHash: 'stale' }]);
  assert.equal(up.blocked, true);
  assert.ok(up.errors.length > 0, 'errors 里仍有中文说明');
  assert.deepEqual(up.conflicts, [real]);

  const ren = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'cf2', originalName: 'cf', fields, body: null, baseHash: 'stale' }]);
  assert.deepEqual(ren.conflicts, [real]);

  const del = await plan([{ type: 'agent.delete', filePath: f, baseHash: 'stale' }]);
  assert.equal(del.blocked, true);
  assert.deepEqual(del.conflicts, [real]);

  const other = await plan([{ ...mk('../x') }]);
  assert.equal(other.blocked, true);
  assert.deepEqual(other.conflicts, [], '其他原因的 blocked 不算冲突');

  const hash = sha256(read(f));
  fs.rmSync(f);
  assert.deepEqual((await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'cf', originalName: null, fields, body: null, baseHash: hash }])).conflicts, [real]);
  assert.deepEqual((await plan([{ type: 'agent.delete', filePath: f, baseHash: hash }])).conflicts, [real]);
});

test('ApplyResult.applied[].backupPath：修改时指向变更前字节，新建时为 null', async () => {
  fs.writeFileSync(settingsPath, '{\n  "model": "before"\n}\n');
  const before = read(settingsPath);
  const p = await plan([mk('ap1'), { type: 'settings.mainModel', value: 'after' }]);
  const r = await apply(p.id);
  assert.deepEqual(r.failed, []);
  assert.equal(r.applied.length, p.changes.length);
  const created = r.applied.find((a: any) => a.kind === 'create');
  assert.equal(created.backupPath, null);
  assert.ok(created.backupId);
  const modified = r.applied.find((a: any) => a.kind === 'modify');
  assert.ok(path.isAbsolute(modified.backupPath));
  assert.ok(modified.backupPath.endsWith(`${modified.backupId}.bak`));
  assert.ok(read(modified.backupPath).equals(before), 'backupPath 里是修改前的字节');
  // 删除时同样给出路径，内容是被删的文件
  const f = path.join(agentsDir, 'ap1.md');
  const bytes = read(f);
  const d = await apply((await plan([{ type: 'agent.delete', filePath: f, baseHash: sha256(bytes) }])).id);
  assert.ok(read(d.applied[0].backupPath).equals(bytes));
});

test('ApplyResult.failed[].code：conflict 之后的文件为 skipped，applied + failed 等于计划文件数', async () => {
  fs.writeFileSync(settingsPath, '{\n  "model": "a"\n}\n');
  const p = await plan([{ type: 'settings.mainModel', value: 'x1' }, mk('ap2'), mk('ap3')]);
  assert.equal(p.changes.length, 3);
  fs.writeFileSync(settingsPath, '{"model": "external"}');
  const r = await apply(p.id);
  assert.equal(r.applied.length + r.failed.length, p.changes.length);
  assert.deepEqual(
    r.failed.map((f: any) => [path.basename(f.filePath), f.code]),
    [
      ['settings.json', 'conflict'],
      ['ap2.md', 'skipped'],
      ['ap3.md', 'skipped'],
    ],
  );
  assert.ok(r.failed.every((f: any) => typeof f.reason === 'string' && f.reason));
  assert.ok(!fs.existsSync(path.join(agentsDir, 'ap2.md')) && !fs.existsSync(path.join(agentsDir, 'ap3.md')), '被跳过的文件确实没写');
});

test('ApplyResult.failed[].code：blocked 的计划每个文件都是 blocked', async () => {
  const p = await plan([mk('ap4'), { type: 'settings.effort', model: null, value: 'max' }]);
  assert.equal(p.blocked, true);
  const r = await apply(p.id);
  assert.equal(r.applied.length, 0);
  assert.equal(r.failed.length, p.changes.length);
  assert.ok(r.failed.every((f: any) => f.code === 'blocked'));
});

test('ApplyResult.failed[].code：只读文件 permission，目标变成目录 io，没有留下临时文件', async () => {
  const ro = path.join(agentsDir, 'ro.md');
  fs.writeFileSync(ro, '---\nname: ro\ndescription: x\n---\n');
  const p = await plan([
    { type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'ro', originalName: null, fields: { description: 'x', model: 'opus', effort: null, tools: null }, body: null, baseHash: sha256(read(ro)) },
    mk('ap5'),
  ]);
  fs.chmodSync(ro, 0o444);
  try {
    const r = await apply(p.id);
    assert.deepEqual(r.failed.map((f: any) => f.code), ['permission', 'skipped']);
    assert.equal(r.applied.length, 0);
  } finally {
    fs.chmodSync(ro, 0o644);
  }
  const q = await plan([mk('ap6')]);
  fs.mkdirSync(path.join(agentsDir, 'ap6.md'));
  const r2 = await apply(q.id);
  assert.equal(r2.failed[0].code, 'io');
  fs.rmSync(path.join(agentsDir, 'ap6.md'), { recursive: true });
  assert.deepEqual(fs.readdirSync(agentsDir).filter((n) => n.endsWith('.tmp')), [], '没有留下临时文件');
});

test('ApplyResult.failed[].code：应用时路径已不在白名单内（agents 目录被换成链接）-> not-allowed', async (t) => {
  const p = await plan([mk('na')]);
  const moved = path.join(root, 'agents-moved');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.renameSync(agentsDir, moved);
  try {
    try {
      fs.symlinkSync(elsewhere, agentsDir, 'junction');
    } catch {
      t.skip('当前环境不能创建目录链接');
      return;
    }
    const r = await apply(p.id);
    assert.equal(r.failed[0].code, 'not-allowed');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    if (fs.existsSync(agentsDir)) fs.unlinkSync(agentsDir);
    fs.renameSync(moved, agentsDir);
  }
});

test('ClaudeConfigSnapshot.projectCwds：按最近活跃排序、去重、不存在的目录不列出（也不能作为写入目标）', async () => {
  const a = path.join(root, 'projA');
  const b = path.join(root, 'projB');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const ins = store.db.prepare('INSERT INTO sessions (session_id, project_dir, cwd) VALUES (?, ?, ?)');
  const file = store.db.prepare("INSERT INTO files (path, session_id, project_dir, agent, last_ts) VALUES (?, ?, 'P', 'main', ?)");
  ins.run('sa', 'P', a);
  file.run('fa', 'sa', '2026-09-02T00:00:00.000Z');
  ins.run('sb', 'P', b);
  file.run('fb', 'sb', '2026-09-03T00:00:00.000Z');
  // 同一目录的另一种写法（Windows 上大小写不同；其他平台末尾多一个分隔符），活跃时间最新
  ins.run('sa2', 'P', process.platform === 'win32' ? a.toUpperCase() : a + path.sep);
  file.run('fa2', 'sa2', '2026-09-04T00:00:00.000Z');
  const gone = path.join(root, 'deleted-project');
  ins.run('sg', 'P', gone);
  file.run('fg', 'sg', '2026-09-05T00:00:00.000Z');
  const snap = (await call('GET', '/api/config', undefined, H)).body;
  const norm = (p: string) => path.resolve(p).toLowerCase();
  assert.deepEqual(snap.projectCwds.map(norm), [a, b, project].map(norm), '按最近活跃排序；没有活跃记录的排最后');
  assert.equal(new Set(snap.projectCwds.map(norm)).size, snap.projectCwds.length, '去重');
  assert.ok(!snap.projectCwds.map(norm).includes(norm(gone)), '不存在的目录不列出');
  const p = await plan([{ ...mk('z'), scope: 'project', projectCwd: gone }]);
  assert.equal(p.blocked, true);
});

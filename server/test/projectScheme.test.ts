// 全局方案和项目方案：存储、写入白名单、项目范围的 preset.apply、叠加、一致性检查、生效检查、接口。
// 配置目录、agentree 目录、项目目录全部是临时目录，不碰真实配置和真实项目。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistant, cleanupTmp, tmpDir, toolResult } from './helpers.ts';

const root = tmpDir('agentree-scope-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const projA = path.join(root, 'projA');
const projInner = path.join(projA, 'inner');
const projB = path.join(root, 'projB');
const projP = path.join(root, 'projP'); // 只给 planner 的单元测试用
const projQ = path.join(root, 'projQ');
for (const d of [path.join(cfg, 'agents'), projA, projInner, projB, projP, projQ]) fs.mkdirSync(d, { recursive: true });

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { Indexer } = await import('../src/indexer.ts');
const { Analyzer } = await import('../src/aggregate.ts');
const { Pricing } = await import('../src/pricing.ts');
const { Desktop } = await import('../src/desktop.ts');
const { PresetStore, projectSchemeFile, readApplied } = await import('../src/preset.ts');
const { overlayPreset, owningProject, schemeForSession } = await import('../src/conformance.ts');
const { checkWritable } = await import('../src/config/paths.ts');
const { makePlan } = await import('../src/config/planner.ts');
const { applyPlan } = await import('../src/config/applier.ts');
const { effectReport } = await import('../src/effect.ts');
type Preset = import('../../shared/types.ts').Preset;
type AppliedRecord = import('../src/preset.ts').AppliedRecord;

const store = new Store(path.join(home, 'agentree.db'));
const indexer = new Indexer(store);
const presets = new PresetStore();
const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), presets);
const TOKEN = 'tok-scope';
const app = createApp({ analyzer, indexer, presets, store, desktop: new Desktop(), token: TOKEN, staticDir: null });
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
const q = (cwd: string) => `cwd=${encodeURIComponent(cwd)}`;

const preset = (over: Partial<Preset> = {}): Preset => ({
  version: 1,
  main: { model: null, effort: null },
  advisor: { model: null },
  agents: [],
  allowBuiltins: true,
  updatedAt: null,
  ...over,
});
const agent = (name: string, model: string | null, effort: string | null = null) => ({ name, model, effort });

// 用户级的配置：项目方案的任何操作都不能动它们
const USER_SETTINGS = '{\n  "model": "claude-fable-5-1",\n  "theme": "dark"\n}\n';
const USER_MD = '# 我的全局规则\n';
const USER_AGENT = '---\nname: helper\ndescription: 全局的 helper\n---\n\n正文\n';
fs.writeFileSync(path.join(cfg, 'settings.json'), USER_SETTINGS);
fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), USER_MD);
fs.writeFileSync(path.join(cfg, 'agents', 'helper.md'), USER_AGENT);
function userSnapshot(): string {
  const files = [path.join(cfg, 'settings.json'), path.join(cfg, 'CLAUDE.md'), ...fs.readdirSync(path.join(cfg, 'agents')).map((n) => path.join(cfg, 'agents', n))];
  return files.map((f) => `${f}\n${fs.readFileSync(f).toString('base64')}`).join('\n');
}
const USER_BEFORE = userSnapshot();

// ---------------- 日志：几个项目目录下的会话 ----------------

const proj = path.join(cfg, 'projects', 'P');
fs.mkdirSync(proj, { recursive: true });
const T = Date.now() + 60_000; // 在应用之后
const iso = (ms: number) => new Date(ms).toISOString();
function writeSession(sid: string, cwd: string, t0: number, dispatchModel: string | null, listed: string[] | null = null) {
  const lines = [JSON.stringify({ type: 'user', uuid: `u-${sid}`, timestamp: iso(t0), cwd, entrypoint: 'cli', version: '9.9.9', message: { role: 'user', content: '开始' } })];
  if (listed) lines.push(JSON.stringify({ type: 'attachment', timestamp: iso(t0 + 100), attachment: { type: 'agent_listing_delta', isInitial: true, addedTypes: listed, addedLines: [], removedTypes: [] } }));
  lines.push(assistant({ id: `${sid}-m`, model: 'claude-opus-5-5', effort: 'high', ts: iso(t0 + 1000), u: { o: 1 }, toolUses: dispatchModel ? [{ id: `${sid}-t`, name: 'Agent', input: { subagent_type: 'reviewer' } }] : [] }));
  if (dispatchModel) {
    const agentId = `${sid}-a`;
    lines.push(toolResult({ toolUseId: `${sid}-t`, result: { status: 'completed', agentId, agentType: 'reviewer' }, ts: iso(t0 + 3000) }));
    const sub = path.join(proj, sid, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `agent-${agentId}.jsonl`), assistant({ id: `${agentId}-r`, agentId, model: dispatchModel, ts: iso(t0 + 2000), u: { o: 1 } }) + '\n');
    fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'reviewer', toolUseId: `${sid}-t`, spawnDepth: 1 }));
  }
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.join('\n') + '\n');
}
writeSession('sA', projA, T, 'claude-haiku-5', ['general-purpose', 'reviewer']);
writeSession('sAsub', path.join(projA, 'sub'), T + 60_000, 'claude-haiku-5');
writeSession('sInner', projInner, T + 120_000, 'claude-sonnet-5');
writeSession('sB', projB, T + 180_000, 'claude-haiku-5');
await indexer.fullScan();

// ---------------- 叠加与归属（纯函数） ----------------

test('叠加：子 agent 取并集、同名用项目的；主模型 / effort / advisor 为 null 时用全局的；allowBuiltins 用项目的', () => {
  const g = preset({ main: { model: 'claude-opus-5-5', effort: 'high' }, advisor: { model: 'fable' }, agents: [agent('reviewer', 'sonnet'), agent('explorer', 'opus')], allowBuiltins: true });
  const p = preset({ main: { model: null, effort: 'low' }, advisor: { model: null }, agents: [agent('Reviewer', 'haiku'), agent('writer', null)], allowBuiltins: false, updatedAt: 'x' });
  const o = overlayPreset(g, p);
  assert.deepEqual(o.main, { model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(o.advisor, { model: 'fable' });
  assert.deepEqual(o.agents.map((a) => [a.name, a.model]), [['Reviewer', 'haiku'], ['writer', null], ['explorer', 'opus']], '同名（不区分大小写）用项目的');
  assert.equal(o.allowBuiltins, false);
  // 项目方案是空的：等于全局方案的内容
  const e = overlayPreset(g, preset({ allowBuiltins: true }));
  assert.deepEqual([e.main, e.advisor, e.agents], [g.main, g.advisor, g.agents]);
  // 全局是空的：等于项目方案
  assert.deepEqual(overlayPreset(preset(), p).agents, p.agents);
});

test('归属：等于或在项目目录之下；嵌套时取最长；前缀相同的兄弟目录不算', () => {
  const list = [projA, projInner, projB];
  assert.equal(owningProject(projA, list), projA);
  assert.equal(owningProject(path.join(projA, 'sub', 'deeper'), list), projA);
  assert.equal(owningProject(path.join(projInner, 'x'), list), projInner, '最长匹配');
  assert.equal(owningProject(projA + '2', list), null, 'projA2 不在 projA 下');
  assert.equal(owningProject(root, list), null);
  assert.equal(owningProject(null, list), null);
  if (process.platform === 'win32') assert.equal(owningProject(projA.toUpperCase() + '\\', list), projA, 'Windows 上不区分大小写，末尾分隔符不影响');
  const g = preset({ agents: [agent('x', null)] });
  assert.deepEqual(schemeForSession(projB, g, []).ref, { scope: 'user', projectCwd: null });
  assert.deepEqual(schemeForSession(projB, preset(), []).ref, { scope: 'none', projectCwd: null });
  assert.deepEqual(schemeForSession(path.join(projA, 'sub'), preset(), [{ projectCwd: projA, preset: preset() }]).ref, { scope: 'project', projectCwd: projA });
});

// ---------------- 存储 ----------------

test('项目方案的存、取、删、列举；文件名稳定；坏文件被忽略；version 递增；全局方案不受影响', () => {
  const s = new PresetStore();
  const cwd = path.join(root, 'projX');
  const v0 = s.version;
  assert.deepEqual(s.list().map((x) => [x.scope, x.projectCwd]), [['user', null]], '全局方案排第一，即使还没保存过');
  const saved = s.save(preset({ agents: [agent('a', null)] }), cwd);
  assert.ok(saved.updatedAt);
  assert.ok(s.version > v0);
  assert.deepEqual(s.get(cwd).agents.map((a) => a.name), ['a']);
  assert.equal(s.get().agents.length, 0, '全局方案没变');
  assert.ok(!fs.existsSync(path.join(home, 'preset.json')));
  const file = projectSchemeFile(cwd);
  assert.match(path.basename(file), /^[0-9a-f]{16}\.json$/);
  assert.equal(projectSchemeFile(cwd + path.sep), file, '末尾分隔符不影响文件名');
  if (process.platform === 'win32') assert.equal(projectSchemeFile(cwd.toUpperCase()), file, 'Windows 上不区分大小写');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.projectCwd, cwd);
  assert.equal(onDisk.applied, null);
  // 应用记录存在项目方案文件里
  const rec: AppliedRecord = { appliedAt: '2026-09-01T00:00:00.000Z', includeRule: true, wrote: { model: 'x', advisorModel: null, effort: null } };
  s.setApplied(rec, cwd);
  assert.deepEqual(new PresetStore().getApplied(cwd), rec, '新实例从磁盘读回');
  assert.equal(readApplied(), null, '全局 applied.json 没写');
  // 列举：按最近保存排序
  const cwd2 = path.join(root, 'projY');
  s.save(preset(), cwd2);
  assert.deepEqual(s.list().map((x) => x.projectCwd), [null, cwd2, cwd]);
  assert.equal(s.list()[2].appliedAt, rec.appliedAt);
  assert.equal(s.list()[2].agents, 1);
  // 坏文件：忽略，不抛错
  fs.writeFileSync(path.join(home, 'presets', 'ffffffffffffffff.json'), '{ not json');
  fs.writeFileSync(path.join(home, 'presets', 'eeeeeeeeeeeeeeee.json'), JSON.stringify({ projectCwd: path.join(root, 'other'), preset: preset(), applied: null }), 'utf8');
  const fresh = new PresetStore();
  assert.deepEqual(fresh.list().map((x) => x.projectCwd), [null, cwd2, cwd], '格式不对和文件名对不上的都被忽略');
  // 删除
  const v1 = s.version;
  assert.equal(s.remove(cwd), true);
  assert.ok(s.version > v1);
  assert.ok(!fs.existsSync(file));
  assert.equal(s.remove(cwd), false);
  assert.equal(s.get(cwd).updatedAt, null, '删除后是空方案');
  s.remove(cwd2);
  for (const n of ['ffffffffffffffff.json', 'eeeeeeeeeeeeeeee.json']) fs.rmSync(path.join(home, 'presets', n));
  assert.throws(() => s.save(preset(), 'relative/dir'), /绝对路径/);
});

// ---------------- 写入白名单 ----------------

test('白名单：已知项目的 settings.local.json 和项目根的 CLAUDE.md 允许；.claude/settings.json、.claude/CLAUDE.md、未知项目、符号链接逃逸拒绝', (t) => {
  const s = checkWritable(path.join(projP, '.claude', 'settings.local.json'), [projP]);
  assert.deepEqual([s.kind, s.scope, s.projectCwd], ['settings', 'project', projP]);
  const m = checkWritable(path.join(projP, 'CLAUDE.md'), [projP]);
  assert.deepEqual([m.kind, m.scope, m.projectCwd], ['claudeMd', 'project', projP]);
  for (const bad of [
    path.join(projP, '.claude', 'settings.json'),
    path.join(projP, '.claude', 'CLAUDE.md'),
    path.join(projP, 'README.md'),
    path.join(projP, 'sub', 'CLAUDE.md'),
    path.join(projP, 'settings.local.json'),
  ]) {
    assert.throws(() => checkWritable(bad, [projP]), /不在允许写入的范围内/, bad);
  }
  assert.throws(() => checkWritable(path.join(projP, 'CLAUDE.md'), []), /不在允许写入的范围内/, '未知项目');
  assert.throws(() => checkWritable(path.join(projP, '.claude', 'settings.local.json'), [projQ]));
  // 用户级的 scope 保持 null
  assert.equal(checkWritable(path.join(cfg, 'settings.json'), [projP]).scope, null);
  // 符号链接：项目的 .claude 链接到白名单外
  const projS = path.join(root, 'projS');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(projS, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  try {
    fs.symlinkSync(elsewhere, path.join(projS, '.claude'), 'junction');
  } catch {
    t.skip('当前环境不能创建目录链接');
    return;
  }
  assert.throws(() => checkWritable(path.join(projS, '.claude', 'settings.local.json'), [projS]), /符号链接/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// ---------------- 项目范围的 preset.apply（planner） ----------------

const ctxFor = (known: string[], opts: { applied?: AppliedRecord | null; projectApplied?: (cwd: string) => AppliedRecord | null } = {}) => ({
  knownCwds: known,
  env: [],
  ccSwitchDetected: false,
  applied: opts.applied ?? null,
  projectApplied: opts.projectApplied,
});
const PROJECT_SCHEME = preset({
  main: { model: 'claude-opus-5-5', effort: 'high' },
  advisor: { model: 'fable' },
  agents: [{ ...agent('reviewer', 'haiku'), description: '改完之后审查', prompt: '你是审查员。\n' }],
});

test('项目范围：设置写到 settings.local.json（其余字节不变）、agent 写到项目的 .claude/agents、规则写到项目根的 CLAUDE.md；用户级一个字节都不变', async () => {
  const local = path.join(projP, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const LOCAL = '{\n  "permissions": {"allow": ["Bash(ls)"]},\n  "model": "sonnet"\n}\n';
  fs.writeFileSync(local, LOCAL);
  const p = makePlan([{ type: 'preset.apply', preset: PROJECT_SCHEME, projectCwd: projP, includeRule: true, prune: true }], ctxFor([projP]));
  assert.equal(p.plan.blocked, false, p.plan.errors.join());
  const byPath = new Map(p.plan.changes.map((c) => [c.filePath, c]));
  const real = (f: string) => path.join(fs.realpathSync.native(projP), path.relative(projP, f));
  assert.deepEqual([...byPath.keys()].sort(), [real(local), real(path.join(projP, '.claude', 'agents', 'reviewer.md')), real(path.join(projP, 'CLAUDE.md'))].sort());
  const s = byPath.get(real(local))!;
  assert.equal(s.kind, 'modify');
  assert.ok(s.after!.startsWith('{\n  "permissions": {"allow": ["Bash(ls)"]},\n  "model": "claude-opus-5-5"'), '其余字节不变，只替换 model 的值');
  const after = JSON.parse(s.after!);
  assert.deepEqual([after.modelSettings['claude-opus-5-5'].effortLevel, after.advisorModel], ['high', 'fable']);
  assert.equal(byPath.get(real(path.join(projP, 'CLAUDE.md')))!.kind, 'create');
  assert.equal(p.presetApply?.projectCwd, projP);
  const notes = p.plan.notes.map((n) => n.message);
  assert.ok(notes.includes(`这份方案只对在 ${projP} 下开始的会话生效。`));
  assert.ok(notes.some((n) => /agents 目录是这次新建的/.test(n)), '项目的 agents 目录是新建的');
  assert.ok(!notes.some((n) => /gitignore/.test(n)), 'settings.local.json 已存在，不提示');
  const r = await applyPlan(p, [projP]);
  assert.deepEqual(r.failed, []);
  assert.equal(userSnapshot(), USER_BEFORE, '用户级的 settings.json、CLAUDE.md、agents 一个字节都没变');
  assert.ok(fs.readFileSync(path.join(projP, '.claude', 'agents', 'reviewer.md'), 'utf8').includes('model: haiku'));
  // 再生成一次：已经一致
  assert.equal(makePlan([{ type: 'preset.apply', preset: PROJECT_SCHEME, projectCwd: projP, includeRule: true, prune: true }], ctxFor([projP])).plan.changes.length, 0);
});

test('项目范围：新建 settings.local.json 时提示加进 .gitignore；项目只有 .claude/CLAUDE.md 时仍写项目根的 CLAUDE.md', () => {
  const dotMd = path.join(projQ, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(dotMd), { recursive: true });
  fs.writeFileSync(dotMd, '# 项目里 .claude 下的规则\n');
  const p = makePlan([{ type: 'preset.apply', preset: PROJECT_SCHEME, projectCwd: projQ, includeRule: true }], ctxFor([projQ]));
  const names = p.plan.changes.map((c) => path.relative(fs.realpathSync.native(projQ), c.filePath)).sort();
  assert.deepEqual(names, [path.join('.claude', 'agents', 'reviewer.md'), path.join('.claude', 'settings.local.json'), 'CLAUDE.md'].sort());
  const local = p.plan.changes.find((c) => c.filePath.endsWith('settings.local.json'))!;
  assert.equal(local.kind, 'create');
  assert.deepEqual(Object.keys(JSON.parse(local.after!)), ['model', 'modelSettings', 'advisorModel'], '新建时只有这些键');
  assert.ok(p.plan.notes.some((n) => /gitignore/.test(n.message)));
});

test('项目范围：prune 用项目自己的应用记录；未知项目目录 blocked；不带 projectCwd 时和原来一样写用户级', () => {
  const local = path.join(projP, '.claude', 'settings.local.json');
  const noMain = preset({ agents: PROJECT_SCHEME.agents });
  const rec = (model: string): AppliedRecord => ({ appliedAt: 'x', includeRule: false, wrote: { model, advisorModel: 'fable', effort: null } });
  // 项目记录里写过 claude-opus-5-5 -> 删除；全局记录不参与
  const p = makePlan([{ type: 'preset.apply', preset: noMain, projectCwd: projP, includeRule: true, prune: true }], ctxFor([projP], { applied: null, projectApplied: () => rec('claude-opus-5-5') }));
  const c = p.plan.changes.find((x) => x.filePath.endsWith('settings.local.json'))!;
  assert.equal(JSON.parse(c.after!).model, undefined);
  assert.equal(JSON.parse(c.after!).advisorModel, undefined);
  // 只有全局记录：项目的键不删
  const g = makePlan([{ type: 'preset.apply', preset: noMain, projectCwd: projP, includeRule: true, prune: true }], ctxFor([projP], { applied: rec('claude-opus-5-5'), projectApplied: () => null }));
  assert.ok(!g.plan.changes.some((x) => x.filePath.endsWith('settings.local.json')));
  assert.equal(fs.readFileSync(local, 'utf8').includes('"model": "claude-opus-5-5"'), true, '计划不写文件');
  // 未知项目
  const u = makePlan([{ type: 'preset.apply', preset: PROJECT_SCHEME, projectCwd: path.join(root, 'nowhere'), includeRule: false }], ctxFor([projP]));
  assert.equal(u.plan.blocked, true);
  assert.match(u.plan.errors[0], /没有在索引过的会话里出现过/);
  const rel = makePlan([{ type: 'preset.apply', preset: PROJECT_SCHEME, projectCwd: 'relative', includeRule: false }], ctxFor([projP]));
  assert.equal(rel.plan.blocked, true);
  // 不带 projectCwd：写用户级
  for (const projectCwd of [undefined, null]) {
    const n = makePlan([{ type: 'preset.apply', preset: preset({ main: { model: 'opus', effort: null } }), projectCwd, includeRule: false }], ctxFor([projP]));
    assert.deepEqual(n.plan.changes.map((x) => path.basename(x.filePath)), ['settings.json']);
    assert.equal(n.presetApply?.projectCwd, null);
  }
});

// ---------------- 接口 ----------------

test('接口：/api/presets、/api/preset 的 cwd 参数（GET / PUT / DELETE）、出错情况', async () => {
  let list = (await call('GET', '/api/presets', undefined, H)).body;
  assert.deepEqual(list.map((x: any) => [x.scope, x.projectCwd]), [['user', null]]);
  const put = await call('PUT', `/api/preset?${q(projA)}`, preset({ agents: [agent('reviewer', 'haiku')] }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.ok(put.body.updatedAt);
  assert.deepEqual((await call('GET', `/api/preset?${q(projA)}`, undefined, H)).body, put.body);
  assert.equal((await call('GET', '/api/preset', undefined, H)).body.agents.length, 0, '不带 cwd 是全局方案');
  assert.equal((await call('GET', '/api/preset?cwd=', undefined, H)).body.agents.length, 0, 'cwd 为空字符串当作没带');
  list = (await call('GET', '/api/presets', undefined, H)).body;
  assert.deepEqual(list.map((x: any) => [x.scope, x.projectCwd, x.agents]), [['user', null, 0], ['project', projA, 1]]);
  // 出错
  assert.equal((await call('PUT', '/api/preset?cwd=relative', preset())).status, 400);
  const unknown = await call('PUT', `/api/preset?${q(path.join(root, 'unknown'))}`, preset());
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /没有在索引过的会话里出现过/);
  assert.equal((await call('GET', '/api/preset?cwd=relative', undefined, H)).status, 400);
  assert.equal((await call('DELETE', '/api/preset')).status, 400, '不能删全局方案');
  assert.equal((await call('DELETE', `/api/preset?${q(projB)}`)).status, 404);
  assert.equal((await app.request(`/api/preset?${q(projA)}`, { method: 'DELETE', headers: { ...H, 'content-type': 'application/json' } })).status, 403, '没带令牌');
  // 删除只删 agentree 的记录
  const tmp = await call('PUT', `/api/preset?${q(projB)}`, preset());
  assert.equal(tmp.status, 200);
  const del = await call('DELETE', `/api/preset?${q(projB)}`);
  assert.deepEqual([del.status, del.body], [200, { ok: true }]);
  assert.deepEqual((await call('GET', '/api/presets', undefined, H)).body.map((x: any) => x.projectCwd), [null, projA]);
});

test('接口：from-config?cwd 只读这个项目自己的配置；/api/config/rule?cwd 看项目根的 CLAUDE.md', async () => {
  fs.mkdirSync(path.join(projB, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(projB, '.claude', 'agents', 'pb.md'), '---\nname: pb\ndescription: 项目 B 的\nmodel: haiku\n---\n\n正文\n');
  fs.writeFileSync(path.join(projB, '.claude', 'settings.local.json'), JSON.stringify({ model: 'claude-opus-5-5', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } }, advisorModel: 'fable' }));
  const r = await call('POST', `/api/preset/from-config?${q(projB)}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.agents.map((a: any) => [a.name, a.model]), [['pb', 'haiku']], '不含全局的 helper');
  assert.deepEqual([r.body.main, r.body.advisor], [{ model: 'claude-opus-5-5', effort: 'xhigh' }, { model: 'fable' }]);
  assert.equal((await call('POST', `/api/preset/from-config?${q(path.join(root, 'unknown'))}`, {})).status, 400);
  fs.rmSync(path.join(projB, '.claude'), { recursive: true });

  const rule = await call('GET', `/api/config/rule?${q(projA)}`, undefined, H);
  assert.equal(rule.status, 200);
  assert.equal(rule.body.filePath, path.join(projA, 'CLAUDE.md'));
  assert.equal(rule.body.fileExists, false);
  assert.equal((await call('GET', `/api/config/rule?${q(path.join(root, 'unknown'))}`, undefined, H)).status, 400);
  assert.equal((await call('GET', '/api/config/rule', undefined, H)).body.filePath, path.join(cfg, 'CLAUDE.md'));
});

// projA 的项目方案：reviewer 用 haiku，主模型不指定（用全局的）
const SCHEME_A = preset({ main: { model: null, effort: null }, agents: [{ ...agent('reviewer', 'haiku'), description: '项目 A 的审查员', prompt: '项目 A。\n' }] });

test('接口：应用项目方案后保存的是项目方案和项目的应用记录，全局方案和全局 applied.json 不变；之后立刻检查全部一致', async () => {
  const globalBefore = (await call('GET', '/api/preset', undefined, H)).body;
  const p = await call('POST', '/api/config/plan', { actions: [{ type: 'preset.apply', preset: SCHEME_A, projectCwd: projA, includeRule: true, prune: true }] });
  assert.equal(p.body.blocked, false, p.body.errors?.join());
  assert.ok(p.body.changes.every((c: any) => c.filePath.toLowerCase().startsWith(fs.realpathSync.native(projA).toLowerCase())), '只写项目目录');
  const a = await call('POST', '/api/config/apply', { planId: p.body.id });
  assert.deepEqual(a.body.failed, []);
  assert.equal(a.body.preset.agents[0].description, '项目 A 的审查员');
  assert.deepEqual((await call('GET', `/api/preset?${q(projA)}`, undefined, H)).body, a.body.preset);
  assert.deepEqual((await call('GET', '/api/preset', undefined, H)).body, globalBefore, '全局方案没变');
  assert.equal(readApplied(), null, '全局 applied.json 没写');
  const info = (await call('GET', '/api/presets', undefined, H)).body.find((x: any) => x.projectCwd === projA);
  assert.ok(info.appliedAt);
  assert.equal(presets.getApplied(projA)?.includeRule, true);
  assert.equal(userSnapshot(), USER_BEFORE, '用户级配置一个字节都没变');

  const e = await call('POST', '/api/config/effect', { preset: a.body.preset, includeRule: true, projectCwd: projA });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.deepEqual(e.body.scheme, { scope: 'project', projectCwd: projA });
  assert.equal(e.body.appliedAt, info.appliedAt);
  for (const i of e.body.items) assert.ok(i.written.state === 'yes' || i.written.state === 'n/a', `${i.key}: ${i.written.state}`);
  assert.equal(e.body.items.find((i: any) => i.key === 'agent:reviewer').written.filePath, fs.realpathSync.native(path.join(projA, '.claude', 'agents', 'reviewer.md')));
  assert.equal((await call('POST', '/api/config/effect', { preset: SCHEME_A, includeRule: true, projectCwd: path.join(root, 'unknown') })).status, 400);
  // 不带 projectCwd：全局方案
  const g = await call('POST', '/api/config/effect', { preset: globalBefore, includeRule: false });
  assert.deepEqual(g.body.scheme, { scope: 'user', projectCwd: null });
});

// ---------------- 一致性检查 ----------------

test('一致性检查：项目目录（含子目录）下的会话按叠加方案比，别的目录按全局方案比；嵌套项目取最长匹配', async () => {
  presets.save(preset({ main: { model: 'claude-opus-5-5', effort: null }, agents: [agent('reviewer', 'sonnet')] }));
  presets.save(preset({ agents: [agent('reviewer', 'sonnet')] }), projInner);
  const byId = new Map(analyzer.sessions().map((s) => [s.id, s]));
  assert.deepEqual(byId.get('sA')!.scheme, { scope: 'project', projectCwd: projA });
  assert.deepEqual(byId.get('sAsub')!.scheme, { scope: 'project', projectCwd: projA }, '子目录归到项目方案');
  assert.deepEqual(byId.get('sInner')!.scheme, { scope: 'project', projectCwd: projInner }, '最长匹配');
  assert.deepEqual(byId.get('sB')!.scheme, { scope: 'user', projectCwd: null });
  // 同样派发 haiku 的 reviewer：projA 的方案要 haiku -> 符合；全局要 sonnet -> 不符合
  assert.equal(byId.get('sA')!.conformance.verdict, 'match');
  assert.equal(byId.get('sAsub')!.conformance.verdict, 'match');
  assert.equal(byId.get('sB')!.conformance.verdict, 'mismatch');
  assert.equal(byId.get('sInner')!.conformance.verdict, 'match', 'inner 的方案要 sonnet，实际 sonnet');
  // 项目方案没指定主模型：用全局的 claude-opus-5-5 比
  const d = analyzer.sessionDetail('sA')!;
  assert.ok(d.sessionChecks.some((c) => c.field === 'model' && c.expected === 'claude-opus-5-5' && c.level === 'ok'));
  // 方案一改，受影响的会话重新计算
  presets.save(preset({ agents: [agent('reviewer', 'opus')] }), projA);
  assert.equal(analyzer.sessions().find((s) => s.id === 'sA')!.conformance.verdict, 'mismatch');
  presets.save(SCHEME_A, projA);
});

// ---------------- 生效检查 ----------------

test('生效检查：项目范围只统计这个项目的会话（不含被更深的项目方案接管的）；全局范围排除被项目接管的项', async () => {
  const ctx = { knownCwds: [projA, projInner, projB], env: [], ccSwitchDetected: false, applied: null, projectApplied: (c: string) => presets.getApplied(c) };
  const projects = presets.listProjects().map((p) => ({ projectCwd: p.projectCwd, preset: p.preset }));
  // 项目 A：sA、sAsub（inner 归 inner 的方案，sB 不在项目里）
  const pa = effectReport({ preset: presets.get(projA), includeRule: true, projectCwd: projA }, { store, analyzer, ctx, projects });
  assert.deepEqual(pa.scheme, { scope: 'project', projectCwd: projA });
  assert.equal(pa.sessionsSince, 2);
  const rv = pa.items.find((i) => i.key === 'agent:reviewer')!;
  assert.deepEqual([rv.written.state, rv.observed.state, rv.observed.count, rv.observed.matched], ['yes', 'match', 2, 2]);
  assert.deepEqual([rv.loaded.state, rv.loaded.count, rv.loaded.lastSessionId], ['yes', 1, 'sA']);
  assert.equal(pa.items.find((i) => i.key === 'main.model')!.observed.state, 'n/a', '项目方案没指定主模型');
  // 画布上的项目方案还没保存过（projB 没有方案）：只统计 projB 下的会话
  const pb = effectReport({ preset: preset({ agents: [agent('reviewer', 'haiku')] }), includeRule: false, projectCwd: projB }, { store, analyzer, ctx, projects });
  assert.equal(pb.items.find((i) => i.key === 'agent:reviewer')!.observed.count, 1);
  assert.equal(pb.items.find((i) => i.key === 'agent:reviewer')!.written.state, 'no');

  // 全局：reviewer 在 projA、inner 被项目接管，只剩 sB；主模型没有被接管，4 个会话都算
  const g = presets.get();
  const gr = effectReport({ preset: { ...g, updatedAt: null }, includeRule: false }, { store, analyzer, ctx, projects });
  assert.deepEqual(gr.scheme, { scope: 'user', projectCwd: null });
  const grv = gr.items.find((i) => i.key === 'agent:reviewer')!;
  assert.deepEqual([grv.observed.count, grv.observed.state, grv.observed.actual[0]], [1, 'mismatch', 'claude-haiku-5']);
  assert.equal(grv.observed.lastSessionId, 'sB');
  assert.equal(gr.items.find((i) => i.key === 'main.model')!.observed.count, 4);
  // inner 的方案指定了主模型：sInner 不计入全局的主模型
  presets.save(preset({ main: { model: 'claude-opus-5-5', effort: null }, agents: [agent('reviewer', 'sonnet')] }), projInner);
  const projects2 = presets.listProjects().map((p) => ({ projectCwd: p.projectCwd, preset: p.preset }));
  const gr2 = effectReport({ preset: { ...g, updatedAt: null }, includeRule: false }, { store, analyzer, ctx, projects: projects2 });
  assert.equal(gr2.items.find((i) => i.key === 'main.model')!.observed.count, 3);
  assert.equal(userSnapshot(), USER_BEFORE);
});

// 自动压缩阈值（autoCompactWindow）：日志里的 compact_boundary 解析与统计、方案的写入 / 修改 / prune / 校验、
// 生效检查、只用一次的启动命令。临时的 CLAUDE_CONFIG_DIR 和 AGENTREE_HOME，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistant, cleanupTmp, tmpDir, userPrompt } from './helpers.ts';

const root = tmpDir('agentree-compact-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const proj = path.join(root, 'proj');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
fs.mkdirSync(proj, { recursive: true });
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { Indexer } = await import('../src/indexer.ts');
const { Analyzer } = await import('../src/aggregate.ts');
const { Pricing } = await import('../src/pricing.ts');
const { Desktop } = await import('../src/desktop.ts');
const { PresetStore, readApplied, validatePreset, writeApplied } = await import('../src/preset.ts');
const { LineBatch } = await import('../src/parser.ts');
const { makePlan, nextWrote, PLAN_COMPACT_DISABLED_NOTE } = await import('../src/config/planner.ts');
const { applyPlan } = await import('../src/config/applier.ts');
const { compactObserved, EFFECT_TEXT } = await import('../src/effect.ts');
const { launchCommand } = await import('../../shared/launch.ts');
type Preset = import('../../shared/types.ts').Preset;
type EffectReport = import('../../shared/types.ts').EffectReport;
type AppliedRecord = import('../src/preset.ts').AppliedRecord;

const store = new Store(path.join(home, 'agentree.db'));
const indexer = new Indexer(store);
const presets = new PresetStore();
const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), presets);
const TOKEN = 'tok-compact';
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
const settingsPath = path.join(cfg, 'settings.json');
const preset = (over: Partial<Preset['main']> = {}): Preset => ({
  version: 1,
  main: { model: null, effort: null, autoCompactWindow: null, ...over },
  advisor: { model: null },
  agents: [],
  allowBuiltins: true,
  updatedAt: null,
});
const record = (wrote: Partial<AppliedRecord['wrote']>): AppliedRecord => ({
  appliedAt: '2026-09-01T00:00:00.000Z',
  includeRule: false,
  wrote: { model: null, advisorModel: null, effort: null, autoCompactWindow: null, ...wrote },
});
const ctx = (o: { env?: Array<[string, string]>; applied?: AppliedRecord | null; knownCwds?: string[]; desktopOnly?: boolean } = {}) => ({
  knownCwds: o.knownCwds ?? [],
  env: (o.env ?? []).map(([name, value]) => ({ name, value, scope: 'user' as const, level: 'warn' as const, impact: '' })),
  ccSwitchDetected: false,
  applied: o.applied ?? null,
  desktopOnly: o.desktopOnly ?? false,
});
const effect = async (p: Preset, projectCwd?: string) => {
  const r = await call('POST', '/api/config/effect', { preset: p, includeRule: false, projectCwd });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as EffectReport;
};
const item = (rep: EffectReport) => rep.items.find((i) => i.key === 'main.compact')!;

// ---------------- 日志记录 ----------------

const boundary = (o: { uuid?: string; trigger?: string; preTokens?: number; ts?: string; noMeta?: boolean; agentId?: string }) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: o.uuid ?? Math.random().toString(36).slice(2),
    parentUuid: null,
    timestamp: o.ts ?? '2026-09-28T10:10:00.000Z',
    sessionId: 'S',
    agentId: o.agentId,
    content: 'Conversation compacted',
    ...(o.noMeta ? {} : { compactMetadata: { trigger: o.trigger ?? 'auto', preTokens: o.preTokens ?? 498_000 } }),
  });
const summaryMsg = (ts = '2026-09-28T10:10:01.000Z') =>
  JSON.stringify({ type: 'user', uuid: 'cs', timestamp: ts, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } });

// ---------------- 解析 ----------------

test('解析：compact_boundary 的 auto / manual / 没有 compactMetadata 三种记录；摘要消息不当成首条提示；同一批里重复的 uuid 只记一次', () => {
  const b = new LineBatch(true);
  b.addLine(summaryMsg('2026-09-28T09:00:00.000Z')); // 摘要在最前面也不能成为标题
  b.addLine(boundary({ uuid: 'c1', trigger: 'auto', preTokens: 498_000, ts: '2026-09-28T10:10:00.000Z' }));
  b.addLine(boundary({ uuid: 'c2', trigger: 'manual', preTokens: 120_000, ts: '2026-09-28T10:20:00.000Z' }));
  b.addLine(boundary({ uuid: 'c3', noMeta: true, ts: '2026-09-28T10:30:00.000Z' }));
  b.addLine(boundary({ uuid: 'c1', trigger: 'auto', preTokens: 498_000, ts: '2026-09-28T10:10:00.000Z' }));
  b.addLine(userPrompt('真正的第一句'));
  assert.deepEqual(
    b.compactions.map((c) => [c.key, c.trigger, c.preTokens, c.ts]),
    [
      ['c1', 'auto', 498_000, '2026-09-28T10:10:00.000Z'],
      ['c2', 'manual', 120_000, '2026-09-28T10:20:00.000Z'],
      ['c3', 'unknown', null, '2026-09-28T10:30:00.000Z'],
    ],
  );
  assert.equal(b.session.firstPrompt, '真正的第一句');
  assert.equal(b.isEmpty, false);
  // 字段类型不对时宽松处理：trigger 不认识记 unknown，preTokens 不是数字记 null
  const c = new LineBatch(false);
  c.addLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'x', compactMetadata: { trigger: 'weird', preTokens: '500k' } }));
  c.addLine(JSON.stringify({ type: 'system', subtype: 'something_else', uuid: 'y' }));
  assert.deepEqual(c.compactions.map((x) => [x.trigger, x.preTokens]), [['unknown', null]]);
});

const projDir = path.join(cfg, 'projects', 'C--proj');
fs.mkdirSync(projDir, { recursive: true });
const T = Date.now() + 60_000; // 会话都在应用之后
const iso = (ms: number) => new Date(ms).toISOString();
const start = (ts: string, cwd = 'C:\\proj') =>
  JSON.stringify({ type: 'user', uuid: `u-${ts}`, timestamp: ts, cwd, entrypoint: 'cli', version: '9.9.9', message: { role: 'user', content: '开始' } });

/** 写一个会话：主对话若干次压缩，可选一个子 agent 及它自己的压缩 */
function writeSession(o: { sid: string; t0: number; cwd?: string; auto?: number[]; manual?: number; sub?: { auto: number[] } }) {
  const lines = [start(iso(o.t0), o.cwd), assistant({ id: `${o.sid}-m1`, ts: iso(o.t0 + 1000), u: { i: 1, o: 1 }, toolUses: o.sub ? [{ id: `${o.sid}-t1`, name: 'Agent', input: { subagent_type: 'worker' } }] : [] })];
  (o.auto ?? []).forEach((pre, i) => lines.push(boundary({ uuid: `${o.sid}-a${i}`, trigger: 'auto', preTokens: pre, ts: iso(o.t0 + 2000 + i * 1000) }), summaryMsg(iso(o.t0 + 2001 + i * 1000))));
  for (let i = 0; i < (o.manual ?? 0); i++) lines.push(boundary({ uuid: `${o.sid}-h${i}`, trigger: 'manual', preTokens: 90_000, ts: iso(o.t0 + 9000 + i * 1000) }));
  fs.writeFileSync(path.join(projDir, `${o.sid}.jsonl`), lines.join('\n') + '\n');
  if (o.sub) {
    const agentId = `${o.sid}-w`;
    const dir = path.join(projDir, o.sid, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const sub = [assistant({ id: `${agentId}-r1`, agentId, ts: iso(o.t0 + 1500), u: { o: 1 } })];
    o.sub.auto.forEach((pre, i) => sub.push(boundary({ uuid: `${agentId}-a${i}`, trigger: 'auto', preTokens: pre, ts: iso(o.t0 + 3000 + i * 1000), agentId })));
    fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), sub.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'worker', toolUseId: `${o.sid}-t1`, spawnDepth: 1 }));
  }
}

test('入库与统计：主会话和子 agent 各记各的压缩次数；重读不重复计数；接口里带 compactions', async () => {
  writeSession({ sid: 's1', t0: T, auto: [498_000], manual: 1, sub: { auto: [180_000, 190_000] } });
  await indexer.fullScan();
  // 文件重写（内容相同，大小不变但修改时间变了）后再读一遍：去重键保证不重复
  const f = path.join(projDir, 's1.jsonl');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  await indexer.fullScan();
  const d = analyzer.sessionDetail('s1')!;
  assert.deepEqual(d.summary.compactions, { total: 2, auto: 1, manual: 1, autoPreTokens: [498_000] });
  assert.deepEqual(d.agents[0].compactions, d.summary.compactions, '会话的 compactions 就是主对话的');
  const w = d.agents.find((n) => n.id === 's1-w')!;
  assert.deepEqual(w.compactions, { total: 2, auto: 2, manual: 0, autoPreTokens: [180_000, 190_000] }, '子 agent 自己的压缩不算进主会话');
  const list = (await call('GET', '/api/sessions', undefined, H)).body as any[];
  assert.deepEqual(list.find((s) => s.id === 's1').compactions, d.summary.compactions);
  assert.equal((await call('GET', '/api/sessions/s1', undefined, H)).body.agents[0].compactions.auto, 1);
});

// ---------------- 方案校验 ----------------

test('validatePreset：磁盘上没有 autoCompactWindow 的旧方案读成 null；范围外、非整数、非数字报中文错误', () => {
  const old = { version: 1, main: { model: 'opus', effort: 'high' }, advisor: { model: null }, agents: [], allowBuiltins: true, updatedAt: null };
  assert.deepEqual(validatePreset(old).main, { model: 'opus', effort: 'high', autoCompactWindow: null });
  assert.equal(validatePreset(preset({ autoCompactWindow: 500_000 })).main.autoCompactWindow, 500_000);
  assert.equal(validatePreset({ ...preset(), main: { model: null, effort: null, autoCompactWindow: undefined } }).main.autoCompactWindow, null);
  for (const bad of [50_000, 1_000_001, 500_000.5, '500000', '500k', true]) {
    assert.throws(() => validatePreset({ ...preset(), main: { model: null, effort: null, autoCompactWindow: bad } }), /main\.autoCompactWindow 必须是 100000 到 1000000 之间的整数/, String(bad));
  }
  // 保存再读回：字段不丢
  const p = presets.save(preset({ autoCompactWindow: 800_000 }));
  assert.equal(p.main.autoCompactWindow, 800_000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'preset.json'), 'utf8')).main.autoCompactWindow, 800_000);
  presets.save(preset());
});

// ---------------- 计划：写入、修改、校验、prune ----------------

test('计划：settings.autoCompactWindow 写成数字、改值只替换值、null 删除键；范围外的值 blocked', async () => {
  fs.writeFileSync(settingsPath, '{\n  "theme": "dark",\n  "model": "sonnet"\n}\n');
  const p = makePlan([{ type: 'settings.autoCompactWindow', value: 500_000 }], ctx());
  assert.equal(p.plan.blocked, false, p.plan.errors.join());
  const c = p.plan.changes[0];
  assert.equal(c.after, '{\n  "theme": "dark",\n  "model": "sonnet",\n  "autoCompactWindow": 500000\n}\n', '数字，不加引号；其余字节不变');
  assert.equal(c.summary, '把 autoCompactWindow 设为 500000（约 500K token）');
  await applyPlan(p, []);
  const same = makePlan([{ type: 'settings.autoCompactWindow', value: 500_000 }], ctx());
  assert.equal(same.plan.changes.length, 0, '已经是这个值：不改');
  const mod = makePlan([{ type: 'settings.autoCompactWindow', value: 1_000_000 }], ctx());
  assert.equal(mod.plan.changes[0].after, '{\n  "theme": "dark",\n  "model": "sonnet",\n  "autoCompactWindow": 1000000\n}\n');
  assert.match(mod.plan.changes[0].summary, /约 1M token/);
  const del = makePlan([{ type: 'settings.autoCompactWindow', value: null }], ctx());
  assert.equal(del.plan.changes[0].after, '{\n  "theme": "dark",\n  "model": "sonnet"\n}\n');
  for (const bad of [50_000, 2_000_000, 500_000.5, '500000' as any]) {
    const b = makePlan([{ type: 'settings.autoCompactWindow', value: bad }], ctx());
    assert.equal(b.plan.blocked, true, String(bad));
    assert.match(b.plan.errors[0], /自动压缩阈值必须是 100000 到 1000000 之间的整数/);
  }
  const bp = makePlan([{ type: 'preset.apply', preset: preset({ autoCompactWindow: 50_000 }), includeRule: false }], ctx());
  assert.equal(bp.plan.blocked, true);
  assert.match(bp.plan.errors[0], /预设不合法：main\.autoCompactWindow/);
});

test('计划：autoCompactEnabled 为 false、DISABLE_AUTO_COMPACT / DISABLE_COMPACT / CLAUDE_CODE_AUTO_COMPACT_WINDOW 时提示；方案不涉及时不提示；桌面版提示', () => {
  fs.writeFileSync(settingsPath, '{\n  "autoCompactEnabled": false\n}\n');
  const p = makePlan([{ type: 'preset.apply', preset: preset({ autoCompactWindow: 500_000 }), includeRule: false }], ctx({ env: [['DISABLE_AUTO_COMPACT', '1'], ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', '300000']], desktopOnly: true }));
  const msgs = p.plan.notes.filter((n) => n.level === 'warn').map((n) => n.message);
  assert.ok(msgs.includes(PLAN_COMPACT_DISABLED_NOTE), msgs.join('\n'));
  assert.ok(msgs.some((m) => /DISABLE_AUTO_COMPACT：自动压缩被关闭/.test(m)));
  assert.ok(msgs.some((m) => /CLAUDE_CODE_AUTO_COMPACT_WINDOW：它会覆盖/.test(m)));
  assert.ok(msgs.some((m) => /桌面版是否读取配置文件里的 autoCompactWindow/.test(m)));
  const dc = makePlan([{ type: 'preset.apply', preset: preset({ autoCompactWindow: 500_000 }), includeRule: false }], ctx({ env: [['DISABLE_COMPACT', '1'], ['DISABLE_AUTO_COMPACT', '1']] }));
  const dm = dc.plan.notes.map((n) => n.message);
  assert.ok(dm.some((m) => /DISABLE_COMPACT：所有压缩都被关闭/.test(m)));
  assert.ok(!dm.some((m) => /DISABLE_AUTO_COMPACT/.test(m)), '两个都设了只提示范围更大的那个');
  // 方案没指定阈值：不提示
  const none = makePlan([{ type: 'preset.apply', preset: preset({ model: 'opus' }), includeRule: false }], ctx({ env: [['DISABLE_AUTO_COMPACT', '1']], desktopOnly: true }));
  assert.ok(!none.plan.notes.some((n) => /压缩|COMPACT/.test(n.message)), none.plan.notes.map((n) => n.message).join('\n'));
  fs.rmSync(settingsPath);
});

test('计划：preset.apply 写入并记进 applied 的 wrote；prune 只删 agentree 写过且值没变的 autoCompactWindow', async () => {
  fs.writeFileSync(settingsPath, '{\n  "model": "sonnet"\n}\n');
  const p = makePlan([{ type: 'preset.apply', preset: preset({ autoCompactWindow: 500_000 }), includeRule: false, prune: true }], ctx());
  assert.equal(p.plan.changes[0].after, '{\n  "model": "sonnet",\n  "autoCompactWindow": 500000\n}\n');
  assert.equal(p.presetApply?.wrote.autoCompactWindow, 500_000);
  await applyPlan(p, []);
  // 没有记录：不删；记录的值和现在不同：不删并提示；记录一致：删
  assert.equal(makePlan([{ type: 'preset.apply', preset: preset(), includeRule: false, prune: true }], ctx({ applied: null })).plan.changes.length, 0);
  const changed = makePlan([{ type: 'preset.apply', preset: preset(), includeRule: false, prune: true }], ctx({ applied: record({ autoCompactWindow: 300_000 }) }));
  assert.equal(changed.plan.changes.length, 0);
  assert.ok(changed.plan.notes.some((n) => n.message === 'settings.json 的 autoCompactWindow 在 agentree 写入之后被改成了 500000，这次不会动它'));
  assert.equal(changed.presetApply?.wrote.autoCompactWindow, null, '值已经不是 agentree 的：记录清掉');
  const removed = makePlan([{ type: 'preset.apply', preset: preset(), includeRule: false, prune: true }], ctx({ applied: record({ autoCompactWindow: 500_000 }) }));
  assert.equal(removed.plan.changes[0].after, '{\n  "model": "sonnet"\n}\n');
  assert.match(removed.plan.changes[0].summary, /删除 autoCompactWindow/);
  assert.ok(removed.plan.notes.some((n) => n.message === '这次会移除：settings.json 的 autoCompactWindow'));
  // 字符串 "500000" 和数字 500000 不算同一个值
  fs.writeFileSync(settingsPath, '{\n  "autoCompactWindow": "500000"\n}\n');
  assert.equal(makePlan([{ type: 'preset.apply', preset: preset(), includeRule: false, prune: true }], ctx({ applied: record({ autoCompactWindow: 500_000 }) })).plan.changes.length, 0);
  // prune 为 false 保留；nextWrote 的规则和其他键一样
  assert.equal(makePlan([{ type: 'preset.apply', preset: preset(), includeRule: false, prune: false }], ctx({ applied: record({ autoCompactWindow: 500_000 }) })).plan.changes.length, 0);
  assert.equal(nextWrote(preset(), record({ autoCompactWindow: 500_000 }), false).autoCompactWindow, 500_000);
  assert.equal(nextWrote(preset(), record({ autoCompactWindow: 500_000 }), true).autoCompactWindow, null);
  assert.equal(nextWrote(preset({ autoCompactWindow: 200_000 }), null, false).autoCompactWindow, 200_000);
  fs.rmSync(settingsPath);
});

test('计划：项目方案写到 <项目>/.claude/settings.local.json，用户级 settings.json 不动', async () => {
  const local = path.join(proj, '.claude', 'settings.local.json');
  const p = makePlan([{ type: 'preset.apply', preset: preset({ autoCompactWindow: 200_000 }), projectCwd: proj, includeRule: false }], ctx({ knownCwds: [proj] }));
  assert.equal(p.plan.blocked, false, p.plan.errors.join());
  assert.deepEqual(p.plan.changes.map((c) => c.filePath), [path.join(fs.realpathSync.native(proj), '.claude', 'settings.local.json')]);
  assert.equal(p.plan.changes[0].after, '{\n  "autoCompactWindow": 200000\n}\n');
  await applyPlan(p, [proj]);
  assert.ok(!fs.existsSync(settingsPath));
  assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).autoCompactWindow, 200_000);
  fs.rmSync(path.join(proj, '.claude'), { recursive: true });
});

// ---------------- 生效检查 ----------------

test('生效检查：compactObserved 的判定：阈值 5% 以上才压缩 -> mismatch；50% 到 105% -> match；都低于 50% 或没压缩过 -> not-seen', () => {
  const s = (sid: string, at: number, preTokens: number[]) => ({ sid, at: iso(at), preTokens });
  const w = 500_000;
  assert.equal(compactObserved(w, [], null).state, 'not-seen');
  let o = compactObserved(w, [s('a', 1, [498_000]), s('b', 2, [250_000])], null);
  assert.deepEqual([o.state, o.count, o.matched, o.actual, o.lastSessionId], ['match', 2, 2, ['498K', '250K'], 'b']);
  o = compactObserved(w, [s('a', 1, [498_000]), s('b', 2, [960_000, 970_000])], null);
  assert.deepEqual([o.state, o.count, o.matched], ['mismatch', 2, 1]);
  assert.deepEqual(o.actual, ['960K', '970K', '498K'], '超过阈值的排在前面');
  assert.equal(compactObserved(w, [s('a', 1, [525_000])], null).state, 'match', '105% 以内算附近');
  assert.equal(compactObserved(w, [s('a', 1, [526_000])], null).state, 'mismatch');
  o = compactObserved(w, [s('a', 1, [200_000])], null);
  assert.deepEqual([o.state, o.count, o.matched, o.actual], ['not-seen', 1, 0, ['200K']], '远低于阈值：看不出来');
  assert.equal(compactObserved(null, [s('a', 1, [200_000])], null).state, 'n/a');
});

test('生效检查：written 与其他键一致；observed 随会话变化：没到阈值 -> 提示等待；附近压缩 -> match；超过 -> mismatch 并列出实际值', async () => {
  const P = preset({ autoCompactWindow: 500_000 });
  let rep = await effect(P);
  let it = item(rep);
  // 还没应用过：没有统计起点，全部历史里的 s1 在阈值附近压缩过
  assert.deepEqual([it.kind, it.expected, it.written.state, it.observed.state, it.observed.lastSessionId, it.writeEffective], ['main-compact', '500K token', 'no', 'match', 's1', true]);
  assert.equal(it.summary, '还没有写入。');
  assert.equal(it.nextStep, EFFECT_TEXT.applyHint);
  // 应用
  const plan = await call('POST', '/api/config/plan', { actions: [{ type: 'preset.apply', preset: P, includeRule: false, prune: true }] });
  const applied = await call('POST', '/api/config/apply', { planId: plan.body.id });
  assert.deepEqual(applied.body.failed, []);
  assert.equal(applied.body.config.settings.autoCompactWindow, 500_000, '快照里读到了');
  assert.equal(applied.body.config.settings.autoCompactEnabled, null);
  assert.equal(readApplied()!.wrote.autoCompactWindow, 500_000);
  rep = await effect(P);
  it = item(rep);
  assert.equal(it.written.state, 'yes');
  assert.equal(it.written.actual, '500000');
  // s1（在起点之前）不算；起点之后一个会话没压缩过
  writeApplied({ ...readApplied()!, appliedAt: iso(T + 1000) });
  writeSession({ sid: 's2', t0: T + 3600_000 });
  await indexer.fullScan();
  rep = await effect(P);
  it = item(rep);
  assert.deepEqual([it.observed.state, it.observed.count], ['not-seen', 0]);
  assert.equal(it.summary, EFFECT_TEXT.compactNotReached);
  assert.equal(it.nextStep, EFFECT_TEXT.compactWait('500K'));
  // 在阈值附近压缩过
  writeSession({ sid: 's3', t0: T + 2 * 3600_000, auto: [497_500] });
  await indexer.fullScan();
  rep = await effect(P);
  it = item(rep);
  assert.deepEqual([it.observed.state, it.observed.count, it.observed.matched, it.observed.lastSessionId], ['match', 1, 1, 's3']);
  assert.equal(it.summary, EFFECT_TEXT.compactMatch(1, '498K'));
  assert.equal(it.nextStep, null);
  // 超过阈值才压缩：设置没生效
  writeSession({ sid: 's4', t0: T + 3 * 3600_000, auto: [966_000] });
  await indexer.fullScan();
  rep = await effect(P);
  it = item(rep);
  assert.deepEqual([it.observed.state, it.observed.count, it.observed.matched], ['mismatch', 2, 1]);
  assert.deepEqual(it.observed.actual, ['966K', '498K']);
  assert.equal(it.summary, EFFECT_TEXT.compactMismatch('966K', '500K'));
  // 阈值改成 1M：s4 的 966K 在 50% 到 105% 之间，s3 的 498K 低于一半（不算附近，也不算超过）
  const big = preset({ autoCompactWindow: 1_000_000 });
  it = item(await effect(big));
  assert.deepEqual([it.written.state, it.written.actual, it.observed.state, it.observed.count, it.observed.matched], ['differs', '500000', 'match', 2, 1]);
  assert.equal(it.summary, '配置文件里的自动压缩阈值是 500000，和方案不一样。');
  // 方案不指定：agentree 写过 -> extra；关闭自动压缩时给出提示
  it = item(await effect(preset()));
  assert.deepEqual([it.written.state, it.written.actual, it.observed.state], ['extra', '500000', 'n/a']);
  fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, 'utf8').replace('"autoCompactWindow": 500000', '"autoCompactWindow": 500000,\n  "autoCompactEnabled": false'));
  it = item(await effect(P));
  assert.match(it.summary, /autoCompactEnabled 为 false/);
  assert.match(it.nextStep ?? '', /改回 true/);
  // 外部因素
  const r = await call('POST', '/api/config/effect', { preset: P, includeRule: false });
  assert.ok(Array.isArray(r.body.blockers));
});

test('生效检查：项目方案只看项目的会话；全局方案不计被项目方案接管的会话', async () => {
  store.db.prepare('INSERT OR IGNORE INTO sessions (session_id, project_dir, cwd) VALUES (?, ?, ?)').run('sp', 'P', proj);
  writeSession({ sid: 'sp', t0: T + 4 * 3600_000, cwd: proj, auto: [190_000] });
  await indexer.fullScan();
  presets.save(preset({ autoCompactWindow: 200_000 }), proj);
  const pr = await effect(preset({ autoCompactWindow: 200_000 }), proj);
  assert.deepEqual(pr.scheme, { scope: 'project', projectCwd: proj });
  assert.deepEqual([item(pr).observed.state, item(pr).observed.count, item(pr).observed.lastSessionId], ['match', 1, 'sp']);
  const g = item(await effect(preset({ autoCompactWindow: 500_000 })));
  assert.ok(!['sp'].includes(g.observed.lastSessionId ?? ''), '全局方案不统计被项目接管的会话');
  assert.equal(g.observed.count, 2);
  presets.remove(proj);
});

// ---------------- 只用一次 ----------------

test('只用一次：设置了阈值时启动命令带 --autocompact <token 数>，没设置不带', () => {
  const builtin = (n: string) => n === 'Explore';
  const p = preset({ model: 'opus', effort: 'high', autoCompactWindow: 500_000 });
  assert.equal(launchCommand(p, null, builtin), 'claude --model opus --effort high --autocompact 500000');
  assert.equal(launchCommand(preset(), 'C:\\work', builtin), 'Set-Location "C:\\work"\nclaude');
  const withAgents = launchCommand({ ...p, agents: [{ name: 'Explore', model: null, effort: null }, { name: 'w', model: 'sonnet', effort: null, description: '干活', tools: 'Read, Grep', prompt: '你是 w' }] }, null, builtin);
  assert.match(withAgents, /^claude --model opus --effort high --autocompact 500000 --agents @'\n/);
  assert.deepEqual(Object.keys(JSON.parse(withAgents.split("\n").slice(1, -1).join('\n'))), ['w'], '内置类型不放进 --agents');
});

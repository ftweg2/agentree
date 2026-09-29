// 生效检查、应用后自动保存预设、模板接口。临时的 CLAUDE_CONFIG_DIR 和 AGENTREE_HOME，日志和索引都是构造的，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistant, cleanupTmp, tmpDir, toolResult } from './helpers.ts';

const root = tmpDir('agentree-effect-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { Indexer } = await import('../src/indexer.ts');
const { Analyzer } = await import('../src/aggregate.ts');
const { Pricing } = await import('../src/pricing.ts');
const { Desktop } = await import('../src/desktop.ts');
const { PresetStore, readApplied, writeApplied } = await import('../src/preset.ts');
const { EFFECT_TEXT, effectReport, effectText } = await import('../src/effect.ts');
const { agentTemplate } = await import('../src/config/templates.ts');

const store = new Store(path.join(home, 'agentree.db'));
const indexer = new Indexer(store);
const presets = new PresetStore();
const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), presets);
const TOKEN = 'tok-effect';
const app = createApp({ analyzer, indexer, presets, store, desktop: new Desktop(), token: TOKEN, staticDir: null });
after(() => {
  store.close();
  cleanupTmp();
});

const H = { host: '127.0.0.1:4777' };
const W = { ...H, 'x-agentree-token': TOKEN, 'content-type': 'application/json' };
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = W) {
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: '', body: (await res.json()) as any };
}
async function raw(method: string, url: string, body?: unknown) {
  const res = await app.request(url, { method, headers: W, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

const settingsPath = path.join(cfg, 'settings.json');
const claudeMdPath = path.join(cfg, 'CLAUDE.md');
const reviewerPath = path.join(cfg, 'agents', 'reviewer.md');
const PROMPT = 'SECRET-PROMPT 你是审查员，只读不改。\n';
const P = {
  version: 1,
  main: { model: 'claude-opus-5-5', effort: 'high', autoCompactWindow: null },
  advisor: { model: 'fable' },
  agents: [
    { name: 'reviewer', model: 'sonnet', effort: 'high', description: '改完代码之后审查', tools: 'Read, Grep', disallowedTools: 'Agent', prompt: PROMPT },
    { name: 'Explore', model: null, effort: null },
  ],
  allowBuiltins: true,
  updatedAt: null,
};
const effect = async (preset: unknown = P, includeRule = true, ruleText?: string | null) => {
  const r = await call('POST', '/api/config/effect', { preset, includeRule, ruleText });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as import('../../shared/types.ts').EffectReport;
};
const item = (rep: import('../../shared/types.ts').EffectReport, key: string) => rep.items.find((i) => i.key === key)!;

// ---------------- 日志构造 ----------------

const proj = path.join(cfg, 'projects', 'C--proj');
fs.mkdirSync(proj, { recursive: true });
const iso = (ms: number) => new Date(ms).toISOString();
const listing = (ts: string, added: string[]) =>
  JSON.stringify({ type: 'attachment', timestamp: ts, attachment: { type: 'agent_listing_delta', isInitial: true, addedTypes: added, addedLines: added.map((a) => `- ${a}: 描述`), removedTypes: [], showConcurrencyNote: false } });
const start = (ts: string, entrypoint: string) =>
  JSON.stringify({ type: 'user', uuid: `u-${ts}`, timestamp: ts, cwd: 'C:\\proj', entrypoint, version: '9.9.9', message: { role: 'user', content: '开始' } });

/** 写一个会话：主会话请求 + 可选的清单记录 + 可选的一次子 agent 派发 */
function writeSession(o: {
  sid: string;
  t0: number;
  entrypoint: string;
  model: string;
  effort: string;
  advisorModel?: string;
  advisorCalls?: number;
  listed?: string[];
  dispatch?: { type: string; model: string; effort: string };
}) {
  const lines = [start(iso(o.t0), o.entrypoint)];
  if (o.listed) lines.push(listing(iso(o.t0 + 100), o.listed));
  const iterations = [{ type: 'message' }, ...Array.from({ length: o.advisorCalls ?? 0 }, () => ({ type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 1, output_tokens: 1 }))];
  lines.push(
    assistant({
      id: `${o.sid}-m1`,
      model: o.model,
      effort: o.effort,
      advisorModel: o.advisorModel,
      ts: iso(o.t0 + 1000),
      u: { i: 1, o: 1 },
      iterations,
      toolUses: o.dispatch ? [{ id: `${o.sid}-t1`, name: 'Agent', input: { subagent_type: o.dispatch.type, description: '审查' } }] : [],
    }),
  );
  if (o.dispatch) {
    const agentId = `${o.sid}-a1`;
    lines.push(toolResult({ toolUseId: `${o.sid}-t1`, result: { status: 'completed', agentId, agentType: o.dispatch.type, totalDurationMs: 10 }, ts: iso(o.t0 + 3000) }));
    const sub = path.join(proj, o.sid, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `agent-${agentId}.jsonl`), assistant({ id: `${agentId}-r1`, agentId, model: o.dispatch.model, effort: o.dispatch.effort, ts: iso(o.t0 + 2000), u: { o: 1 } }) + '\n');
    fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: o.dispatch.type, toolUseId: `${o.sid}-t1`, spawnDepth: 1 }));
  }
  fs.writeFileSync(path.join(proj, `${o.sid}.jsonl`), lines.join('\n') + '\n');
}

const setAppliedAt = (ms: number) => writeApplied({ ...readApplied()!, appliedAt: iso(ms) });

// ---------------- 模板接口 ----------------

test('GET /api/config/agent-templates：explorer、worker、researcher，内容完整；方案模板里的 agent 带完整内容', async () => {
  const r = await call('GET', '/api/config/agent-templates', undefined, H);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((t: any) => [t.name, t.label]), [['explorer', '读代码'], ['worker', '改代码、跑测试'], ['researcher', '查文档']]);
  for (const t of r.body) {
    assert.ok(t.description && t.prompt.endsWith('\n'), t.name);
    assert.equal(t.disallowedTools, null);
  }
  assert.equal(r.body[0].tools, 'Read, Grep, Glob');
  assert.equal(r.body[1].tools, null);
  assert.match(r.body[0].prompt, /^你是代码探索员/);
  const tpl = (await call('GET', '/api/config/templates', undefined, H)).body[0];
  for (const a of tpl.preset.agents) {
    const t = agentTemplate(a.name);
    assert.deepEqual([a.description, a.tools, a.disallowedTools, a.prompt], [t.description, t.tools, t.disallowedTools, t.prompt]);
  }
  // 兜底模板：未知名字仍是占位
  assert.equal(agentTemplate('whatever').placeholder, true);
  assert.equal(agentTemplate('explorer').placeholder, false);
});

// ---------------- 接口防护 ----------------

test('POST /api/config/effect：不带令牌 403；请求体不对 400', async () => {
  const noToken = await app.request('/api/config/effect', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ preset: P, includeRule: true }) });
  assert.equal(noToken.status, 403);
  assert.equal((await call('POST', '/api/config/effect', { preset: P })).status, 400, 'includeRule 缺失');
  assert.equal((await call('POST', '/api/config/effect', { preset: { agents: 'x' }, includeRule: true })).status, 400);
});

// ---------------- 应用前后 ----------------

test('应用前：written 都是 no，agent 内置类型 n/a；返回内容里没有提示词正文；不写任何文件', async () => {
  const before = fs.readdirSync(cfg).sort();
  const r = await raw('POST', '/api/config/effect', { preset: P, includeRule: true });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('SECRET-PROMPT'), '不返回提示词正文');
  const rep = JSON.parse(r.text);
  assert.deepEqual(rep.items.map((i: any) => [i.key, i.written.state]), [
    ['main.model', 'no'],
    ['main.effort', 'no'],
    ['main.compact', 'n/a'],
    ['advisor', 'no'],
    ['rule', 'no'],
    ['agent:reviewer', 'no'],
    ['agent:Explore', 'n/a'],
  ]);
  assert.equal(item(rep, 'agent:reviewer').nextStep, EFFECT_TEXT.applyHint);
  assert.equal(item(rep, 'agent:reviewer').loaded.state, 'unknown', '还没写入：loaded 为 unknown');
  assert.equal(item(rep, 'agent:Explore').loaded.state, 'n/a');
  assert.equal(rep.appliedAt, null);
  assert.deepEqual(fs.readdirSync(cfg).sort(), before, '只读，不写文件');
  assert.ok(!fs.existsSync(path.join(home, 'applied.json')));
});

test('应用（prune）后：自动保存预设、写 applied.json；之后立刻检查，written 全部是 yes 或 n/a', async () => {
  const p = await call('POST', '/api/config/plan', { actions: [{ type: 'preset.apply', preset: P, includeRule: true, prune: true }] });
  assert.equal(p.body.blocked, false, p.body.errors?.join());
  assert.ok(p.body.notes.some((n: any) => /生效检查/.test(n.message)));
  const a = await call('POST', '/api/config/apply', { planId: p.body.id });
  assert.deepEqual(a.body.failed, []);
  assert.ok(a.body.preset, 'ApplyResult.preset 返回保存后的预设');
  assert.ok(a.body.preset.updatedAt);
  assert.equal(a.body.preset.agents[0].prompt, PROMPT);
  assert.deepEqual((await call('GET', '/api/preset', undefined, H)).body, a.body.preset, '预设已保存为检查标准');
  const rec = readApplied()!;
  assert.ok(rec.appliedAt >= a.body.preset.updatedAt);
  assert.deepEqual(rec.wrote, { model: 'claude-opus-5-5', advisorModel: 'fable', effort: { where: 'modelSettings', model: 'claude-opus-5-5', value: 'high' }, autoCompactWindow: null });
  assert.equal(rec.includeRule, true);
  assert.ok(fs.readFileSync(reviewerPath, 'utf8').includes('disallowedTools: Agent'));

  const rep = await effect();
  for (const i of rep.items) assert.ok(i.written.state === 'yes' || i.written.state === 'n/a', `${i.key}: ${i.written.state} ${i.written.diffs}`);
  assert.equal(rep.appliedAt, rec.appliedAt);
  assert.equal(rep.since, rec.appliedAt);
  const rv = item(rep, 'agent:reviewer');
  assert.equal(rv.loaded.state, 'unknown', '之后还没有会话');
  assert.equal(rv.summary, EFFECT_TEXT.agentLoadedUnknown);
  // 画布上的预设带着已保存的 updatedAt 再查一次：同样全部一致
  const again = await effect(a.body.preset);
  assert.ok(again.items.every((i) => i.written.state === 'yes' || i.written.state === 'n/a'));
});

test('不是 preset.apply 的计划：ApplyResult.preset 为 null；有失败项时不保存预设、不写 applied.json', async () => {
  const r = await call('POST', '/api/config/apply', { planId: (await call('POST', '/api/config/plan', { actions: [{ type: 'claudeMd.rule', enabled: true, text: null }] })).body.id });
  assert.equal(r.body.preset, null);

  const savedPreset = fs.readFileSync(path.join(home, 'preset.json'));
  const savedApplied = fs.readFileSync(path.join(home, 'applied.json'));
  const changed = { ...P, main: { model: 'claude-opus-5-5', effort: 'xhigh', autoCompactWindow: null } };
  const p = await call('POST', '/api/config/plan', { actions: [{ type: 'preset.apply', preset: changed, includeRule: true, prune: true }] });
  assert.equal(p.body.changes.length, 1);
  fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, 'utf8').replace('"fable"', '"opus"')); // 外部改动 -> 冲突
  const a = await call('POST', '/api/config/apply', { planId: p.body.id });
  assert.equal(a.body.failed.length, 1);
  assert.equal(a.body.preset, null);
  assert.ok(fs.readFileSync(path.join(home, 'preset.json')).equals(savedPreset), '预设没变');
  assert.ok(fs.readFileSync(path.join(home, 'applied.json')).equals(savedApplied), 'applied.json 没变');
  fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, 'utf8').replace('"opus"', '"fable"'));
});

// ---------------- observed / loaded ----------------

const T = Date.now() + 60_000; // 会话都在应用之后

test('observed：命令行会话里主模型、effort、advisor、子 agent 都符合 -> match；清单里有它 -> loaded yes', async () => {
  writeSession({ sid: 's1', t0: T, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', advisorModel: 'fable', advisorCalls: 1, listed: ['general-purpose', 'Explore', 'reviewer'], dispatch: { type: 'reviewer', model: 'claude-sonnet-5', effort: 'high' } });
  await indexer.fullScan();
  const rep = await effect();
  assert.equal(rep.sessionsSince, 1);
  assert.equal(rep.lastEntrypoint, 'cli');
  const mm = item(rep, 'main.model');
  assert.deepEqual([mm.observed.state, mm.observed.count, mm.observed.matched, mm.writeEffective], ['match', 1, 1, true]);
  assert.equal(mm.observed.lastSessionId, 's1');
  assert.equal(item(rep, 'main.effort').observed.state, 'match');
  const adv = item(rep, 'advisor');
  assert.deepEqual([adv.observed.state, adv.observed.count], ['match', 1], 'count 是 advisor 实际调用次数');
  const rv = item(rep, 'agent:reviewer');
  assert.deepEqual([rv.observed.state, rv.observed.count, rv.observed.matched], ['match', 1, 1]);
  assert.deepEqual(rv.observed.actual, ['claude-sonnet-5']);
  assert.deepEqual([rv.loaded.state, rv.loaded.count, rv.loaded.lastSessionId], ['yes', 1, 's1']);
  assert.equal(rv.summary, '已生效。之后被派发 1 次，模型和 effort 都符合。');
  assert.equal(rv.nextStep, null);
  const ex = item(rep, 'agent:Explore');
  assert.equal(ex.loaded.state, 'n/a');
  assert.equal(ex.writeEffective, true);
});

test('observed：之后只有桌面版会话 -> 主模型 / effort 写入无效，给出选择器提示；advisor 标注等于主模型按 mismatch；清单里没有 -> loaded no', async () => {
  writeSession({ sid: 's2', t0: T + 3600_000, entrypoint: 'claude-desktop', model: 'claude-fable-5-1', effort: 'medium', advisorModel: 'claude-fable-5-1', listed: ['general-purpose', 'Explore'] });
  await indexer.fullScan();
  setAppliedAt(T + 1800_000); // 起点在 s1 和 s2 之间
  const rep = await effect();
  assert.equal(rep.sessionsSince, 1);
  assert.equal(rep.lastEntrypoint, 'claude-desktop');
  const mm = item(rep, 'main.model');
  assert.equal(mm.writeEffective, false);
  assert.equal(mm.written.state, 'yes', 'written 照实给');
  assert.equal(mm.observed.state, 'mismatch');
  assert.equal(mm.summary, EFFECT_TEXT.desktopMainModel + EFFECT_TEXT.desktopRecentMismatch('claude-fable-5-1', 'claude-opus-5-5'));
  assert.equal(mm.nextStep, EFFECT_TEXT.desktopPickModel('claude-opus-5-5'));
  const me = item(rep, 'main.effort');
  assert.equal(me.writeEffective, false);
  assert.equal(me.nextStep, EFFECT_TEXT.desktopPickEffort('high'));
  const adv = item(rep, 'advisor');
  assert.equal(adv.observed.state, 'mismatch');
  assert.deepEqual(adv.observed.actual, ['claude-fable-5-1']);
  assert.equal(adv.writeEffective, true);
  assert.equal(adv.summary, EFFECT_TEXT.advisorDesktopUnverified);
  assert.equal(adv.nextStep, EFFECT_TEXT.advisorSlash('fable'));
  const rv = item(rep, 'agent:reviewer');
  assert.equal(rv.observed.state, 'not-seen', 's1 里的派发在起点之前');
  assert.equal(rv.loaded.state, 'no');
  assert.equal(rv.summary, EFFECT_TEXT.agentNotLoaded);
  assert.equal(rv.nextStep, EFFECT_TEXT.agentReopen);
});

test('observed：派发的模型不符合 -> mismatch；加载了但没派发 -> 提示点名', async () => {
  writeSession({ sid: 's3', t0: T + 7200_000, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', advisorModel: 'fable', listed: ['Explore', 'reviewer'], dispatch: { type: 'reviewer', model: 'claude-haiku-5', effort: 'high' } });
  await indexer.fullScan();
  setAppliedAt(T + 5400_000);
  let rep = await effect();
  let rv = item(rep, 'agent:reviewer');
  assert.deepEqual([rv.observed.state, rv.observed.count, rv.observed.matched], ['mismatch', 1, 0]);
  assert.equal(rv.summary, EFFECT_TEXT.agentMismatch(1, 1, 'claude-haiku-5'));
  assert.equal(rv.nextStep, EFFECT_TEXT.agentOverride);
  assert.equal(item(rep, 'main.model').writeEffective, true);
  const adv = item(rep, 'advisor');
  assert.equal(adv.observed.state, 'match');
  assert.equal(adv.summary, '已写入。之后的会话已配置了 advisor，但还没有被调用过。');

  writeSession({ sid: 's4', t0: T + 10800_000, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', listed: ['Explore', 'reviewer'] });
  await indexer.fullScan();
  setAppliedAt(T + 9000_000);
  rep = await effect();
  rv = item(rep, 'agent:reviewer');
  assert.deepEqual([rv.observed.state, rv.loaded.state, rv.loaded.count], ['not-seen', 'yes', 1]);
  assert.equal(rv.summary, EFFECT_TEXT.agentLoadedNotDispatched);
  assert.equal(rv.nextStep, EFFECT_TEXT.agentMention('reviewer'));
});

test('since：applied.json 的 appliedAt 优先，其次预设的 updatedAt，都没有统计全部历史；之后没有会话 -> not-seen', async () => {
  setAppliedAt(T + 99 * 3600_000);
  let rep = await effect();
  assert.equal(rep.sessionsSince, 0);
  assert.equal(item(rep, 'main.model').observed.state, 'not-seen');
  assert.equal(item(rep, 'main.model').writeEffective, true, '起点之后没有会话：看最近 20 个，其中有命令行会话');
  const rv = item(rep, 'agent:reviewer');
  assert.deepEqual([rv.observed.state, rv.loaded.state], ['not-seen', 'unknown']);
  assert.equal(rv.summary, EFFECT_TEXT.agentLoadedUnknown);

  const saved = fs.readFileSync(path.join(home, 'applied.json'));
  fs.rmSync(path.join(home, 'applied.json'));
  try {
    rep = await effect({ ...P, updatedAt: iso(T + 1800_000) });
    assert.equal(rep.since, iso(T + 1800_000));
    assert.equal(rep.appliedAt, null);
    assert.equal(rep.sessionsSince, 3);
    rep = await effect({ ...P, updatedAt: null });
    assert.equal(rep.since, null);
    assert.equal(rep.sessionsSince, 4);
    assert.equal(item(rep, 'main.model').observed.count, 4);
    // 没有起点：措辞不说"之后"，说"到目前为止"
    const NS = effectText(false);
    assert.equal(item(rep, 'main.model').summary, '已写入。到目前为止开始的 4 个会话里，最近一个用的正是 claude-opus-5-5。');
    const rv = item(rep, 'agent:reviewer');
    // s1 符合、s3 不符合：有不符合的就是 mismatch（不是看最近一次）；不符合的值排在前面
    assert.deepEqual([rv.observed.state, rv.observed.count, rv.observed.matched], ['mismatch', 2, 1]);
    assert.deepEqual(rv.observed.actual, ['claude-haiku-5', 'claude-sonnet-5']);
    assert.equal(rv.summary, NS.agentMismatch(2, 1, 'claude-haiku-5'));
    assert.equal(rv.summary, '到目前为止被派发 2 次，其中 1 次不符合：实际用的是 claude-haiku-5。');
    assert.equal(item(rep, 'agent:Explore').summary, 'Explore 是内置类型，不需要写入。到目前为止还没有被派发过。');
    for (const i of rep.items) assert.ok(!i.summary.includes('之后'), i.summary);
    // 没有指定模型也没有指定 effort：没什么可比的，派发过就是 match，只报次数
    rep = await effect({ ...P, updatedAt: null, agents: [{ ...P.agents[0], model: null, effort: null }] });
    const plain = item(rep, 'agent:reviewer');
    assert.deepEqual([plain.observed.state, plain.observed.matched], ['match', 2]);
    assert.equal(plain.summary, '已生效。到目前为止被派发 2 次。');
  } finally {
    fs.writeFileSync(path.join(home, 'applied.json'), saved);
  }
});

// ---------------- written 的各种状态 ----------------

test('written：differs / extra / n/a（不是 agentree 写的）；rule 的 differs 和 extra；agent 的 diffs', async () => {
  // 主模型被别人改了
  const s0 = fs.readFileSync(settingsPath, 'utf8');
  fs.writeFileSync(settingsPath, s0.replace('"model": "claude-opus-5-5"', '"model": "sonnet"'));
  let rep = await effect();
  let mm = item(rep, 'main.model');
  assert.deepEqual([mm.written.state, mm.written.actual], ['differs', 'sonnet']);
  assert.equal(mm.summary, '配置文件里的主模型是 sonnet，和方案不一样。');
  assert.equal(mm.nextStep, EFFECT_TEXT.applyHint);
  fs.writeFileSync(settingsPath, s0);

  // 方案不指定主模型：agentree 写过且值没变 -> extra；没有记录，或值在写入之后被改过 -> n/a
  const noMain = { ...P, main: { model: null, effort: null, autoCompactWindow: null }, advisor: { model: null } };
  rep = await effect(noMain);
  assert.equal(item(rep, 'main.model').written.state, 'extra');
  assert.equal(item(rep, 'main.effort').written.state, 'extra');
  assert.equal(item(rep, 'advisor').written.state, 'extra');
  const wrote0 = readApplied()!.wrote;
  for (const wrote of [
    { model: null, advisorModel: null, effort: null, autoCompactWindow: null },
    // 记录的值和现在的不同：写入之后被别的程序改过
    { model: 'claude-sonnet-5', advisorModel: 'opus', effort: { ...wrote0.effort!, value: 'low' }, autoCompactWindow: null },
  ]) {
    writeApplied({ ...readApplied()!, wrote });
    rep = await effect(noMain);
    mm = item(rep, 'main.model');
    assert.deepEqual([mm.written.state, mm.written.actual], ['n/a', 'claude-opus-5-5']);
    assert.equal(mm.summary, '方案没有指定主模型。配置文件里现在是 claude-opus-5-5，不是 agentree 写的，不会动它。');
    assert.equal(mm.nextStep, null);
    assert.equal(item(rep, 'main.effort').written.state, 'n/a');
    assert.equal(item(rep, 'advisor').summary, '方案没有指定 advisor。配置文件里现在是 fable，不是 agentree 写的，不会动它。');
    // 和"现在用 prune 点应用会不会改动"一致：prune 不动 settings.json
    const p = await call('POST', '/api/config/plan', { actions: [{ type: 'preset.apply', preset: noMain, includeRule: true, prune: true }] });
    assert.ok(!p.body.changes.some((c: any) => c.filePath.endsWith('settings.json')));
    if (wrote.model) assert.ok(p.body.notes.some((n: any) => /在 agentree 写入之后被改成了 claude-opus-5-5/.test(n.message)));
  }
  writeApplied({ ...readApplied()!, wrote: wrote0 });

  // 规则：不包含规则而文件里有 -> extra；文案不同 -> differs
  rep = await effect(P, false);
  assert.equal(item(rep, 'rule').written.state, 'extra');
  rep = await effect(P, true, '别的文案');
  assert.equal(item(rep, 'rule').written.state, 'differs');
  // 标记损坏
  const md = fs.readFileSync(claudeMdPath, 'utf8');
  fs.writeFileSync(claudeMdPath, md.replace('<!-- agentree:advisor-rule:end -->', ''));
  rep = await effect();
  assert.equal(item(rep, 'rule').written.state, 'differs');
  assert.match(item(rep, 'rule').summary, /手动处理/);
  fs.writeFileSync(claudeMdPath, md);

  // agent：工具和正文被改
  const r0 = fs.readFileSync(reviewerPath, 'utf8');
  fs.writeFileSync(reviewerPath, r0.replace('tools: Read, Grep', 'tools: Grep, Read').replace('只读不改', '随便改'));
  let res = await raw('POST', '/api/config/effect', { preset: P, includeRule: true });
  let rv = item(JSON.parse(res.text), 'agent:reviewer');
  assert.equal(rv.written.state, 'differs');
  assert.deepEqual(rv.written.diffs, ['prompt'], 'tools 只是顺序不同不算不一致');
  assert.equal(rv.summary, '定义文件里的系统提示词和方案不一样。');
  assert.ok(!res.text.includes('SECRET-PROMPT') && !res.text.includes('随便改'), '不返回正文');
  fs.writeFileSync(reviewerPath, r0.replace('tools: Read, Grep', 'tools: Read'));
  res = await raw('POST', '/api/config/effect', { preset: P, includeRule: true });
  rv = item(JSON.parse(res.text), 'agent:reviewer');
  assert.deepEqual(rv.written.diffs, ['tools']);
  fs.writeFileSync(reviewerPath, r0);
  // model 为 null 的 agent 不比较 model（应用时也不会删掉这个字段）
  rep = await effect({ ...P, agents: [{ ...P.agents[0], model: null }] });
  assert.equal(item(rep, 'agent:reviewer').written.state, 'yes');
  // 全部恢复后又是一致的
  rep = await effect();
  assert.ok(rep.items.every((i) => i.written.state === 'yes' || i.written.state === 'n/a'));
});

test('内置类型：指定了模型时全部符合才是 match；有不符合的就是 mismatch；没指定时只报次数', async () => {
  writeSession({ sid: 's5', t0: T + 20 * 3600_000, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', dispatch: { type: 'general-purpose', model: 'claude-opus-5-5', effort: 'high' } });
  writeSession({ sid: 's6', t0: T + 21 * 3600_000, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', dispatch: { type: 'general-purpose', model: 'claude-opus-5-5', effort: 'high' } });
  writeSession({ sid: 's7', t0: T + 22 * 3600_000, entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', dispatch: { type: 'general-purpose', model: 'claude-haiku-5', effort: 'high' } });
  await indexer.fullScan();
  setAppliedAt(T + 19 * 3600_000);
  const gp = (model: string | null) => ({ ...P, agents: [{ name: 'general-purpose', model, effort: null }] });
  let rep = await effect(gp('opus'));
  let g = item(rep, 'agent:general-purpose');
  assert.deepEqual([g.written.state, g.loaded.state], ['n/a', 'n/a']);
  assert.deepEqual([g.observed.state, g.observed.count, g.observed.matched], ['mismatch', 3, 2]);
  assert.deepEqual(g.observed.actual, ['claude-haiku-5', 'claude-opus-5-5'], '不符合的排在前面');
  assert.equal(g.summary, 'general-purpose 是内置类型，不需要写入。' + EFFECT_TEXT.agentMismatch(3, 1, 'claude-haiku-5'));
  assert.equal(g.nextStep, null);
  rep = await effect(gp('claude-haiku-5'));
  assert.equal(item(rep, 'agent:general-purpose').observed.state, 'mismatch', '最近一次符合也不行：要全部符合');
  rep = await effect(gp(null));
  g = item(rep, 'agent:general-purpose');
  assert.deepEqual([g.observed.state, g.observed.matched], ['match', 3]);
  assert.equal(g.summary, 'general-purpose 是内置类型，不需要写入。之后被派发 3 次。');
  // 起点挪到 s5 和 s6 之间：只统计 s6、s7
  setAppliedAt(T + 20.5 * 3600_000);
  rep = await effect(gp('opus'));
  assert.equal(item(rep, 'agent:general-purpose').observed.state, 'mismatch', 's6 符合、s7 不符合');
  setAppliedAt(T + 19 * 3600_000);
  rep = await effect({ ...P, agents: [{ name: 'general-purpose', model: 'opus', effort: 'high' }] });
  assert.equal(item(rep, 'agent:general-purpose').summary, 'general-purpose 是内置类型，不需要写入。' + EFFECT_TEXT.agentMismatch(3, 1, 'claude-haiku-5'));
  rep = await effect({ ...P, agents: [{ name: 'general-purpose', model: null, effort: 'high' }] });
  assert.equal(item(rep, 'agent:general-purpose').summary, 'general-purpose 是内置类型，不需要写入。之后被派发 3 次，effort 都符合。');
});

test('blockers：只在方案涉及时给出；设置了 CLAUDE_CODE_SUBAGENT_MODEL 且有 agent 没指定模型时提示', () => {
  const env = (pairs: Array<[string, string]>) => pairs.map(([name, value]) => ({ name, value, scope: 'user' as const, level: 'warn' as const, impact: '' }));
  const ctx = {
    knownCwds: [],
    env: env([['CLAUDE_CODE_SUBAGENT_MODEL', 'haiku'], ['CLAUDE_CODE_EFFORT_LEVEL', 'low'], ['CLAUDE_CODE_DISABLE_ADVISOR_TOOL', '1'], ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '1']]),
    ccSwitchDetected: true,
    applied: readApplied(),
  };
  const rep = effectReport({ preset: P, includeRule: true }, { store, analyzer, ctx });
  const msgs = rep.blockers.map((b) => b.message).join('\n');
  assert.match(msgs, /cc-switch/);
  assert.match(msgs, /CLAUDE_CODE_EFFORT_LEVEL/);
  assert.match(msgs, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL/);
  assert.match(msgs, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
  assert.match(msgs, /CLAUDE_CODE_SUBAGENT_MODEL（haiku）：没有指定模型的 Explore/);
  const bare = effectReport(
    { preset: { ...P, main: { model: null, effort: null, autoCompactWindow: null }, advisor: { model: null }, agents: [{ name: 'reviewer', model: 'sonnet', effort: null }] }, includeRule: false },
    { store, analyzer, ctx },
  );
  assert.deepEqual(bare.blockers.map((b) => b.message.slice(0, 20)), [
    '设置了环境变量 CLAUDE_CODE_SUBAGENT_MODEL_FORCE'.slice(0, 20),
  ], '方案不涉及的项不提示');
});

// 往下派发的模型（PresetAgent.dispatchModel）：校验、写入定义文件正文末尾的派发块、读回、生效检查、会话页的一致性检查、只用一次的启动命令；
// 以及自动压缩阈值的生效检查把子 agent 里的自动压缩算进来。临时的 CLAUDE_CONFIG_DIR 和 AGENTREE_HOME，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistant, cleanupTmp, tmpDir, toolResult } from './helpers.ts';

const root = tmpDir('agentree-dispatch-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
const agentsDir = path.join(cfg, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { Indexer } = await import('../src/indexer.ts');
const { Analyzer } = await import('../src/aggregate.ts');
const { Pricing } = await import('../src/pricing.ts');
const { Desktop } = await import('../src/desktop.ts');
const { PresetStore, validatePreset } = await import('../src/preset.ts');
const { makePlan, canDispatch } = await import('../src/config/planner.ts');
const { applyPlan } = await import('../src/config/applier.ts');
const { configSnapshot, presetFromConfig } = await import('../src/claudeConfig.ts');
const { effectText, EFFECT_TEXT } = await import('../src/effect.ts');
const { checkDispatch, subagentConformance, sameDispatchModel } = await import('../src/conformance.ts');
const { launchCommand } = await import('../../shared/launch.ts');
const { dispatchBlock, parseDispatch } = await import('../../shared/dispatch.ts');
type Preset = import('../../shared/types.ts').Preset;
type PresetAgent = import('../../shared/types.ts').PresetAgent;
type EffectReport = import('../../shared/types.ts').EffectReport;

const store = new Store(path.join(home, 'agentree.db'));
const indexer = new Indexer(store);
const presets = new PresetStore();
const analyzer = new Analyzer(store, indexer, new Pricing(), new Desktop(), presets);
const TOKEN = 'tok-dispatch';
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
const preset = (agents: PresetAgent[], main: Partial<Preset['main']> = {}): Preset => ({
  version: 1,
  main: { model: null, effort: null, autoCompactWindow: null, ...main },
  advisor: { model: null },
  agents,
  allowBuiltins: true,
  updatedAt: null,
});
const ctx = () => ({ knownCwds: [], env: [], ccSwitchDetected: false, desktopOnly: false });
const plan = (p: Preset) => {
  const r = makePlan([{ type: 'preset.apply', preset: p, includeRule: false }], ctx());
  assert.equal(r.plan.blocked, false, r.plan.errors.join());
  return r;
};
const planApply = async (p: Preset) => {
  const r = plan(p);
  const res = await applyPlan(r, []);
  assert.deepEqual(res.failed, []);
  return r.plan;
};
const agentFile = (name: string) => path.join(agentsDir, `${name}.md`);
const read = (f: string) => fs.readFileSync(f, 'utf8');
const fromConfig = async () => presetFromConfig(await configSnapshot([]), null);

// ---------------- 校验 ----------------

test('validatePreset：dispatchModel 缺失不放进对象、null 保留、字符串去空白；空字符串当作 null；非法值报中文错误', async () => {
  const v = validatePreset(
    preset([
      { name: 'a', model: null, effort: null },
      { name: 'b', model: null, effort: null, dispatchModel: null },
      { name: 'c', model: null, effort: null, dispatchModel: ' haiku ' },
      { name: 'd', model: null, effort: null, dispatchModel: 'claude-haiku-4-5-20251001' },
      { name: 'e', model: null, effort: null, dispatchModel: '  ' },
    ]),
  );
  assert.equal('dispatchModel' in v.agents[0], false);
  assert.deepEqual(
    v.agents.slice(1).map((a) => a.dispatchModel),
    [null, 'haiku', 'claude-haiku-4-5-20251001', null],
  );
  for (const bad of ['bad model', 'haiku -->', 12, {}]) {
    assert.throws(() => validatePreset(preset([{ name: 'x', model: null, effort: null, dispatchModel: bad as any }])), /agents\[0\]\.dispatchModel/);
  }
  // 接口：非法值 400；合法值原样保存
  const r = await call('PUT', '/api/preset', preset([{ name: 'x', model: null, effort: null, dispatchModel: 'a b' }]));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dispatchModel 不合法/);
  const ok = await call(
    'PUT',
    '/api/preset',
    preset([
      { name: 'x', model: null, effort: null, dispatchModel: 'haiku' },
      { name: 'y', model: null, effort: null, dispatchModel: null },
    ]),
  );
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = (await call('GET', '/api/preset', undefined, H)).body as Preset;
  assert.deepEqual(
    saved.agents.map((a) => a.dispatchModel),
    ['haiku', null],
  );
  await call('PUT', '/api/preset', preset([]));
});

test('canDispatch：disallowedTools 含 Agent 或 tools 白名单不含 Agent 时不能；Agent(a, b) 写法算含', () => {
  assert.equal(canDispatch(null, null), true);
  assert.equal(canDispatch(null, 'Agent'), false);
  assert.equal(canDispatch(null, 'Bash, Agent'), false);
  assert.equal(canDispatch('Read, Grep', null), false);
  assert.equal(canDispatch('Read, Agent', null), true);
  assert.equal(canDispatch('Read, Agent(worker, explorer)', null), true);
});

// ---------------- 写入 ----------------

test('写入：新建文件带块；换模型、删块；dispatchModel 缺失保留已有块；prompt 缺失只动块；summary 不含正文', async () => {
  const f = agentFile('worker');
  const base: PresetAgent = { name: 'worker', model: 'sonnet', effort: null, description: '干活', prompt: '你是执行者。\n', dispatchModel: 'haiku' };
  const p1 = await planApply(preset([base]));
  assert.equal(p1.changes[0].kind, 'create');
  assert.equal(read(f), `---\nname: worker\ndescription: "干活"\nmodel: sonnet\n---\n\n你是执行者。\n\n${dispatchBlock('haiku')}\n`);

  // 换模型：只替换块
  const p2 = await planApply(preset([{ ...base, dispatchModel: 'claude-haiku-4-5-20251001' }]));
  assert.match(p2.changes[0].summary, /把往下派发的模型从 haiku 改为 claude-haiku-4-5-20251001/);
  assert.doesNotMatch(p2.changes[0].summary, /系统提示词|执行者/);
  assert.equal(read(f), `---\nname: worker\ndescription: "干活"\nmodel: sonnet\n---\n\n你是执行者。\n\n${dispatchBlock('claude-haiku-4-5-20251001')}\n`);

  // dispatchModel 缺失、改提示词：块保留
  const { dispatchModel: _d, ...noDispatch } = base;
  const p3 = await planApply(preset([{ ...noDispatch, prompt: '新的提示词。\n' }]));
  assert.match(p3.changes[0].summary, /修改系统提示词/);
  assert.doesNotMatch(p3.changes[0].summary, /往下派发/);
  assert.equal(parseDispatch(read(f)).model, 'claude-haiku-4-5-20251001');
  assert.match(read(f), /\n---\n\n新的提示词。\n\n<!-- agentree:dispatch-model:start/);

  // prompt 缺失、换模型：提示词不动
  const { prompt: _p, ...noPrompt } = base;
  const p4 = await planApply(preset([{ ...noPrompt, dispatchModel: 'opus' }]));
  assert.match(p4.changes[0].summary, /往下派发的模型/);
  assert.doesNotMatch(p4.changes[0].summary, /系统提示词/);
  assert.equal(read(f), `---\nname: worker\ndescription: "干活"\nmodel: sonnet\n---\n\n新的提示词。\n\n${dispatchBlock('opus')}\n`);

  // 都缺失：不动
  const { prompt: _p2, dispatchModel: _d2, ...neither } = base;
  assert.equal(plan(preset([neither])).plan.changes.length, 0);

  // null：删块，提示词保持
  const p5 = await planApply(preset([{ ...noPrompt, dispatchModel: null }]));
  assert.match(p5.changes[0].summary, /删除往下派发的模型（原为 opus）/);
  assert.equal(read(f), `---\nname: worker\ndescription: "干活"\nmodel: sonnet\n---\n\n新的提示词。\n`);
  // 已经没有块时 null 不算改动
  assert.equal(plan(preset([{ ...noPrompt, dispatchModel: null }])).plan.changes.length, 0);
});

test('读回：from-config 的 prompt 不含块、dispatchModel 为块里的模型（没有块为 null）；原样提交再应用没有改动；agent 详情的 body 仍含块', async () => {
  const f = agentFile('reader');
  const prompt = '你是读者。\n\n- 第一条\n';
  await planApply(preset([{ name: 'reader', model: null, effort: null, description: '读', prompt, dispatchModel: 'haiku' }]));
  const back = (await fromConfig()).agents.find((a) => a.name === 'reader')!;
  assert.equal(back.dispatchModel, 'haiku');
  assert.doesNotMatch(back.prompt!, /agentree:dispatch-model/);
  assert.equal(back.prompt!.trimEnd(), prompt.trimEnd());
  assert.equal(plan(preset([back])).plan.changes.length, 0, '读出来的原样提交没有改动');
  const detail = await call('GET', `/api/config/agent?path=${encodeURIComponent(f)}`, undefined, H);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.body.endsWith(`${dispatchBlock('haiku')}\n`), 'agent 详情的 body 原样含块');

  // 没有块的文件：dispatchModel 为 null，原样提交也没有改动
  fs.writeFileSync(agentFile('plain'), '---\nname: plain\ndescription: 普通\n---\n\n普通的提示词\n');
  const plain = (await fromConfig()).agents.find((a) => a.name === 'plain')!;
  assert.deepEqual([plain.prompt, plain.dispatchModel], ['普通的提示词\n', null]);
  assert.equal(plan(preset([plain])).plan.changes.length, 0);

  // 块不在末尾（用户在后面又写了东西）：内容相同也不动
  fs.writeFileSync(agentFile('mid'), `---\nname: mid\ndescription: 中间\n---\n\n前面\n\n${dispatchBlock('sonnet')}\n\n后面\n`);
  const mid = (await fromConfig()).agents.find((a) => a.name === 'mid')!;
  assert.deepEqual([mid.prompt, mid.dispatchModel], ['前面\n\n后面\n', 'sonnet']);
  assert.equal(plan(preset([mid])).plan.changes.length, 0);
});

test('CRLF 文件：加块、换模型后全文仍是 CRLF；不能再派发时给 warn 提示但照写', async () => {
  const f = agentFile('crlf');
  fs.writeFileSync(f, '---\r\nname: crlf\r\ndescription: 老文件\r\ndisallowedTools: Agent\r\n---\r\n\r\n第一行\r\n第二行\r\n');
  const r = plan(preset([{ name: 'crlf', model: null, effort: null, dispatchModel: 'haiku' }]));
  assert.ok(r.plan.notes.some((n) => n.level === 'warn' && n.message === 'crlf 不能再派发子 agent，往下派发的模型指定用不上'));
  assert.equal((await applyPlan(r, [])).failed.length, 0);
  const text = read(f);
  assert.equal(text, `---\r\nname: crlf\r\ndescription: 老文件\r\ndisallowedTools: Agent\r\n---\r\n\r\n第一行\r\n第二行\r\n\r\n${dispatchBlock('haiku').replace(/\n/g, '\r\n')}\r\n`);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, '没有单独的 \\n');
  await planApply(preset([{ name: 'crlf', model: null, effort: null, dispatchModel: 'sonnet' }]));
  assert.doesNotMatch(read(f).replace(/\r\n/g, ''), /\n/);
  assert.equal(parseDispatch(read(f)).model, 'sonnet');

  // tools 白名单不含 Agent：同样提示；含 Agent 或没指定 dispatchModel：不提示
  const note = (a: PresetAgent) => plan(preset([a])).plan.notes.some((n) => /不能再派发子 agent/.test(n.message));
  assert.equal(note({ name: 'narrow', model: null, effort: null, tools: 'Read, Grep', dispatchModel: 'haiku' }), true);
  assert.equal(note({ name: 'wide', model: null, effort: null, tools: 'Read, Agent', dispatchModel: 'haiku' }), false);
  assert.equal(note({ name: 'narrow', model: null, effort: null, tools: 'Read, Grep' }), false);
  assert.equal(note({ name: 'narrow', model: null, effort: null, tools: 'Read, Grep', dispatchModel: null }), false);
});

// ---------------- 只用一次 ----------------

test('只用一次：--agents 里的 prompt 带派发块；没指定或 null 时不带', () => {
  const builtin = (n: string) => n === 'Explore';
  const cmd = launchCommand(
    preset([
      { name: 'w', model: 'sonnet', effort: null, description: '干活', prompt: '你是 w\n', dispatchModel: 'haiku' },
      { name: 'v', model: null, effort: null, description: '看', prompt: '你是 v', dispatchModel: null },
    ]),
    null,
    builtin,
  );
  const json = JSON.parse(cmd.split('\n').slice(1, -1).join('\n'));
  assert.equal(json.w.prompt, `你是 w\n\n${dispatchBlock('haiku')}`);
  assert.equal(json.v.prompt, '你是 v');
});

// ---------------- 生效检查 ----------------

const projDir = path.join(cfg, 'projects', 'C--proj');
fs.mkdirSync(projDir, { recursive: true });
const iso = (ms: number) => new Date(ms).toISOString();
const start = (ts: string) => JSON.stringify({ type: 'user', uuid: `u-${ts}`, timestamp: ts, cwd: 'C:\\proj', entrypoint: 'cli', version: '9.9.9', message: { role: 'user', content: '开始' } });

/**
 * 写一个会话：主会话派发 parentType（不传 model），它再往下派发若干个 Explore，每个带或不带 model 参数。
 * subCompact：父 agent 自己对话里的自动压缩（压缩前 token 数）
 */
function writeNested(o: { sid: string; t0: number; parentType: string; children: Array<string | null>; subCompact?: number[] }) {
  const pid = `${o.sid}-p`;
  const main = [
    start(iso(o.t0)),
    assistant({ id: `${o.sid}-m1`, ts: iso(o.t0 + 100), u: { i: 1, o: 1 }, toolUses: [{ id: `${o.sid}-t0`, name: 'Agent', input: { subagent_type: o.parentType, description: '干活' } }] }),
    toolResult({ toolUseId: `${o.sid}-t0`, result: { status: 'completed', agentId: pid, agentType: o.parentType, totalDurationMs: 10 }, ts: iso(o.t0 + 9000) }),
  ];
  fs.writeFileSync(path.join(projDir, `${o.sid}.jsonl`), main.join('\n') + '\n');
  const sub = path.join(projDir, o.sid, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const toolUses = o.children.map((m, i) => ({ id: `${o.sid}-t${i + 1}`, name: 'Agent', input: { subagent_type: 'Explore', description: '找', ...(m === null ? {} : { model: m }) } }));
  const parentLines = [assistant({ id: `${pid}-r1`, agentId: pid, model: 'claude-sonnet-5', ts: iso(o.t0 + 200), u: { o: 1 }, toolUses })];
  (o.subCompact ?? []).forEach((pre, i) =>
    parentLines.push(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: `${pid}-c${i}`,
        parentUuid: null,
        timestamp: iso(o.t0 + 5000 + i),
        sessionId: 'S',
        agentId: pid,
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: pre },
      }),
    ),
  );
  fs.writeFileSync(path.join(sub, `agent-${pid}.jsonl`), parentLines.join('\n') + '\n');
  fs.writeFileSync(path.join(sub, `agent-${pid}.meta.json`), JSON.stringify({ agentType: o.parentType, toolUseId: `${o.sid}-t0`, spawnDepth: 1 }));
  o.children.forEach((m, i) => {
    const cid = `${o.sid}-c${i}`;
    fs.writeFileSync(path.join(sub, `agent-${cid}.jsonl`), assistant({ id: `${cid}-r1`, agentId: cid, model: m ?? 'claude-opus-5-5', ts: iso(o.t0 + 300 + i * 100), u: { o: 1 } }) + '\n');
    fs.writeFileSync(path.join(sub, `agent-${cid}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: `${o.sid}-t${i + 1}`, spawnDepth: 2 }));
  });
}

const effect = async (p: Preset) => {
  const r = await call('POST', '/api/config/effect', { preset: p, includeRule: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as EffectReport;
};
const item = (rep: EffectReport, key: string) => rep.items.find((i) => i.key === key);
const T = effectText(false); // 这些测试的方案没有 updatedAt、也没有应用记录：统计全部历史
const LEAD: PresetAgent = { name: 'lead', model: null, effort: null, dispatchModel: 'haiku' };

test('生效检查 written：文件不存在 / 没有块 -> no；模型不同 -> differs；相同 -> yes。紧跟在 agent 项之后；没指定时没有这一项', async () => {
  const f = agentFile('lead');
  let rep = await effect(preset([LEAD, { name: 'other', model: null, effort: null }]));
  assert.deepEqual(
    rep.items.filter((i) => i.name !== null).map((i) => i.key),
    ['agent:lead', 'agent:lead:dispatch', 'agent:other'],
  );
  let d = item(rep, 'agent:lead:dispatch')!;
  assert.deepEqual([d.kind, d.name, d.expected, d.written.state, d.written.filePath, d.loaded.state, d.writeEffective], ['agent-dispatch', 'lead', 'haiku', 'no', f, 'n/a', true]);
  assert.equal(d.summary, T.dispatchNotWritten);
  assert.equal(d.nextStep, T.applyHint);
  assert.equal(item(await effect(preset([{ ...LEAD, dispatchModel: null }])), 'agent:lead:dispatch'), undefined, 'null 没有这一项');

  fs.writeFileSync(f, '---\nname: lead\ndescription: 领头\n---\n\n提示词\n');
  assert.equal(item(await effect(preset([LEAD])), 'agent:lead:dispatch')!.written.state, 'no');

  fs.writeFileSync(f, `---\nname: lead\ndescription: 领头\n---\n\n提示词\n\n${dispatchBlock('sonnet')}\n`);
  rep = await effect(preset([LEAD]));
  d = item(rep, 'agent:lead:dispatch')!;
  assert.deepEqual([d.written.state, d.written.actual, d.written.diffs], ['differs', 'sonnet', ['文件里是 sonnet，方案是 haiku']]);
  assert.equal(d.summary, T.dispatchDiffers('sonnet', 'haiku'));
  assert.equal(item(rep, 'agent:lead')!.written.state, 'yes', '派发块的差异只算在 agent-dispatch 这一项');

  await planApply(preset([LEAD]));
  rep = await effect(preset([LEAD]));
  d = item(rep, 'agent:lead:dispatch')!;
  assert.deepEqual([d.written.state, d.written.actual], ['yes', 'haiku']);
  assert.equal(d.observed.state, 'not-seen');
  assert.equal(d.summary, T.dispatchNotSeen);
  assert.equal(d.nextStep, T.dispatchWait);
  assert.match(d.nextStep!, /不是硬性限制/);
  // 方案要删块（null）时，差异算在 agent 项里
  const a = item(await effect(preset([{ ...LEAD, dispatchModel: null }])), 'agent:lead')!;
  assert.deepEqual([a.written.state, a.written.diffs], ['differs', ['dispatchModel']]);
  assert.match(a.summary, /往下派发的模型/);
});

test('生效检查 observed：别名匹配完整 ID -> match；有传别的或没传的 -> mismatch，不符合的排前面；主会话派发的不算', async () => {
  const t0 = Date.parse('2026-09-29T10:00:00.000Z');
  writeNested({ sid: 'n1', t0, parentType: 'lead', children: ['claude-haiku-4-5-20251001'] });
  await indexer.fullScan();
  let d = item(await effect(preset([LEAD])), 'agent:lead:dispatch')!;
  assert.deepEqual([d.observed.state, d.observed.count, d.observed.matched, d.observed.actual], ['match', 1, 1, ['claude-haiku-4-5-20251001']]);
  assert.equal(d.observed.lastSessionId, 'n1');
  assert.equal(d.summary, T.dispatchMatch(1, 'haiku'));
  assert.equal(d.nextStep, null);
  // 反过来：方案写完整 ID，实际传别名也算
  assert.equal(sameDispatchModel('claude-haiku-4-5-20251001', 'haiku'), true);
  assert.equal(sameDispatchModel('haiku', 'claude-haiku-4-5-20251001'), true);
  assert.equal(sameDispatchModel('haiku', 'sonnet'), false);

  writeNested({ sid: 'n2', t0: t0 + 3600_000, parentType: 'lead', children: ['sonnet', null, 'haiku', 'sonnet'] });
  await indexer.fullScan();
  d = item(await effect(preset([LEAD])), 'agent:lead:dispatch')!;
  assert.deepEqual([d.observed.state, d.observed.count, d.observed.matched], ['mismatch', 5, 2]);
  assert.deepEqual(d.observed.actual, ['sonnet', '没指定', 'claude-haiku-4-5-20251001', 'haiku']);
  assert.equal(d.observed.lastSessionId, 'n2');
  assert.equal(d.summary, T.dispatchMismatch(5, 3, 'sonnet、没指定', 'haiku'));
  assert.match(d.summary, /模型不一定照做/);
  assert.equal(d.nextStep, T.dispatchStricter);
  // 别的 agent 派发的不算
  const other = item(await effect(preset([{ ...LEAD, name: 'nobody' }])), 'agent:nobody:dispatch')!;
  assert.deepEqual([other.observed.state, other.observed.count], ['not-seen', 0]);
  assert.equal(EFFECT_TEXT.dispatchMatch(2, 'x'), '已写入。之后它派发了 2 次，都按要求传了 x。');
});

// ---------------- 会话页的一致性检查 ----------------

test('一致性检查：父 agent 指定了往下派发的模型时，子节点多一条 dispatch 检查；传对了 ok，传错或没传 warn，不会判为不符合', async () => {
  await call('PUT', '/api/preset', preset([LEAD]));
  const d1 = analyzer.sessionDetail('n1')!;
  const c1 = d1.agents.find((n) => n.id === 'n1-c0')!;
  assert.equal(c1.requestedModel, 'claude-haiku-4-5-20251001');
  const dc = c1.conformance.checks.find((c) => c.field === 'dispatch')!;
  assert.deepEqual([dc.level, dc.expected, dc.actual], ['ok', 'haiku', 'claude-haiku-4-5-20251001']);
  assert.equal(c1.conformance.verdict, 'match');
  // 主会话派发的 lead 自己没有 dispatch 检查
  assert.equal(
    d1.agents.find((n) => n.id === 'n1-p')!.conformance.checks.some((c) => c.field === 'dispatch'),
    false,
  );

  const d2 = analyzer.sessionDetail('n2')!;
  const byId = (id: string) => d2.agents.find((n) => n.id === id)!.conformance;
  const wrong = byId('n2-c0').checks.find((c) => c.field === 'dispatch')!;
  assert.deepEqual([wrong.level, wrong.actual], ['warn', 'sonnet']);
  assert.equal(wrong.message, '父 agent lead 的提示词要求派发时传 haiku，这次传的是 sonnet。这是提示词里的要求，模型不一定照做');
  const none = byId('n2-c1').checks.find((c) => c.field === 'dispatch')!;
  assert.deepEqual([none.level, none.actual], ['warn', null]);
  assert.match(none.message, /这次没传 model 参数/);
  assert.equal(byId('n2-c0').verdict, 'match', '内置类型照旧算符合，dispatch 只是 warn');
  assert.equal(d2.summary.conformance.warn >= 3, true);
  assert.notEqual(d2.summary.conformance.verdict, 'mismatch');
  await call('PUT', '/api/preset', preset([]));
});

test('一致性检查（纯函数）：方案里的 agent 被派发时也带 dispatch 检查；父节点不在方案、没指定、内置类型时没有', () => {
  const p = preset([LEAD, { name: 'child', model: 'haiku', effort: null }, { name: 'Explore', model: null, effort: null, dispatchModel: 'haiku' }]);
  const r = subagentConformance(p, { agentType: 'child', models: ['claude-haiku-4-5'], primaryModel: 'claude-haiku-4-5', efforts: [], parentAgentType: 'LEAD', requestedModel: 'haiku' }, null);
  assert.deepEqual(
    r.checks.map((c) => [c.field, c.level]),
    [
      ['agent', 'ok'],
      ['model', 'ok'],
      ['dispatch', 'ok'],
    ],
  );
  const miss = subagentConformance(p, { agentType: 'unknown', models: [], primaryModel: null, efforts: [], parentAgentType: 'lead', requestedModel: null }, null);
  assert.equal(miss.verdict, 'unplanned');
  assert.equal(miss.checks.at(-1)!.field, 'dispatch');
  assert.equal(checkDispatch(p, null, 'haiku'), null, '父节点是主会话');
  assert.equal(checkDispatch(p, 'child', 'haiku'), null, '父 agent 没指定');
  assert.equal(checkDispatch(p, 'Explore', 'sonnet'), null, '内置类型写不进定义文件');
  assert.equal(checkDispatch(p, 'stranger', 'sonnet'), null, '父 agent 不在方案里');
});

// ---------------- 自动压缩阈值：子 agent 里的压缩也算 ----------------

test('生效检查 main.compact：子 agent 自己对话里的自动压缩也算进来，summary 说明其中几次在子 agent 里', async () => {
  writeNested({ sid: 'k1', t0: Date.parse('2026-09-29T12:00:00.000Z'), parentType: 'lead', children: [], subCompact: [480_000, 495_000] });
  await indexer.fullScan();
  const d = analyzer.sessionDetail('k1')!;
  assert.equal(d.summary.compactions.auto, 0, '主对话没有压缩过');
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: 500000 }));
  const c = item(await effect(preset([], { autoCompactWindow: 500000 })), 'main.compact')!;
  assert.equal(c.written.state, 'yes');
  assert.deepEqual([c.observed.state, c.observed.count, c.observed.matched, c.observed.lastSessionId], ['match', 1, 1, 'k1']);
  assert.ok(c.summary.endsWith(T.compactSubagents(2)), c.summary);
  // 阈值更小：子 agent 超过了阈值 -> mismatch
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: 200000 }));
  const m = item(await effect(preset([], { autoCompactWindow: 200000 })), 'main.compact')!;
  assert.equal(m.observed.state, 'mismatch');
  assert.match(m.summary, /其中 2 次发生在子 agent 的对话里/);
  fs.rmSync(path.join(cfg, 'settings.json'));
});

// 预设的定义文件字段（description、tools、disallowedTools、prompt）、preset.apply 的新建 / 修改 / prune / ruleText。
// 全部在临时的 CLAUDE_CONFIG_DIR 和 AGENTREE_HOME 下进行，不碰真实配置。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

const root = tmpDir('agentree-fields-');
const cfg = path.join(root, 'claude');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = path.join(root, 'home');
process.env.AGENTREE_DESKTOP_DIR = '';
const agentsDir = path.join(cfg, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { validatePreset, readApplied, writeApplied } = await import('../src/preset.ts');
const { makePlan, nextWrote } = await import('../src/config/planner.ts');
const { agentTemplate } = await import('../src/config/templates.ts');
const { parseJsonDoc, removeValue } = await import('../src/config/jsonEdit.ts');
const { applyPlan } = await import('../src/config/applier.ts');
type AppliedRecord = import('../src/preset.ts').AppliedRecord;

const settingsPath = path.join(cfg, 'settings.json');
const claudeMdPath = path.join(cfg, 'CLAUDE.md');
const appliedFile = path.join(root, 'home', 'applied.json');

const ctx = (applied: AppliedRecord | null = null) => ({ knownCwds: [], env: [], ccSwitchDetected: false, applied });
const preset = (over: Record<string, unknown> = {}) => ({
  version: 1,
  main: { model: null, effort: null },
  advisor: { model: null },
  agents: [],
  allowBuiltins: true,
  updatedAt: null,
  ...over,
});
const plan = (p: unknown, opts: { includeRule?: boolean; ruleText?: string | null; prune?: boolean } = {}, applied: AppliedRecord | null = null) =>
  makePlan([{ type: 'preset.apply', preset: p as any, includeRule: opts.includeRule ?? false, ruleText: opts.ruleText, prune: opts.prune }], ctx(applied));
const changeOf = (p: ReturnType<typeof plan>, name: string) => p.plan.changes.find((c) => path.basename(c.filePath) === name);
const record = (wrote: Partial<AppliedRecord['wrote']>): AppliedRecord => ({
  appliedAt: '2026-09-01T00:00:00.000Z',
  includeRule: false,
  wrote: { model: null, advisorModel: null, effort: null, ...wrote },
});

beforeEach(() => {
  for (const f of [settingsPath, claudeMdPath]) fs.rmSync(f, { force: true });
  for (const f of fs.readdirSync(agentsDir)) fs.rmSync(path.join(agentsDir, f), { force: true });
});

// ---------------- validatePreset ----------------

test('validatePreset：新字段缺失 / null / 字符串三种取值，缺失和 null 的区别保留', () => {
  const p = validatePreset(
    preset({
      agents: [
        { name: 'a', model: null, effort: null },
        { name: 'b', model: null, effort: null, description: null, tools: null, disallowedTools: null, prompt: null },
        { name: 'c', model: null, effort: null, description: '  什么时候用  ', tools: 'Read', disallowedTools: 'Agent', prompt: '' },
      ],
    }),
  );
  const [a, b, c] = p.agents;
  assert.deepEqual(Object.keys(a).sort(), ['effort', 'model', 'name'], '缺失的字段不出现');
  assert.ok(!('description' in b) && !('prompt' in b), 'description、prompt 传 null 当作缺失');
  assert.equal(b.tools, null);
  assert.equal(b.disallowedTools, null);
  assert.ok('tools' in b && 'disallowedTools' in b, 'tools 的 null 保留下来（表示删除字段）');
  assert.equal(c.description, '什么时候用', 'description 去掉首尾空白');
  assert.equal(c.prompt, '', 'prompt 允许空串');
  assert.equal(c.tools, 'Read');
  assert.equal(c.disallowedTools, 'Agent');
  // 空白的 description 当作缺失
  assert.ok(!('description' in validatePreset(preset({ agents: [{ name: 'd', model: null, effort: null, description: '   ' }] })).agents[0]));
  // 保存再读回：字段不丢
  assert.deepEqual(validatePreset(JSON.parse(JSON.stringify(p))), p);
});

test('validatePreset：tools 规范化（拆分、去空白、去重），拆完为空当作 null', () => {
  const p = validatePreset(preset({ agents: [{ name: 'a', model: null, effort: null, tools: ' Read,Grep ,, Read , Glob', disallowedTools: ' , ' }] }));
  assert.equal(p.agents[0].tools, 'Read, Grep, Glob');
  assert.equal(p.agents[0].disallowedTools, null);
});

test('validatePreset：旧预设（没有新字段、带 note）照常能读，version 为 1', () => {
  const old = { version: 1, main: { model: 'opus', effort: 'high' }, advisor: { model: null }, agents: [{ name: 'x', model: 'sonnet', effort: null, note: '旧的职责' }], allowBuiltins: true, updatedAt: '2026-01-01T00:00:00.000Z' };
  const p = validatePreset(old);
  assert.equal(p.version, 1);
  assert.deepEqual(p.agents[0], { name: 'x', model: 'sonnet', effort: null, note: '旧的职责' });
});

test('validatePreset：超长和类型不对时报中文错误', () => {
  const one = (a: Record<string, unknown>) => () => validatePreset(preset({ agents: [{ name: 'a', model: null, effort: null, ...a }] }));
  assert.throws(one({ description: 'x'.repeat(4001) }), /description 太长/);
  assert.throws(one({ prompt: 'x'.repeat(200_001) }), /prompt 太长/);
  assert.throws(one({ tools: 'x'.repeat(4001) }), /tools 太长/);
  assert.throws(one({ disallowedTools: 'y'.repeat(4001) }), /disallowedTools 太长/);
  assert.throws(one({ description: 1 }), /必须是字符串/);
  assert.throws(one({ tools: ['Read'] }), /逗号分隔的字符串或 null/);
  assert.doesNotThrow(one({ description: 'x'.repeat(4000), prompt: 'x'.repeat(200_000) }));
});

// ---------------- 新建 ----------------

test('新建：自定义名字带 description / tools / disallowedTools / prompt，按预设内容生成，不提示占位', () => {
  const p = plan(
    preset({
      agents: [{ name: 'reviewer', model: 'sonnet', effort: 'high', description: '审查代码: 改完之后用', tools: 'Read,Grep', disallowedTools: 'Agent', prompt: '你是审查员。\n\n- 只读\n' }],
    }),
  );
  assert.equal(p.plan.blocked, false, p.plan.errors.join());
  const c = changeOf(p, 'reviewer.md')!;
  assert.equal(c.kind, 'create');
  assert.equal(
    c.after,
    '---\nname: reviewer\ndescription: "审查代码: 改完之后用"\nmodel: sonnet\neffort: high\ntools: Read, Grep\ndisallowedTools: Agent\n---\n\n你是审查员。\n\n- 只读\n',
  );
  assert.equal(c.summary, '新建 agent 定义 reviewer');
  assert.ok(!p.plan.notes.some((n) => /占位/.test(n.message)));
  assert.ok(p.plan.notes.some((n) => n.level === 'info' && /生效检查/.test(n.message)), '新建定义文件时提示去看生效检查');
});

test('新建：不认识的名字没带内容 -> 兜底模板并给出 warn；专用模板不给 warn；note 回退成 description', () => {
  const p = plan(preset({ agents: [{ name: 'mystery', model: null, effort: null }] }));
  const c = changeOf(p, 'mystery.md')!;
  assert.ok(c.after!.includes(JSON.stringify(agentTemplate('mystery').description)));
  assert.ok(c.after!.endsWith(agentTemplate('mystery').prompt));
  const warn = p.plan.notes.find((n) => n.level === 'warn' && /占位/.test(n.message));
  assert.ok(warn, '兜底模板要提示');
  assert.match(warn!.message, /mystery 的描述和系统提示词还是占位文字/);

  const q = plan(preset({ agents: [{ name: 'explorer', model: null, effort: null }] }));
  const e = changeOf(q, 'explorer.md')!;
  const t = agentTemplate('explorer');
  assert.equal(e.after, `---\nname: explorer\ndescription: ${JSON.stringify(t.description)}\ntools: Read, Grep, Glob\n---\n\n${t.prompt}`);
  assert.equal(e.summary, '用模板新建 agent 定义 explorer');
  assert.ok(!q.plan.notes.some((n) => /占位/.test(n.message)), '命中专用模板不提示');

  const r = plan(preset({ agents: [{ name: 'noted', model: null, effort: null, note: '负责写文档' }] }));
  assert.match(changeOf(r, 'noted.md')!.after!, /^---\nname: noted\ndescription: "负责写文档"\n---/);
  const w = r.plan.notes.find((n) => /占位/.test(n.message));
  assert.match(w!.message, /noted 的系统提示词还是占位文字/, 'note 当了描述，只剩正文是占位');
});

// ---------------- 修改已有文件 ----------------

const EXISTING = [
  '---',
  'name: helper',
  '# 我的注释',
  'description: 旧描述',
  'color: red',
  'model: sonnet',
  'tools:',
  '  - Read',
  '  - Grep',
  'maxTurns: 5',
  '---',
  '',
  '旧的正文。',
  '',
].join('\r\n');

test('修改已有文件：只改指定字段，其他字段、注释、顺序保留；tools 为 null 删除字段；正文替换保持 CRLF', () => {
  const file = path.join(agentsDir, 'helper.md');
  fs.writeFileSync(file, EXISTING);
  const p = plan(preset({ agents: [{ name: 'helper', model: null, effort: 'low', description: '新描述', tools: null, prompt: '新的正文。\n第二行\n' }] }));
  assert.equal(p.plan.blocked, false, p.plan.errors.join());
  const c = changeOf(p, 'helper.md')!;
  assert.equal(
    c.after,
    ['---', 'name: helper', '# 我的注释', 'description: "新描述"', 'color: red', 'model: sonnet', 'maxTurns: 5', 'effort: low', '---', '', '新的正文。', '第二行', ''].join('\r\n'),
  );
  assert.match(c.summary, /修改 description/);
  assert.match(c.summary, /删除 tools（原为 Read, Grep）/);
  assert.match(c.summary, /修改系统提示词/);
  assert.doesNotMatch(c.summary, /新的正文/, 'summary 里不放正文');
  assert.ok(p.plan.notes.some((n) => /生效检查/.test(n.message)));
});

test('修改已有文件：prompt 缺失时正文不变；tools 只是顺序不同不改；model 为 null 不删字段（prune 也一样）', () => {
  const file = path.join(agentsDir, 'helper.md');
  fs.writeFileSync(file, EXISTING);
  const same = plan(preset({ agents: [{ name: 'helper', model: null, effort: null, tools: 'Grep, Read', description: '旧描述' }] }), { prune: true });
  assert.equal(same.plan.changes.length, 0, JSON.stringify(same.plan.changes.map((c) => c.summary)));
  // 正文只是换行风格和末尾空行不同：不算改动
  const body = plan(preset({ agents: [{ name: 'helper', model: null, effort: null, prompt: '旧的正文。\n\n\n' }] }));
  assert.equal(body.plan.changes.length, 0);
  const tools = plan(preset({ agents: [{ name: 'helper', model: 'opus', effort: null, disallowedTools: 'Agent' }] }));
  const c = changeOf(tools, 'helper.md')!;
  assert.ok(c.after!.endsWith('---\r\n\r\n旧的正文。\r\n'), '正文不变');
  assert.ok(c.after!.includes('model: opus\r\n') && c.after!.includes('disallowedTools: Agent\r\n---'));
  assert.ok(c.after!.includes('  - Read\r\n  - Grep\r\n'), 'tools 缺失：原样保留');
});

// ---------------- prune ----------------

const USER_SETTINGS = '{\n  "model": "claude-sonnet-5",\n  "advisorModel": "opus",\n  "effortLevel": "high",\n  "theme": "dark"\n}\n';
/** 和 USER_SETTINGS 里的值一致的记录（假设这些值都是 agentree 上次写的） */
const ALL = { model: 'claude-sonnet-5', advisorModel: 'opus', effort: { where: 'top' as const, model: null, value: 'high' } };

test('prune：没有 applied.json 记录时，settings.json 里的键一个都不删', () => {
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  const p = plan(preset(), { prune: true }, null);
  assert.equal(p.plan.changes.length, 0);
  const q = plan(preset(), { prune: true }, record({}));
  assert.equal(q.plan.changes.length, 0, '记录里全是 null 也不删');
});

test('prune：只删记录过、且值没变的键；其余字节不变；给出汇总提示', () => {
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  const p = plan(preset(), { prune: true }, record({ model: 'claude-sonnet-5' }));
  const c = changeOf(p, 'settings.json')!;
  assert.equal(c.after, '{\n  "advisorModel": "opus",\n  "effortLevel": "high",\n  "theme": "dark"\n}\n');
  assert.match(c.summary, /删除 model/);
  assert.ok(p.plan.notes.some((n) => n.level === 'info' && n.message === '这次会移除：settings.json 的 model'));

  const q = plan(preset(), { prune: true }, record({ advisorModel: 'opus', effort: { where: 'top', model: null, value: 'high' } }));
  assert.equal(changeOf(q, 'settings.json')!.after, '{\n  "model": "claude-sonnet-5",\n  "theme": "dark"\n}\n');
  // 方案里指定了的项不删（这时会写入新值）
  const r = plan(preset({ advisor: { model: 'opus' } }), { prune: true }, record({ advisorModel: 'opus' }));
  assert.equal(r.plan.changes.length, 0);
});

test('prune：值在 agentree 写入之后被改过 -> 不删，给出 info 提示', () => {
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  // 记录里写的是 claude-opus-5-5，现在是 claude-sonnet-5（比如被 cc-switch 改了）
  const p = plan(preset(), { prune: true }, record({ model: 'claude-opus-5-5', advisorModel: 'fable', effort: { where: 'top', model: null, value: 'low' } }));
  assert.equal(p.plan.changes.length, 0);
  const infos = p.plan.notes.filter((n) => n.level === 'info').map((n) => n.message);
  assert.ok(infos.includes('settings.json 的 model 在 agentree 写入之后被改成了 claude-sonnet-5，这次不会动它'), infos.join('\n'));
  assert.ok(infos.includes('settings.json 的 advisorModel 在 agentree 写入之后被改成了 opus，这次不会动它'));
  assert.ok(infos.includes('settings.json 的 effortLevel 在 agentree 写入之后被改成了 high，这次不会动它'));
  assert.ok(!infos.some((m) => /这次会移除/.test(m)));
  // 一个改过、一个没改：只删没改的
  const q = plan(preset(), { prune: true }, record({ model: 'claude-opus-5-5', advisorModel: 'opus' }));
  assert.equal(changeOf(q, 'settings.json')!.after, '{\n  "model": "claude-sonnet-5",\n  "effortLevel": "high",\n  "theme": "dark"\n}\n');
});

test('prune：modelSettings 位置的 effort 只删那个叶子键，modelSettings 里别的内容不动', () => {
  const text = '{\n  "modelSettings": {\n    "claude-opus-5-5": {\n      "effortLevel": "high",\n      "other": 1\n    },\n    "claude-fable-5-1": {\n      "effortLevel": "low"\n    }\n  }\n}\n';
  fs.writeFileSync(settingsPath, text);
  const p = plan(preset({ main: { model: 'claude-opus-5-5', effort: null } }), { prune: true }, record({ effort: { where: 'modelSettings', model: 'claude-opus-5-5', value: 'high' } }));
  const c = changeOf(p, 'settings.json')!;
  // 主模型在方案里指定了，照常追加 model
  assert.equal(c.after, text.replace('"effortLevel": "high",\n      ', '').replace('\n  }\n}\n', '\n  },\n  "model": "claude-opus-5-5"\n}\n'));
  assert.match(c.summary, /删除 modelSettings\.claude-opus-5-5\.effortLevel/);
});

test('prune：effort 换了位置（主模型换成 Opus 5.5）时，旧位置的值没变才删除', () => {
  fs.writeFileSync(settingsPath, '{\n  "effortLevel": "medium"\n}\n');
  const moved = preset({ main: { model: 'claude-opus-5-5', effort: 'high' } });
  const p = plan(moved, { prune: true }, record({ effort: { where: 'top', model: null, value: 'medium' } }));
  const c = changeOf(p, 'settings.json')!;
  const after = JSON.parse(c.after!);
  assert.equal(after.effortLevel, undefined, '旧位置删掉');
  assert.equal(after.modelSettings['claude-opus-5-5'].effortLevel, 'high');
  assert.match(c.summary, /删除旧位置的 effortLevel/);
  // 旧位置的值被改过：保留，并提示
  const changed = plan(moved, { prune: true }, record({ effort: { where: 'top', model: null, value: 'low' } }));
  assert.equal(JSON.parse(changeOf(changed, 'settings.json')!.after!).effortLevel, 'medium');
  assert.ok(changed.plan.notes.some((n) => n.message === 'settings.json 的 effortLevel 在 agentree 写入之后被改成了 medium，这次不会动它'));
  // prune 为 false：旧位置保留
  const q = plan(moved, { prune: false }, record({ effort: { where: 'top', model: null, value: 'medium' } }));
  assert.equal(JSON.parse(changeOf(q, 'settings.json')!.after!).effortLevel, 'medium');
});

test('prune：settings.json 不存在时不为了删除而创建；prune 为 false 时不删', () => {
  const p = plan(preset(), { prune: true }, record(ALL));
  assert.equal(p.plan.changes.length, 0);
  assert.ok(!fs.existsSync(settingsPath));
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  const q = plan(preset(), { prune: false }, record(ALL));
  assert.equal(q.plan.changes.length, 0);
});

test('applied.json：旧格式的布尔值当作不知道值（null），prune 不删；新格式原样读回', () => {
  fs.mkdirSync(path.dirname(appliedFile), { recursive: true });
  fs.writeFileSync(appliedFile, JSON.stringify({ appliedAt: '2026-09-01T00:00:00.000Z', includeRule: true, wrote: { model: true, advisorModel: true, effort: { where: 'top', model: null } } }));
  try {
    const rec = readApplied()!;
    assert.deepEqual(rec, { appliedAt: '2026-09-01T00:00:00.000Z', includeRule: true, wrote: { model: null, advisorModel: null, effort: null } });
    fs.writeFileSync(settingsPath, USER_SETTINGS);
    assert.equal(plan(preset(), { prune: true }, rec).plan.changes.length, 0);
    writeApplied({ appliedAt: 'x', includeRule: false, wrote: ALL });
    assert.deepEqual(readApplied()!.wrote, ALL);
  } finally {
    fs.rmSync(appliedFile, { force: true });
  }
});

test('prune：includeRule 为 false 时删除规则块（不看 applied.json）；prune 为 false 时保留', async () => {
  const orig = '# 我的规则\n';
  fs.writeFileSync(claudeMdPath, orig);
  const on = plan(preset(), { includeRule: true });
  await applyPlan(on, []);
  assert.match(fs.readFileSync(claudeMdPath, 'utf8'), /agentree:advisor-rule:start/);
  assert.equal(plan(preset(), { includeRule: false, prune: false }).plan.changes.length, 0);
  const off = plan(preset(), { includeRule: false, prune: true });
  const c = changeOf(off, 'CLAUDE.md')!;
  assert.equal(c.after, orig, '删除后与启用前逐字节相同');
  assert.match(c.summary, /删除 advisor 规则块/);
  assert.ok(off.plan.notes.some((n) => n.message === '这次会移除：CLAUDE.md 里的 advisor 规则块'));
  // 没有规则块、CLAUDE.md 不存在：不创建
  fs.rmSync(claudeMdPath);
  assert.equal(plan(preset(), { includeRule: false, prune: true }).plan.changes.length, 0);
});

test('applied.json 的 wrote：这次写了记这次的值；null 且 prune 记 null（包括值被改过没删的）；没 prune 保留上次的记录', () => {
  const prev = record(ALL).wrote;
  const p = validatePreset(preset({ main: { model: null, effort: null }, advisor: { model: null } }));
  assert.deepEqual(nextWrote(p, { ...record({}), wrote: prev }, false), prev, 'prune 为 false：保留');
  assert.deepEqual(nextWrote(p, { ...record({}), wrote: prev }, true), { model: null, advisorModel: null, effort: null });
  const q = validatePreset(preset({ main: { model: 'claude-opus-5-5', effort: 'high' }, advisor: { model: 'fable' } }));
  assert.deepEqual(nextWrote(q, null, false), { model: 'claude-opus-5-5', advisorModel: 'fable', effort: { where: 'modelSettings', model: 'claude-opus-5-5', value: 'high' } });
  const r = validatePreset(preset({ main: { model: 'opus', effort: 'high' } }));
  assert.deepEqual(nextWrote(r, null, true).effort, { where: 'top', model: null, value: 'high' });
  // 值被改过、这次没删：记录清掉（那个值已经不是 agentree 的）
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  const changed = plan(p, { prune: true }, record({ model: 'claude-opus-5-5' }));
  assert.equal(changed.plan.changes.length, 0);
  assert.equal(changed.presetApply?.wrote.model, null);
  // 计划上带着这份信息
  const pl = plan(q, { prune: true });
  assert.deepEqual(pl.presetApply?.wrote, nextWrote(q, null, true));
  assert.equal(pl.presetApply?.includeRule, false);
});

test('prune 缺失或 false：行为和原来一样，只增改不移除', () => {
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  for (const prune of [undefined, false]) {
    const p = plan(preset(), { prune, includeRule: false }, record(ALL));
    assert.equal(p.plan.changes.length, 0);
    assert.ok(!p.plan.notes.some((n) => /这次会移除|不会动它/.test(n.message)));
  }
});

// ---------------- ruleText ----------------

test('ruleText：自定义文案写入；已有规则块文案不同则替换；相同不改；缺失时不动已有的', async () => {
  const p = plan(preset(), { includeRule: true, ruleText: '规则一' });
  assert.match(changeOf(p, 'CLAUDE.md')!.after!, /start -->\n规则一\n<!--/);
  await applyPlan(p, []);
  assert.equal(plan(preset(), { includeRule: true, ruleText: '规则一' }).plan.changes.length, 0, '相同文案不改');
  const q = plan(preset(), { includeRule: true, ruleText: '规则二' });
  assert.match(changeOf(q, 'CLAUDE.md')!.after!, /start -->\n规则二\n<!--/);
  assert.match(changeOf(q, 'CLAUDE.md')!.summary, /替换/);
  assert.equal(plan(preset(), { includeRule: true, ruleText: null }).plan.changes.length, 0, 'null：已有规则块保持原文案');
  assert.equal(plan(preset(), { includeRule: true }).plan.changes.length, 0, '缺失：同上');
});

// ---------------- JSON 删除键 ----------------

test('删除 JSON 键：第一个 / 中间 / 最后一个 / 唯一一个，其余字节不变', () => {
  const text = '{\r\n\t"a": 1,\r\n\t"b": {"x": [1, 2]},\r\n\t"c": "z"\r\n}\r\n';
  const del = (t: string, k: string[]) => removeValue(parseJsonDoc(t), k);
  assert.equal(del(text, ['a']), '{\r\n\t"b": {"x": [1, 2]},\r\n\t"c": "z"\r\n}\r\n');
  assert.equal(del(text, ['b']), '{\r\n\t"a": 1,\r\n\t"c": "z"\r\n}\r\n');
  assert.equal(del(text, ['c']), '{\r\n\t"a": 1,\r\n\t"b": {"x": [1, 2]}\r\n}\r\n');
  assert.equal(del('{\n  "only": true\n}\n', ['only']), '{}\n');
  assert.equal(del('{"a": 1, "b": 2}', ['a']), '{"b": 2}');
  assert.equal(del('{"a": 1, "b": 2}', ['b']), '{"a": 1}');
  assert.equal(del(text, ['missing']), text, '不存在的键原样返回');
});

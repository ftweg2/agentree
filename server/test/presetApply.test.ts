// 应用预设：展开规则。临时目录，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

const root = tmpDir('agentree-preset-');
const cfg = path.join(root, 'claude');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = path.join(root, 'home');
fs.mkdirSync(path.join(cfg, 'agents'), { recursive: true });

const { makePlan, isOpus55OrLater } = await import('../src/config/planner.ts');
const { PRESET_TEMPLATES, agentTemplate } = await import('../src/config/templates.ts');
const { applyPlan } = await import('../src/config/applier.ts');

const ctx = (env: Array<{ name: string; value: string | null }> = [], cc = false, desktopOnly = true) => ({
  knownCwds: [],
  env: env.map((e) => ({ ...e, scope: 'user' as const, level: 'warn' as const, impact: '' })),
  ccSwitchDetected: cc,
  // 模拟最近的会话都来自桌面版
  desktopOnly,
});

test('Opus 5.5 及之后的判断', () => {
  assert.equal(isOpus55OrLater('claude-opus-5-5'), true);
  assert.equal(isOpus55OrLater('claude-opus-5-5[1m]'), true);
  assert.equal(isOpus55OrLater('claude-opus-6'), true);
  assert.equal(isOpus55OrLater('claude-opus-5'), false);
  assert.equal(isOpus55OrLater('claude-opus-4-8'), false);
  assert.equal(isOpus55OrLater('opus'), false);
  assert.equal(isOpus55OrLater('claude-fable-5-1'), false);
});

test('模板预设：settings.json、CLAUDE.md、三个 agent 定义，同一文件的多项修改合并；给出桌面版提示', async () => {
  const t = PRESET_TEMPLATES[0];
  assert.equal(t.id, 'opus-main-fable-advisor');
  // 模板里的 agent 带着完整内容（description、tools、prompt）
  const ex = agentTemplate('explorer');
  // 已存在的 explorer：改 model、effort，以及模板带来的 description、tools、正文；其余字段（color）不动
  const explorer = path.join(cfg, 'agents', 'explorer.md');
  const orig = '---\nname: explorer\ndescription: 我自己写的\ncolor: blue\nmodel: sonnet\n---\n\n我自己的正文\n';
  fs.writeFileSync(explorer, orig);
  const { plan, internal } = makePlan([{ type: 'preset.apply', preset: t.preset, includeRule: t.includeRule }], ctx());
  assert.equal(plan.blocked, false, plan.errors.join());
  const byName = new Map(plan.changes.map((c) => [path.basename(c.filePath), c]));
  assert.deepEqual([...byName.keys()].sort(), ['CLAUDE.md', 'explorer.md', 'researcher.md', 'settings.json', 'worker.md']);
  const s = byName.get('settings.json')!;
  assert.equal(s.kind, 'create');
  assert.equal(
    s.after,
    '{\n  "model": "claude-opus-5-5",\n  "modelSettings": {\n    "claude-opus-5-5": {\n      "effortLevel": "high"\n    }\n  },\n  "advisorModel": "fable"\n}\n',
  );
  assert.equal(byName.get('explorer.md')!.kind, 'modify');
  assert.equal(
    byName.get('explorer.md')!.after,
    `---\nname: explorer\ndescription: ${JSON.stringify(ex.description)}\ncolor: blue\nmodel: opus\neffort: medium\ntools: Read, Grep, Glob\n---\n\n${ex.prompt}`,
  );
  assert.doesNotMatch(byName.get('explorer.md')!.summary, /代码探索员/, 'summary 里不放正文');
  const worker = byName.get('worker.md')!;
  assert.equal(worker.kind, 'create');
  assert.ok(worker.after!.startsWith(`---\nname: worker\ndescription: ${JSON.stringify(agentTemplate('worker').description)}\nmodel: opus\neffort: medium\n---\n\n`));
  assert.ok(worker.after!.endsWith(agentTemplate('worker').prompt));
  assert.ok(!/tools:/.test(worker.after!), 'worker 不限制工具');
  assert.match(byName.get('researcher.md')!.after!, /tools: Read, Grep, Glob, WebFetch, WebSearch/);
  assert.match(byName.get('CLAUDE.md')!.after!, /agentree:advisor-rule:start/);
  assert.ok(plan.notes.some((n) => n.level === 'warn' && /桌面版/.test(n.message)));
  // 索引里没有会话（或最近的会话不全是桌面版）：不给桌面版提示
  const noDesktop = makePlan([{ type: 'preset.apply', preset: t.preset, includeRule: t.includeRule }], ctx([], false, false));
  assert.ok(!noDesktop.plan.notes.some((n) => /桌面版/.test(n.message)));
  assert.ok(plan.notes.some((n) => n.level === 'info' && /定义/.test(n.message)));
  // 应用后再生成同样的计划：没有变化
  const r = await applyPlan({ plan, internal }, []);
  assert.equal(r.failed.length, 0);
  const again = makePlan([{ type: 'preset.apply', preset: t.preset, includeRule: true }], ctx());
  assert.equal(again.plan.changes.length, 0);
});

test('预设展开：别名主模型的 effort 写顶层并提示；null 不修改；内置类型跳过；max 报错；环境变量和 cc-switch 提示', () => {
  const base = { version: 1, main: { model: 'opus', effort: 'medium' }, advisor: { model: null }, agents: [{ name: 'Explore', model: 'haiku', effort: null }], allowBuiltins: true, updatedAt: null };
  const env = [
    { name: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'high' },
    { name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', value: '1' },
    { name: 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', value: null },
  ];
  const { plan } = makePlan([{ type: 'preset.apply', preset: base as any, includeRule: false }], ctx(env, true));
  const s = plan.changes.find((c) => c.filePath.endsWith('settings.json'))!;
  assert.match(s.after!, /"effortLevel": "medium"/);
  assert.match(s.after!, /"model": "opus"/);
  assert.match(s.after!, /"advisorModel": "fable"/, '预设里 advisor 为 null：保持现状（上一个测试写入的 fable）');
  assert.match(s.after!, /"claude-opus-5-5": \{\n {6}"effortLevel": "high"/, 'modelSettings 原样保留');
  const msgs = plan.notes.map((n) => n.message).join('\n');
  assert.match(msgs, /不是 Opus 5\.5 及之后的完整模型 ID/);
  assert.match(msgs, /Explore 是内置类型/);
  assert.match(msgs, /CLAUDE_CODE_EFFORT_LEVEL/);
  assert.match(msgs, /cc-switch/);
  assert.doesNotMatch(msgs, /DISABLE_ADVISOR_TOOL/, '没设置的变量不提示');
  const max = makePlan([{ type: 'preset.apply', preset: { ...base, main: { model: 'claude-opus-5-5', effort: 'max' } } as any, includeRule: false }], ctx());
  assert.equal(max.plan.blocked, true);
  assert.match(max.plan.errors[0], /max/);
});

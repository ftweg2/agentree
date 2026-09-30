// 内置的两套方案模板。临时目录，不碰真实配置。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

const root = tmpDir('agentree-templates-');
process.env.AGENTREE_HOME = path.join(root, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-init');

const { makePlan } = await import('../src/config/planner.ts');
const { PRESET_TEMPLATES } = await import('../src/config/templates.ts');
const { validatePreset } = await import('../src/preset.ts');

const ctx = () => ({ knownCwds: [], env: [], ccSwitchDetected: false, desktopOnly: true });

/** 每套模板用各自全新的配置目录生成计划 */
function planFor(i: number) {
  const cfg = path.join(root, 'claude-' + i);
  fs.mkdirSync(cfg, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const t = PRESET_TEMPLATES[i];
  const { plan } = makePlan([{ type: 'preset.apply', preset: t.preset, includeRule: t.includeRule }], ctx());
  assert.equal(plan.blocked, false, plan.errors.join());
  for (const c of plan.changes) assert.ok(path.resolve(c.filePath).startsWith(path.resolve(cfg)), '计划只能写临时目录：' + c.filePath);
  return new Map(plan.changes.map((c) => [path.basename(c.filePath), c]));
}

test('内置模板是互不叠加的两套，都能通过方案校验', () => {
  assert.deepEqual(
    PRESET_TEMPLATES.map((t) => t.id),
    ['fable-main-opus-agents', 'opus-main-fable-advisor'],
  );
  for (const t of PRESET_TEMPLATES) assert.doesNotThrow(() => validatePreset(t.preset), t.id);
});

test('第一套：Fable 统筹 + Opus 子 agent，不设顾问，规则里只有分工', () => {
  const t = PRESET_TEMPLATES[0];
  assert.equal(t.preset.main.model, 'claude-fable-5-1');
  assert.equal(t.preset.advisor.model, null);
  assert.deepEqual(
    t.preset.agents.map((a) => [a.name, a.model, a.effort]),
    [
      ['explorer', 'opus', 'medium'],
      ['worker', 'opus', 'medium'],
      ['researcher', 'opus', 'medium'],
    ],
  );
  const by = planFor(0);
  assert.deepEqual([...by.keys()].sort(), ['CLAUDE.md', 'explorer.md', 'researcher.md', 'settings.json', 'worker.md']);
  const settings = JSON.parse(by.get('settings.json')!.after!);
  assert.equal(settings.model, 'claude-fable-5-1');
  assert.equal('advisorModel' in settings, false, '不写顾问');
  const md = by.get('CLAUDE.md')!.after!;
  assert.match(md, /## 怎么分工/);
  assert.doesNotMatch(md, /何时咨询 advisor/);
  for (const n of ['explorer', 'worker', 'researcher']) assert.ok(md.includes('`' + n + '`'), n);
});

test('第二套：Opus 5.5 + Fable 顾问，不带子 agent，规则里只有何时咨询顾问', () => {
  const t = PRESET_TEMPLATES[1];
  assert.equal(t.preset.main.model, 'claude-opus-5-5');
  assert.equal(t.preset.advisor.model, 'fable');
  assert.equal(t.preset.agents.length, 0);
  const by = planFor(1);
  assert.deepEqual([...by.keys()].sort(), ['CLAUDE.md', 'settings.json'], '不建任何子 agent 定义');
  const settings = JSON.parse(by.get('settings.json')!.after!);
  assert.equal(settings.model, 'claude-opus-5-5');
  assert.equal(settings.advisorModel, 'fable');
  const md = by.get('CLAUDE.md')!.after!;
  assert.match(md, /## 何时咨询 advisor/);
  assert.doesNotMatch(md, /怎么分工/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEffort,
  checkModel,
  matchModel,
  normalizeModel,
  sessionChecks,
  subagentConformance,
} from '../src/conformance.ts';
import { defaultPreset } from '../src/preset.ts';
import type { Preset } from '../../shared/types.ts';

test('模型归一化：去掉 [1m] 后缀和末尾日期', () => {
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(normalizeModel('Claude-Opus-5-5 [1m]'), 'claude-opus-5-5');
});

test('模型匹配：别名', () => {
  assert.equal(matchModel('opus', 'claude-opus-5-5').level, 'ok');
  assert.equal(matchModel('opus', 'claude-opus-5').level, 'ok'); // 包含 -opus-
  assert.equal(matchModel('fable', 'claude-fable-5-1[1m]').level, 'ok');
  assert.equal(matchModel('haiku', 'claude-opus-5-5').level, 'fail');
  assert.equal(matchModel('sonnet', 'claude-3-sonnet').level, 'ok'); // 以 -sonnet 结尾
});

test('模型匹配：完整 ID，归一化后相等为 ok；同系列不同版本 warn；其余 fail', () => {
  assert.equal(matchModel('claude-opus-5-5', 'claude-opus-5-5[1m]').level, 'ok');
  assert.equal(matchModel('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929').level, 'ok');
  assert.equal(matchModel('claude-opus-5-5', 'claude-opus-5').level, 'warn');
  assert.equal(matchModel('claude-opus-5-5', 'claude-sonnet-5').level, 'fail');
});

test('模型检查：一个 agent 用了多个模型时 warn 并列出所有模型；预设为 null 不检查', () => {
  const c = checkModel('opus', ['claude-opus-5-5', 'claude-opus-5'], 'claude-opus-5-5')!;
  assert.equal(c.level, 'warn');
  assert.match(c.actual!, /claude-opus-5-5.*claude-opus-5/);
  assert.equal(checkModel(null, ['x'], 'x'), null);
  const f = checkModel('haiku', ['claude-opus-5-5', 'claude-haiku-4-5'], 'claude-opus-5-5')!;
  assert.equal(f.level, 'fail');
  assert.equal(checkModel('opus', [], null)!.level, 'info');
});

test('effort 匹配：相等 ok，偏低 warn（降级或环境变量覆盖），偏高 fail，没有 info', () => {
  assert.equal(checkEffort('high', ['high'])!.level, 'ok');
  const low = checkEffort('xhigh', ['high'])!;
  assert.equal(low.level, 'warn');
  assert.match(low.message, /CLAUDE_CODE_EFFORT_LEVEL/);
  assert.equal(checkEffort('medium', ['high'])!.level, 'fail');
  assert.equal(checkEffort('high', [])!.level, 'info');
  assert.equal(checkEffort(null, ['high']), null);
  // 多个值取最差
  assert.equal(checkEffort('high', ['high', 'max'])!.level, 'fail');
  assert.equal(checkEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])!.level, 'warn');
});

test('子 agent 判定：在预设里 / 内置且允许 / 计划外', () => {
  const p: Preset = {
    ...defaultPreset(),
    agents: [{ name: 'reviewer', model: 'sonnet', effort: 'high' }],
    allowBuiltins: true,
  };
  const ok = subagentConformance(p, { agentType: 'reviewer', models: ['claude-sonnet-5'], primaryModel: 'claude-sonnet-5', efforts: ['high'] }, null);
  assert.equal(ok.verdict, 'match');
  assert.equal(ok.presetAgent, 'reviewer');
  const bad = subagentConformance(p, { agentType: 'reviewer', models: ['claude-opus-5-5'], primaryModel: 'claude-opus-5-5', efforts: ['high'] }, null);
  assert.equal(bad.verdict, 'mismatch');
  const builtin = subagentConformance(p, { agentType: 'Explore', models: [], primaryModel: null, efforts: [] }, null);
  assert.equal(builtin.verdict, 'match');
  assert.equal(builtin.checks[0].level, 'info');
  const unplanned = subagentConformance(p, { agentType: 'my-custom', models: [], primaryModel: null, efforts: [] }, null);
  assert.equal(unplanned.verdict, 'unplanned');
  const noBuiltins = subagentConformance({ ...p, allowBuiltins: false }, { agentType: 'Explore', models: [], primaryModel: null, efforts: [] }, null);
  assert.equal(noBuiltins.verdict, 'unplanned');
  // 默认（空）预设不检查
  assert.equal(subagentConformance(defaultPreset(), { agentType: 'x', models: [], primaryModel: null, efforts: [] }, null).verdict, 'not-checked');
});

test('会话级 advisor：配置了但 0 次调用给 warn', () => {
  const p: Preset = { ...defaultPreset(), advisor: { model: 'opus' } };
  const checks = sessionChecks(p, { models: ['claude-opus-5-5'], primaryModel: 'claude-opus-5-5', efforts: ['high'], advisorModel: 'claude-opus-5-5', advisorCalls: 0 });
  assert.deepEqual(
    checks.map((c) => [c.field, c.level]),
    [
      ['advisor', 'ok'],
      ['advisor', 'warn'],
    ],
  );
});

test('advisor 零调用：预设没指定 advisor 时给 info，不计入 warn/fail，也不影响判定', async () => {
  const { mainConformance, sessionChecks: sc } = await import('../src/conformance.ts');
  const empty = defaultPreset();
  const base = { models: ['claude-opus-5-5'], primaryModel: 'claude-opus-5-5', efforts: ['high'], advisorModel: 'claude-opus-5-5', advisorCalls: 0 };
  const checks = sc(empty, base);
  assert.equal(checks.length, 1);
  assert.deepEqual([checks[0].field, checks[0].level, checks[0].expected], ['advisor', 'info', null]);
  assert.equal(mainConformance(empty, checks).verdict, 'not-checked');
  assert.equal(mainConformance(empty, checks).checks.length, 1, 'info 仍然出现在主节点的检查里');
  // 有调用、或记录上没有 advisorModel 时不提示
  assert.equal(sc(empty, { ...base, advisorCalls: 2 }).length, 0);
  assert.equal(sc(empty, { ...base, advisorModel: null }).length, 0);
  // 预设指定了主模型：主模型 ok + advisor info => match
  const p: Preset = { ...defaultPreset(), main: { model: 'opus', effort: null } };
  const c2 = sc(p, base);
  assert.deepEqual(c2.map((c) => c.level), ['ok', 'info']);
  assert.equal(mainConformance(p, c2).verdict, 'match');
  // 预设指定了 advisor：零调用是 warn（原有行为）
  const c3 = sc({ ...defaultPreset(), advisor: { model: 'opus' } }, base);
  assert.equal(c3.find((c) => c.actual === '0 次调用')!.level, 'warn');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetFromConfig, maskValue } from '../src/claudeConfig.ts';
import type { ClaudeConfigSnapshot } from '../../shared/types.ts';

function snap(settings: Partial<ClaudeConfigSnapshot['settings']> = {}): ClaudeConfigSnapshot {
  return {
    configDir: 'x',
    definitions: [
      { name: 'reviewer', source: 'user', filePath: 'a.md', description: null, model: 'sonnet', effort: 'high', tools: null, projectCwd: null },
      { name: 'reviewer', source: 'project', filePath: 'b.md', description: null, model: 'inherit', effort: 'bogus', tools: null, projectCwd: 'C:\p' },
      { name: 'proj-only', source: 'project', filePath: 'c.md', description: null, model: 'opus', effort: null, tools: null, projectCwd: 'C:\p' },
    ],
    settings: { effortLevel: null, model: null, advisorModel: null, modelEffort: {}, ...settings },
    env: [],
    builtinAgentTypes: [],
    ccSwitchDetected: false,
    projectCwds: [],
  };
}

test('从配置生成预设：settings.json 为空时用桌面版最近会话的 model/effort 和日志上的 advisorModel 兜底', () => {
  const p = presetFromConfig(snap(), { model: 'claude-fable-5-1', effort: 'xhigh', advisorModel: 'claude-opus-5-5' });
  assert.deepEqual(p.main, { model: 'claude-fable-5-1', effort: 'xhigh' });
  assert.deepEqual(p.advisor, { model: 'claude-opus-5-5' });
  assert.equal(p.updatedAt, null);
  // 只取用户级定义：preset.apply 只写用户级文件，项目级的（同名的和只在项目里有的）都不进预设
  assert.deepEqual(p.agents.map((a) => a.name), ['reviewer']);
  assert.equal(p.agents[0].model, 'sonnet');
  assert.equal(p.agents[0].effort, 'high');
  assert.equal(p.agents[0].tools, null, '没有 tools 字段记为 null');
});

test('从配置生成预设：settings.json 有值时优先，兜底不覆盖；非法 effort 忽略', () => {
  const p = presetFromConfig(snap({ model: 'opus', effortLevel: 'high', advisorModel: 'claude-opus-5' }), {
    model: 'claude-fable-5-1',
    effort: 'xhigh',
    advisorModel: 'claude-opus-5-5',
  });
  assert.deepEqual(p.main, { model: 'opus', effort: 'high' });
  assert.equal(p.advisor.model, 'claude-opus-5');
  const q = presetFromConfig(snap({ model: 'opus' }), { model: 'x', effort: 'turbo', advisorModel: null });
  assert.deepEqual(q.main, { model: 'opus', effort: null });
  assert.deepEqual(presetFromConfig(snap(), null).main, { model: null, effort: null });
});

test('环境变量值超过 12 个字符只返回前 4 位加省略号', () => {
  assert.equal(maskValue('http://127.0.0.1:15721'), 'http…');
  assert.equal(maskValue('high'), 'high');
});

test('从配置生成预设：用户级定义里 model 为 inherit 记为 null 并注明', () => {
  const s = snap();
  s.definitions = [{ name: 'helper', source: 'user', filePath: 'missing.md', description: '帮忙', model: 'inherit', effort: null, tools: 'Read', projectCwd: null }];
  const p = presetFromConfig(s, null);
  assert.equal(p.agents[0].model, null);
  assert.match(p.agents[0].note ?? '', /inherit/);
  assert.equal(p.agents[0].description, '帮忙');
  assert.equal(p.agents[0].tools, 'Read');
  assert.ok(!('prompt' in p.agents[0]), '定义文件读不了：不知道正文，不写 prompt');
});

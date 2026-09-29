import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/db.ts';
import { modelCatalog } from '../src/models.ts';
import { Pricing } from '../src/pricing.ts';
import { cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

const home = path.join(tmpDir(), 'home');
fs.mkdirSync(home, { recursive: true });
process.env.AGENTREE_HOME = home;

const price = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, litellm_provider: 'anthropic' };

function setup(prices: Record<string, unknown>, used: Array<[string, string]>) {
  fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify(prices));
  const pricing = new Pricing();
  pricing.load();
  const store = new Store(path.join(tmpDir(), 'test.db'));
  const ins = store.db.prepare('INSERT INTO requests (session_id, key, agent, model, ts) VALUES (?, ?, ?, ?, ?)');
  used.forEach(([model, ts], i) => ins.run('S', `k${i}`, 'main', model, ts));
  return { pricing, store };
}

test('模型清单：价格表里的 Claude 模型去掉日期和厂商变体，按系列排、新版本在前', () => {
  const { pricing, store } = setup(
    {
      'claude-opus-5': price,
      'claude-opus-5-5': price,
      'claude-opus-4-8': price,
      'claude-haiku-4-5': price,
      'claude-haiku-4-5-20251001': price,
      'claude-sonnet-5-5': price,
      'claude-sonnet-4-5-20250929-v1:0': price,
      'us.anthropic.claude-sonnet-5-5': price,
      'claude-fable-5-1': price,
      'claude-mythos-5': price,
      'claude-3-5-sonnet-20241022': price,
      'gpt-4o': price,
    },
    [],
  );
  const list = modelCatalog(pricing, store);
  assert.deepEqual(
    list.map((m) => m.id),
    ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  );
  assert.deepEqual(
    list.map((m) => m.label),
    ['Fable 5.1', 'Opus 5.5', 'Opus 5', 'Opus 4.8', 'Sonnet 5.5', 'Sonnet 4.5', 'Haiku 4.5'],
  );
  assert.ok(list.every((m) => m.requests === 0 && m.lastUsedAt === null));
  store.close();
});

test('模型清单：本机用过的模型一定列出来，带上次数；带日期和 [1m] 的算同一个模型', () => {
  const { pricing, store } = setup({ 'claude-opus-5-5': price }, [
    ['claude-opus-5-5', '2026-09-01T00:00:00.000Z'],
    ['claude-opus-5-5[1m]', '2026-09-03T00:00:00.000Z'],
    ['claude-sonnet-5', '2026-09-02T00:00:00.000Z'],
    ['claude-mythos-5-1', '2026-09-02T00:00:00.000Z'],
    ['<synthetic>', '2026-09-02T00:00:00.000Z'],
  ]);
  const list = modelCatalog(pricing, store);
  assert.deepEqual(
    list.map((m) => [m.id, m.family, m.requests]),
    [
      ['claude-opus-5-5', 'opus', 2],
      ['claude-sonnet-5', 'sonnet', 1],
      ['claude-mythos-5-1', 'other', 1],
    ],
  );
  assert.equal(list[0].lastUsedAt, '2026-09-03T00:00:00.000Z');
  store.close();
});

test('模型清单：价格表和日志都没有数据时用内置的清单', () => {
  const { pricing, store } = setup({}, []);
  const list = modelCatalog(pricing, store);
  assert.ok(list.length >= 4);
  assert.ok(list.some((m) => m.id === 'claude-opus-5-5'));
  store.close();
});

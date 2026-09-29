import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { PresetStore } from '../src/preset.ts';
import { cleanupTmp, tmpDir } from './helpers.ts';

after(cleanupTmp);

process.env.AGENTREE_HOME = path.join(tmpDir(), 'home');

const app = createApp({
  analyzer: { live: () => { throw new Error('boom'); }, sessionDetail: () => null } as any,
  indexer: { status: { state: 'idle', filesTotal: 0, filesIndexed: 0, lastIndexedAt: null, skippedLines: 0 }, requestFullScan() {} } as any,
  presets: new PresetStore(),
  store: {} as any,
  desktop: {} as any,
  token: 'test-token',
  staticDir: null,
});
const H = { host: '127.0.0.1:4777' };
const W = { ...H, 'x-agentree-token': 'test-token', 'content-type': 'application/json' };

test('所有 JSON 响应的 Content-Type 带 charset=utf-8（正常、400、403、404、500）', async () => {
  const cases: Array<[string, RequestInit, number]> = [
    ['/api/preset', { headers: H }, 200],
    ['/api/reindex', { method: 'POST', headers: W }, 200],
    ['/api/reindex', { method: 'POST', headers: H }, 403],
    ['/api/preset', { method: 'PUT', headers: W, body: 'not json' }, 400],
    ['/api/preset', { method: 'PUT', headers: { ...W, 'content-type': 'text/plain' }, body: '{}' }, 415],
    ['/api/sessions/nope', { headers: H }, 404],
    ['/api/nope', { headers: H }, 404],
    ['/api/preset', { headers: { host: 'evil.example' } }, 403],
    ['/api/live', { headers: H }, 500],
  ];
  for (const [url, init, code] of cases) {
    const res = await app.request(url, init);
    assert.equal(res.status, code, url);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', `${url} ${code}`);
    const body = await res.json();
    assert.ok(body && typeof body === 'object');
  }
});

test('GET /api/version 返回接口版本号', async () => {
  const res = await app.request('/api/version', { headers: H });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { api: number };
  assert.ok(Number.isInteger(body.api) && body.api >= 4);
});

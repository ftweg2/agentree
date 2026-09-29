// 第二阶段：配置写入。全部在临时的 CLAUDE_CONFIG_DIR 和 AGENTREE_HOME 下进行，绝不碰真实的 ~/.claude。
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseTree, findNodeAtLocation } from 'jsonc-parser';
import { cleanupTmp, tmpDir } from './helpers.ts';

const root = tmpDir('agentree-cfg-');
const cfg = path.join(root, 'claude');
const home = path.join(root, 'agentree');
const project = path.join(root, 'proj');
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.AGENTREE_HOME = home;
process.env.AGENTREE_DESKTOP_DIR = '';
fs.mkdirSync(cfg, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// 保险：确认没有指向真实目录
import os from 'node:os';
assert.notEqual(path.resolve(cfg).toLowerCase(), path.join(os.homedir(), '.claude').toLowerCase());

const { createApp } = await import('../src/app.ts');
const { Store } = await import('../src/db.ts');
const { PresetStore } = await import('../src/preset.ts');
const { PlanStore } = await import('../src/config/applier.ts');
const { listBackups } = await import('../src/config/backups.ts');
const { enableRule, disableRule } = await import('../src/config/claudeMd.ts');

const store = new Store(path.join(home, 'agentree.db'));
store.db.prepare('INSERT INTO sessions (session_id, project_dir, cwd) VALUES (?, ?, ?)').run('s1', 'P', project);
const TOKEN = 'tok-123';
const app = createApp({
  analyzer: {} as any,
  indexer: { status: {}, requestFullScan() {} } as any,
  presets: new PresetStore(),
  store,
  desktop: {} as any,
  token: TOKEN,
  staticDir: null,
});
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
async function plan(actions: unknown[]) {
  const r = await call('POST', '/api/config/plan', { actions });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function apply(planId: string) {
  return call('POST', '/api/config/apply', { planId });
}
async function planAndApply(actions: unknown[]) {
  const p = await plan(actions);
  assert.equal(p.blocked, false, `计划被阻止：${p.errors?.join('；')}`);
  const r = await apply(p.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.failed, [], JSON.stringify(r.body.failed));
  return { plan: p, result: r.body };
}

const settingsPath = path.join(cfg, 'settings.json');
const claudeMdPath = path.join(cfg, 'CLAUDE.md');
const agentsDir = path.join(cfg, 'agents');
const read = (p: string) => fs.readFileSync(p);

/** 取某个键的值在原文里的字节片段 */
function slice(text: string, key: string): string {
  const node = findNodeAtLocation(parseTree(text)!, [key])!;
  return text.slice(node.offset, node.offset + node.length);
}

const USER_SETTINGS =
  '{\r\n' +
  '\t"hooks": {\r\n\t\t"Stop": [ { "hooks": [ { "type": "command", "command": "node  notify.cjs --x=1" } ] } ]\r\n\t},\r\n' +
  '\t"permissions": {"allow": ["Bash(git status)",   "Read"], "deny": []},\r\n' +
  '\t"env": {\r\n\t\t"FOO":   "bar",\r\n\t\t"N": "1"\r\n\t},\r\n' +
  '\t"autoUpdatesChannel": "latest"\r\n' +
  '}\r\n';

test('settings.json：hooks / permissions / env 逐字节不变，Tab 缩进和 CRLF 保持', async () => {
  fs.writeFileSync(settingsPath, USER_SETTINGS);
  await planAndApply([
    { type: 'settings.mainModel', value: 'claude-opus-5-5' },
    { type: 'settings.advisorModel', value: 'fable' },
    { type: 'settings.effort', model: 'claude-opus-5-5', value: 'high' },
  ]);
  const out = read(settingsPath).toString('utf8');
  for (const k of ['hooks', 'permissions', 'env', 'autoUpdatesChannel']) {
    assert.ok(Buffer.from(slice(out, k)).equals(Buffer.from(slice(USER_SETTINGS, k))), `${k} 的字节变了`);
  }
  // 原文到最后一个原有属性为止逐字节相同，新增的键追加在末尾
  const lastEnd = USER_SETTINGS.indexOf('"latest"') + '"latest"'.length;
  assert.ok(read(settingsPath).subarray(0, lastEnd).equals(Buffer.from(USER_SETTINGS.slice(0, lastEnd))));
  assert.equal(
    out,
    USER_SETTINGS.slice(0, lastEnd) +
      ',\r\n\t"model": "claude-opus-5-5",\r\n\t"advisorModel": "fable",\r\n\t"modelSettings": {\r\n\t\t"claude-opus-5-5": {\r\n\t\t\t"effortLevel": "high"\r\n\t\t}\r\n\t}' +
      USER_SETTINGS.slice(lastEnd),
  );
  assert.ok(!/[^\r]\n/.test(out), '仍然全部是 CRLF');
  assert.ok(out.split('\r\n').filter((l) => /^\s/.test(l)).every((l) => /^\t/.test(l)), '仍然是 Tab 缩进');
});

test('settings.json：修改已有的键只替换值；设为 null 删除键，其余不动', async () => {
  const beforeText = read(settingsPath).toString('utf8');
  await planAndApply([{ type: 'settings.mainModel', value: 'opus' }]);
  assert.equal(read(settingsPath).toString('utf8'), beforeText.replace('"model": "claude-opus-5-5"', '"model": "opus"'));
  await planAndApply([
    { type: 'settings.mainModel', value: null },
    { type: 'settings.advisorModel', value: null },
    { type: 'settings.effort', model: 'claude-opus-5-5', value: null },
  ]);
  assert.equal(read(settingsPath).toString('utf8'), USER_SETTINGS, '删掉加上的键后和最初逐字节相同');
});

test('settings.json：有 BOM 保持 BOM；末尾没有换行保持没有；空格缩进', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const text = '{\n    "theme": "dark"\n}';
  fs.writeFileSync(settingsPath, Buffer.concat([bom, Buffer.from(text)]));
  await planAndApply([{ type: 'settings.effort', model: null, value: 'medium' }]);
  const out = read(settingsPath);
  assert.ok(out.subarray(0, 3).equals(bom), '仍有 BOM');
  assert.equal(out.subarray(3).toString(), '{\n    "theme": "dark",\n    "effortLevel": "medium"\n}');
  assert.ok(!out.toString().endsWith('\n'), '末尾仍然没有换行');
});

test('settings.json：非法 JSON / 根不是对象 / modelSettings 类型不对 -> 计划 blocked，文件不动', async () => {
  for (const bad of ['{ "model": "x", }', '{\n  "a": 1\n  "b": 2\n}', '[1, 2]', '{"modelSettings": "oops"}']) {
    fs.writeFileSync(settingsPath, bad);
    const mtime = fs.statSync(settingsPath).mtimeMs;
    const p = await plan([{ type: 'settings.effort', model: 'claude-opus-5-5', value: 'high' }]);
    assert.equal(p.blocked, true, bad);
    assert.ok(p.errors.length > 0);
    const r = await apply(p.id);
    assert.ok(r.body.failed.length > 0, '被阻止的计划不能应用');
    assert.equal(read(settingsPath).toString(), bad, '文件没有被改动');
    assert.equal(fs.statSync(settingsPath).mtimeMs, mtime);
  }
  fs.writeFileSync(settingsPath, '{\n  "a": 1\n  "b": 2\n}');
  const p = await plan([{ type: 'settings.mainModel', value: 'opus' }]);
  assert.match(p.errors[0], /第 3 行第 3 列/, '给出行列号');
});

test('settings.json：不存在时新建，只含要写的键', async () => {
  fs.rmSync(settingsPath);
  const { plan: p } = await planAndApply([{ type: 'settings.mainModel', value: 'claude-opus-5-5' }]);
  assert.equal(p.changes[0].kind, 'create');
  assert.equal(read(settingsPath).toString(), '{\n  "model": "claude-opus-5-5"\n}\n');
});

test('settings.json：effort 为 max 时给出错误；顶层 effortLevel 给出对 Opus 5.5 不生效的提示', async () => {
  // 索引里还没有会话文件：不给桌面版提示（"全部来自桌面版"在空集合上不成立）
  const none = await plan([{ type: 'settings.effort', model: null, value: 'high' }]);
  assert.ok(!none.notes.some((n: any) => /桌面版/.test(n.message)));
  // 之后的断言需要最近的会话都来自桌面版
  store.db.prepare("UPDATE sessions SET entrypoint = 'claude-desktop' WHERE session_id = 's1'").run();
  store.db.prepare("INSERT OR IGNORE INTO files (path, session_id, project_dir, agent, first_ts, last_ts) VALUES ('s1.jsonl', 's1', 'P', 'main', '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z')").run();
  const p = await plan([{ type: 'settings.effort', model: null, value: 'max' }]);
  assert.equal(p.blocked, true);
  assert.match(p.errors[0], /max/);
  const q = await plan([{ type: 'settings.effort', model: null, value: 'high' }]);
  assert.ok(q.notes.some((n: any) => n.level === 'warn' && /Opus 5\.5/.test(n.message)));
  assert.ok(q.notes.some((n: any) => n.level === 'warn' && /桌面版/.test(n.message)));
  const r = await plan([{ type: 'settings.effort', model: 'opus', value: 'high' }]);
  assert.equal(r.blocked, true, 'modelSettings 的键不能是别名');
});

test('生成计划后文件被外部修改：应用失败，文件保持外部修改后的内容', async () => {
  fs.writeFileSync(settingsPath, '{\n  "model": "a"\n}\n');
  const p = await plan([{ type: 'settings.mainModel', value: 'b' }]);
  const external = '{\n  "model": "changed-by-someone"\n}\n';
  fs.writeFileSync(settingsPath, external);
  const r = await apply(p.id);
  assert.equal(r.body.applied.length, 0);
  assert.equal(r.body.failed.length, 1);
  assert.match(r.body.failed[0].reason, /被修改过/);
  assert.equal(r.body.failed[0].code, 'conflict');
  assert.equal(read(settingsPath).toString(), external);
});

test('同一个计划应用两次：第二次失败；过期的计划：失败', async () => {
  const p = await plan([{ type: 'settings.mainModel', value: 'c' }]);
  assert.equal((await apply(p.id)).status, 200);
  const second = await apply(p.id);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /已经应用过|不存在/);

  const q = await plan([{ type: 'settings.mainModel', value: 'd' }]);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60_000 });
  try {
    const r = await apply(q.id);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /过期/);
  } finally {
    mock.timers.reset();
  }
  // PlanStore 本身的过期判断
  const ps = new PlanStore();
  ps.put({ plan: { id: 'x', createdAt: '', expiresAt: new Date(Date.now() - 1).toISOString(), changes: [], notes: [], blocked: false, errors: [], conflicts: [] }, internal: [] });
  assert.equal(typeof ps.take('x'), 'string');
});

const AGENT_WITH_EXTRAS = [
  '---',
  'name: reviewer',
  '# 用户自己的注释',
  'description: >',
  '  Reviews code for',
  '  quality: and style',
  'color: red',
  'model: sonnet',
  'hooks:',
  '  PreToolUse:',
  '    - matcher: "Bash"',
  'experimental:',
  '  cacheTtl: 1h',
  'tools:',
  '  - Read',
  '  - Grep',
  'maxTurns: 5',
  '---',
  '',
  'You are a reviewer.',
  '',
  '---',
  '',
  'This line comes after a horizontal rule and must stay in the body.',
  '',
].join('\r\n');

test('agent 定义：不认识的 frontmatter 字段和注释原样保留、顺序不变；正文里的 --- 不是边界', async () => {
  fs.mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, 'reviewer.md');
  fs.writeFileSync(file, AGENT_WITH_EXTRAS);
  const detail = await call('GET', `/api/config/agent?path=${encodeURIComponent(file)}`, undefined, H);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.description, 'Reviews code for quality: and style', '能读多行 description');
  assert.equal(detail.body.tools, 'Read, Grep', '能读 YAML 列表');
  assert.deepEqual(detail.body.otherFields, ['color', 'hooks', 'experimental', 'maxTurns']);
  assert.ok(detail.body.body.includes('\r\n---\r\n'), '正文里的 --- 在正文中');
  const { plan: p } = await planAndApply([
    {
      type: 'agent.upsert',
      scope: 'user',
      projectCwd: null,
      name: 'reviewer',
      originalName: null,
      fields: { description: detail.body.description, model: 'opus', effort: 'high', tools: detail.body.tools },
      body: null,
      baseHash: detail.body.hash,
    },
  ]);
  assert.match(p.changes[0].summary, /model 从 sonnet 改为 opus/);
  const expected = AGENT_WITH_EXTRAS.replace('model: sonnet', 'model: opus').replace('maxTurns: 5\r\n---', 'maxTurns: 5\r\neffort: high\r\n---');
  assert.ok(read(file).equals(Buffer.from(expected)), '只改了 model 行、在末尾追加了 effort 行，其余逐字节不变');
  // 正文编辑：只替换正文
  const d2 = (await call('GET', `/api/config/agent?path=${encodeURIComponent(file)}`, undefined, H)).body;
  await planAndApply([
    {
      type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'reviewer', originalName: null,
      fields: { description: d2.description, model: d2.model, effort: d2.effort, tools: null },
      body: 'New prompt.\n\n---\n\nStill body.\n', baseHash: d2.hash,
    },
  ]);
  const out = read(file).toString();
  assert.ok(out.startsWith(expected.slice(0, expected.indexOf('tools:'))), 'tools 之前的内容不变');
  assert.ok(!out.includes('tools:') && !out.includes('  - Read'), 'tools 传 null 时删除这个字段（包括列表续行）');
  assert.ok(out.endsWith('---\r\n\r\nNew prompt.\r\n\r\n---\r\n\r\nStill body.\r\n'), '正文按文件的 CRLF 写入，frontmatter 后的分隔空行保留');
  // 读出来的正文不含分隔空行；原样提交回去不算改动
  const d3 = (await call('GET', `/api/config/agent?path=${encodeURIComponent(file)}`, undefined, H)).body;
  assert.equal(d3.body, 'New prompt.\r\n\r\n---\r\n\r\nStill body.\r\n');
  const same = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'reviewer', originalName: null, fields: { description: d3.description, model: d3.model, effort: d3.effort, tools: d3.tools }, body: d3.body, baseHash: d3.hash }]);
  assert.equal(same.changes.length, 0, '原样提交不算修改');
});

test('agent 定义：新建后读回的正文和提交的一致（不带分隔空行），from-config 的 prompt 也一致；再提交不算改动', async () => {
  const body = '你是执行者。\n\n- 只改要求的范围\n';
  const { result } = await planAndApply([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'worker', originalName: null, fields: { description: '干活', model: null, effort: null, tools: null }, body, baseHash: null }]);
  const file = path.join(agentsDir, 'worker.md');
  assert.equal(read(file).toString(), `---\nname: worker\ndescription: "干活"\n---\n\n${body}`, '文件里 frontmatter 和正文之间空一行');
  const d = (await call('GET', `/api/config/agent?path=${encodeURIComponent(file)}`, undefined, H)).body;
  assert.equal(d.body, body, '读回的正文没有多出开头的空行');
  // 从配置生成预设时的 prompt 也是一样的（这个测试的 app 没有真实的 analyzer，直接调函数）
  const { configSnapshot, presetFromConfig } = await import('../src/claudeConfig.ts');
  assert.equal(presetFromConfig(await configSnapshot([]), null).agents.find((a) => a.name === 'worker')!.prompt, body);
  const same = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'worker', originalName: null, fields: { description: '干活', model: null, effort: null, tools: null }, body, baseHash: d.hash }]);
  assert.equal(same.changes.length, 0);
  // 提示词自己以空行开头：只去掉分隔的那一行，多出来的空行属于提示词
  const p = await planAndApply([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'worker', originalName: null, fields: { description: '干活', model: null, effort: null, tools: null }, body: '\n开头有空行\n', baseHash: d.hash }]);
  assert.equal(read(file).toString(), '---\nname: worker\ndescription: "干活"\n---\n\n\n开头有空行\n');
  assert.equal((await call('GET', `/api/config/agent?path=${encodeURIComponent(file)}`, undefined, H)).body.body, '\n开头有空行\n');
  void p;
  void result;
});

test('PUT /api/preset：agent 名字不合法（含空格、路径穿越、Windows 保留名）-> 400，不保存', async () => {
  for (const name of ['bad name!', '../evil', 'nul', 'a/b']) {
    const r = await call('PUT', '/api/preset', { version: 1, main: { model: null, effort: null, autoCompactWindow: null }, advisor: { model: null }, agents: [{ name, model: null, effort: null }], allowBuiltins: true, updatedAt: null });
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, /agents\[0\]\.name 不合法/, name);
  }
  assert.equal((await call('GET', '/api/preset', undefined, H)).body.agents.length, 0, '没有保存');
});

test('agent 定义：新建（值含冒号 / 井号加引号）、同名拒绝、内置名拒绝、改名、删除和恢复', async () => {
  const { plan: p } = await planAndApply([
    {
      type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'helper', originalName: null,
      fields: { description: 'Use when: #1 priority\nsecond line', model: 'claude-opus-5-5', effort: null, tools: 'Read, Grep' },
      body: null, baseHash: null,
    },
  ]);
  assert.equal(p.changes[0].kind, 'create');
  const helper = path.join(agentsDir, 'helper.md');
  const text = read(helper).toString();
  assert.ok(text.startsWith('---\nname: helper\ndescription: "Use when: #1 priority\\nsecond line"\nmodel: claude-opus-5-5\ntools: Read, Grep\n---\n\n'), text);
  const d = (await call('GET', `/api/config/agent?path=${encodeURIComponent(helper)}`, undefined, H)).body;
  assert.equal(d.description, 'Use when: #1 priority\nsecond line', '引号里的值能读回来');

  const dup = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'helper', originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: null, baseHash: null }]);
  assert.equal(dup.blocked, true);
  assert.match(dup.errors[0], /已存在/);
  const builtin = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'Explore', originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: null, baseHash: null }]);
  assert.equal(builtin.blocked, true);
  assert.match(builtin.errors[0], /内置类型/);

  // 改名：新文件存在，旧文件进备份
  const beforeRename = read(helper);
  const { result } = await planAndApply([
    { type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'helper2', originalName: 'helper', fields: { description: d.description, model: d.model, effort: d.effort, tools: d.tools }, body: null, baseHash: d.hash },
  ]);
  const helper2 = path.join(agentsDir, 'helper2.md');
  assert.ok(fs.existsSync(helper2));
  assert.ok(!fs.existsSync(helper));
  assert.ok(read(helper2).toString().includes('name: helper2'));
  const del = result.applied.find((a: any) => a.kind === 'delete');
  const bak = listBackups().find((b) => b.id === del.backupId)!;
  assert.equal(bak.existedBefore, true);
  assert.ok(fs.readFileSync(path.join(home, 'backups', `${bak.id}.bak`)).equals(beforeRename), '旧文件内容在备份目录里');

  // 删除：文件进备份，可以恢复
  const h2 = read(helper2);
  const d3 = (await call('GET', `/api/config/agent?path=${encodeURIComponent(helper2)}`, undefined, H)).body;
  const { result: r2 } = await planAndApply([{ type: 'agent.delete', filePath: helper2, baseHash: d3.hash }]);
  assert.ok(!fs.existsSync(helper2));
  const restorePlan = await call('POST', '/api/config/restore', { backupId: r2.applied[0].backupId });
  assert.equal(restorePlan.body.blocked, false);
  assert.equal(restorePlan.body.changes[0].kind, 'create');
  const rr = await apply(restorePlan.body.id);
  assert.deepEqual(rr.body.failed, []);
  assert.ok(read(helper2).equals(h2), '恢复后与删除前逐字节相同');
});

test('agent 定义：frontmatter 格式异常时 blocked', async () => {
  const f = path.join(agentsDir, 'broken.md');
  fs.writeFileSync(f, '---\nname: broken\ndescription: x\nthis line is not yaml\n---\nbody\n');
  const d = await call('GET', `/api/config/agent?path=${encodeURIComponent(f)}`, undefined, H);
  assert.equal(d.status, 422);
  const hash = (await import('../src/config/text.ts')).sha256(read(f));
  const p = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'broken', originalName: null, fields: { description: 'x', model: 'opus', effort: null, tools: null }, body: null, baseHash: hash }]);
  assert.equal(p.blocked, true);
  assert.match(p.errors[0], /frontmatter/);
  fs.writeFileSync(f, '---\nname: broken\ndescription: never closed\n');
  const p2 = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'broken', originalName: null, fields: { description: 'x', model: 'opus', effort: null, tools: null }, body: null, baseHash: (await import('../src/config/text.ts')).sha256(read(f)) }]);
  assert.equal(p2.blocked, true);
  fs.rmSync(f);
});

test('CLAUDE.md：追加规则后原内容逐字节不变；启用再停用恢复成逐字节相同', async () => {
  const original = Buffer.from('# 我的规则\r\n\r\n- 用中文回答\r\n');
  fs.writeFileSync(claudeMdPath, original);
  await planAndApply([{ type: 'claudeMd.rule', enabled: true, text: null }]);
  const enabled = read(claudeMdPath);
  assert.ok(enabled.subarray(0, original.length).equals(original), '原内容是新文件的前缀，逐字节不变');
  const tail = enabled.subarray(original.length).toString();
  assert.ok(tail.startsWith('\r\n<!-- agentree:advisor-rule:start -->\r\n## 何时咨询 advisor\r\n'), '和原内容之间空一行，沿用 CRLF');
  assert.ok(tail.endsWith('<!-- agentree:advisor-rule:end -->\r\n'));
  const state = (await call('GET', '/api/config/rule', undefined, H)).body;
  assert.equal(state.enabled, true);
  assert.equal(state.error, null, '正常时 error 为 null');
  // 已有规则块：只替换标记之间
  await planAndApply([{ type: 'claudeMd.rule', enabled: true, text: '自定义规则' }]);
  assert.ok(read(claudeMdPath).subarray(0, original.length).equals(original));
  assert.equal((await call('GET', '/api/config/rule', undefined, H)).body.text, '自定义规则');
  await planAndApply([{ type: 'claudeMd.rule', enabled: false, text: null }]);
  assert.ok(read(claudeMdPath).equals(original), '停用后与启用前逐字节相同');
});

test('CLAUDE.md：各种结尾形状下启用再停用都能逐字节还原', () => {
  for (const c of ['', 'x', 'x\n', 'x\n\n', 'a\r\nb', 'a\r\nb\r\n', 'a\r\n\r\n\r\n']) {
    const on = enableRule(c, 'rule');
    assert.ok(on.includes('rule'));
    assert.equal(disableRule(on), c, JSON.stringify(c));
  }
});

test('CLAUDE.md：只有开始标记或标记重复 -> 计划 blocked', async () => {
  for (const bad of ['text\n<!-- agentree:advisor-rule:start -->\nrule\n', '<!-- agentree:advisor-rule:start -->\na\n<!-- agentree:advisor-rule:end -->\n<!-- agentree:advisor-rule:start -->\nb\n<!-- agentree:advisor-rule:end -->\n']) {
    fs.writeFileSync(claudeMdPath, bad);
    for (const enabled of [true, false]) {
      const p = await plan([{ type: 'claudeMd.rule', enabled, text: null }]);
      assert.equal(p.blocked, true);
      assert.match(p.errors[0], /手动处理/);
    }
    assert.equal(read(claudeMdPath).toString(), bad);
    const st = (await call('GET', '/api/config/rule', undefined, H)).body;
    assert.equal(st.enabled, false);
    assert.equal(st.text, null);
    assert.match(st.error, /手动处理/, 'GET /api/config/rule 给出标记损坏的说明');
  }
  // 非 UTF-8 也给出说明
  fs.writeFileSync(claudeMdPath, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  assert.match((await call('GET', '/api/config/rule', undefined, H)).body.error, /UTF-8/);
  // 文件不存在：error 为 null
  fs.rmSync(claudeMdPath);
  const none = (await call('GET', '/api/config/rule', undefined, H)).body;
  assert.deepEqual([none.fileExists, none.enabled, none.error], [false, false, null]);
});

test('路径穿越和白名单外的路径：拒绝', async () => {
  for (const name of ['../evil', 'a/b', 'a\\b', '..', '.hidden', 'CON', 'nul', 'x'.repeat(65), '']) {
    const p = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name, originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: null, baseHash: null }]);
    assert.equal(p.blocked, true, name);
  }
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, '---\nname: outside\ndescription: x\n---\n');
  for (const fp of [outside, path.join(agentsDir, '..', '..', 'outside.md'), path.join(cfg, 'other.md'), path.join(cfg, 'settings.json'), 'relative/agents/x.md']) {
    const p = await plan([{ type: 'agent.delete', filePath: fp, baseHash: 'x' }]);
    assert.equal(p.blocked, true, fp);
    const g = await call('GET', `/api/config/agent?path=${encodeURIComponent(fp)}`, undefined, H);
    assert.ok(g.status === 403 || g.status === 400, `${fp} -> ${g.status}`);
  }
  assert.ok(fs.existsSync(outside), '白名单外的文件没被动');
  // 项目级：只允许索引里出现过的工作目录
  const bad = await plan([{ type: 'agent.upsert', scope: 'project', projectCwd: root, name: 'p1', originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: null, baseHash: null }]);
  assert.equal(bad.blocked, true);
  assert.match(bad.errors[0], /没有在索引过的会话里出现过/);
  const ok = await planAndApply([{ type: 'agent.upsert', scope: 'project', projectCwd: project, name: 'p1', originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: 'b', baseHash: null }]);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'agents', 'p1.md')));
  assert.equal(ok.plan.changes.length, 1);
});

test('符号链接：agents 目录链接到白名单外时拒绝', async (t) => {
  const cfg2 = path.join(root, 'claude-link');
  const target = path.join(root, 'elsewhere');
  fs.mkdirSync(cfg2, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, path.join(cfg2, 'agents'), 'junction');
  } catch {
    t.skip('当前环境不能创建目录链接');
    return;
  }
  process.env.CLAUDE_CONFIG_DIR = cfg2;
  try {
    const p = await plan([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'linked', originalName: null, fields: { description: 'x', model: null, effort: null, tools: null }, body: null, baseHash: null }]);
    assert.equal(p.blocked, true);
    assert.match(p.errors[0], /符号链接/);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = cfg;
  }
});

test('写接口防护：没带令牌 403，text/plain 415，外部 Origin 403；GET /api/token 不带跨域头', async () => {
  const body = JSON.stringify({ actions: [{ type: 'settings.mainModel', value: 'x' }] });
  const noToken = await app.request('/api/config/plan', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body });
  assert.equal(noToken.status, 403);
  const wrongToken = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, 'x-agentree-token': 'nope' }, body });
  assert.equal(wrongToken.status, 403);
  const plain = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, 'content-type': 'text/plain' }, body });
  assert.equal(plain.status, 415);
  const evil = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, origin: 'https://evil.example' }, body });
  assert.equal(evil.status, 403);
  const local = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, origin: 'http://127.0.0.1:5173' }, body });
  assert.equal(local.status, 200);
  // Tauri 共用来源不放行：放行它们等于信任本机任何一个 Tauri 应用的页面
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'null', 'http://127.0.0.1.evil.example', 'file://']) {
    const r = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, origin }, body });
    assert.equal(r.status, 403, origin);
    const g = await app.request('/api/token', { headers: { ...H, origin } });
    assert.equal(g.status, 403, `GET /api/token ${origin}`);
  }
  for (const origin of ['http://localhost:4777', 'http://[::1]:4777', 'https://127.0.0.1']) {
    const r = await app.request('/api/config/plan', { method: 'POST', headers: { ...W, origin }, body });
    assert.equal(r.status, 200, origin);
  }
  for (const [m, u] of [['PUT', '/api/preset'], ['POST', '/api/reindex'], ['POST', '/api/config/apply'], ['POST', '/api/config/restore'], ['POST', '/api/preset/from-config']]) {
    const r = await app.request(u, { method: m, headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  const tok = await app.request('/api/token', { headers: { ...H, origin: 'http://localhost:5173' } });
  assert.equal(tok.status, 200);
  assert.equal((await tok.json()).token, TOKEN);
  for (const [k] of tok.headers) assert.ok(!k.toLowerCase().startsWith('access-control-'), k);
  const tokEvil = await app.request('/api/token', { headers: { ...H, origin: 'https://evil.example' } });
  assert.equal(tokEvil.status, 403);
  assert.ok(![...tokEvil.headers.keys()].some((k) => k.startsWith('access-control-')));
});

test('备份：首写备份在第一次修改前生成，之后的修改不会覆盖它；恢复后与备份逐字节相同', async () => {
  const f = path.join(agentsDir, 'bk.md');
  const v0 = Buffer.from('---\nname: bk\ndescription: v0\n---\n\nbody\n');
  fs.writeFileSync(f, v0);
  const edit = async (desc: string) => {
    const d = (await call('GET', `/api/config/agent?path=${encodeURIComponent(f)}`, undefined, H)).body;
    return planAndApply([{ type: 'agent.upsert', scope: 'user', projectCwd: null, name: 'bk', originalName: null, fields: { description: desc, model: null, effort: null, tools: null }, body: null, baseHash: d.hash }]);
  };
  await edit('v1');
  const fw = () => listBackups().filter((b) => b.kind === 'first-write' && b.filePath.toLowerCase() === fs.realpathSync.native(f).toLowerCase());
  assert.equal(fw().length, 1);
  const fwId = fw()[0].id;
  assert.ok(fs.readFileSync(path.join(home, 'backups', `${fwId}.bak`)).equals(v0));
  const v1 = read(f);
  await edit('v2');
  await edit('v3');
  assert.equal(fw().length, 1, '只有一份首写备份');
  assert.equal(fw()[0].id, fwId);
  assert.ok(fs.readFileSync(path.join(home, 'backups', `${fwId}.bak`)).equals(v0), '首写备份内容没被覆盖');
  const pcs = listBackups().filter((b) => b.kind === 'pre-change' && b.filePath.toLowerCase() === fs.realpathSync.native(f).toLowerCase());
  assert.equal(pcs.length, 3);
  assert.ok(fs.existsSync(path.join(home, 'backups', `${pcs[0].id}.json`)), '每份备份旁边有元数据');
  // 恢复首写备份：逐字节相同；恢复前对当前状态再备份一次
  const rp = await call('POST', '/api/config/restore', { backupId: fwId });
  assert.equal(rp.body.changes[0].kind, 'modify');
  const rr = await apply(rp.body.id);
  assert.deepEqual(rr.body.failed, []);
  assert.ok(read(f).equals(v0));
  assert.equal(listBackups().filter((b) => b.kind === 'pre-change' && b.filePath.toLowerCase() === fs.realpathSync.native(f).toLowerCase()).length, 4);
  // 恢复变更前备份（v2 之前的状态是 v1）
  const v1Backup = listBackups().filter((b) => b.kind === 'pre-change' && b.filePath.toLowerCase() === fs.realpathSync.native(f).toLowerCase()).at(-2)!;
  const rp2 = await call('POST', '/api/config/restore', { backupId: v1Backup.id });
  await apply(rp2.body.id);
  assert.ok(read(f).equals(v1));
});

test('备份：变更前备份每个文件只保留最近 20 份', async () => {
  const { backupBeforeChange, PRE_CHANGE_KEEP } = await import('../src/config/backups.ts');
  const p = path.join(agentsDir, 'many.md');
  for (let i = 0; i < 25; i++) backupBeforeChange(p, Buffer.from(String(i)));
  const list = listBackups().filter((b) => b.filePath === p);
  assert.equal(list.filter((b) => b.kind === 'pre-change').length, PRE_CHANGE_KEEP);
  assert.equal(list.filter((b) => b.kind === 'first-write').length, 1);
});

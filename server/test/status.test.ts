import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, isLive, notificationStatus, PENDING_TOOL_WINDOW_MS, type StatusInput } from '../src/status.ts';
import { LineBatch } from '../src/parser.ts';
import { assistant, toolResult } from './helpers.ts';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const MIN = 60_000;
function input(p: Partial<StatusInput>): StatusInput {
  return { now: NOW, lastWriteMs: null, lastRecordMs: null, pendingTool: false, result: null, notification: null, ...p };
}

test('中止：任务通知状态为 stopped 或 killed 时是 stopped，不是 completed', () => {
  assert.equal(notificationStatus('stopped'), 'stopped');
  assert.equal(notificationStatus('killed'), 'stopped');
  assert.equal(notificationStatus('failed'), 'failed');
  assert.equal(notificationStatus('completed'), 'completed');
  const bg = { status: 'async_launched', isAsync: true, ts: '2026-09-29T11:00:00.000Z' };
  for (const s of ['stopped', 'killed']) {
    const r = agentStatus(input({ lastWriteMs: NOW - 60 * MIN, result: bg, notification: { status: s, ts: '2026-09-29T11:10:00.000Z' } }));
    assert.equal(r.status, 'stopped', s);
    assert.equal(r.doneMs, Date.parse('2026-09-29T11:10:00.000Z'));
  }
});

test('中止后又被继续（结束信号之后还有新写入）算 running', () => {
  const r = agentStatus(
    input({
      lastWriteMs: NOW - 5_000,
      lastRecordMs: NOW - 5_000,
      result: { status: 'async_launched', isAsync: true, ts: null },
      notification: { status: 'killed', ts: new Date(NOW - 10 * MIN).toISOString() },
    }),
  );
  assert.equal(r.status, 'running');
});

test('running 放宽：没有完成信号，最后一条是等待结果的 tool_use，最后写入在 30 分钟内', () => {
  assert.equal(agentStatus(input({ lastWriteMs: NOW - 30_000 })).status, 'running', '120 秒内有写入');
  assert.equal(agentStatus(input({ lastWriteMs: NOW - 10 * MIN })).status, 'unknown', '没有等待中的工具，超过 120 秒');
  assert.equal(agentStatus(input({ lastWriteMs: NOW - 10 * MIN, pendingTool: true })).status, 'running', '长时间编译');
  assert.equal(agentStatus(input({ lastWriteMs: NOW - 29 * MIN, pendingTool: true })).status, 'running');
  assert.equal(agentStatus(input({ lastWriteMs: NOW - 31 * MIN, pendingTool: true })).status, 'unknown', '超过 30 分钟仍无结果');
  assert.equal(PENDING_TOOL_WINDOW_MS, 30 * MIN);
  // 已经有完成信号的不受影响
  const done = agentStatus(input({ lastWriteMs: NOW - 10 * MIN, pendingTool: true, result: { status: 'completed', isAsync: false, ts: null } }));
  assert.equal(done.status, 'completed');
  assert.equal(isLive({ now: NOW, lastWriteMs: null, pendingTool: true }), false);
});

test('解析：文件末尾等待结果的 tool_use 状态，跨批次延续', () => {
  const b1 = new LineBatch(false);
  // 同一消息拆成多行：先 thinking/text，再 tool_use
  b1.addLine(assistant({ id: 'm1', u: { o: 1 } }));
  assert.equal(b1.hasPendingTool, false);
  b1.addLine(assistant({ id: 'm1', u: { o: 2 }, toolUses: [{ id: 't1', name: 'Bash' }] }));
  assert.equal(b1.hasPendingTool, true);
  // 下一批（增量读取）接着上一批的状态
  const b2 = new LineBatch(false, b1.pending);
  assert.equal(b2.hasPendingTool, true);
  b2.addLine(toolResult({ toolUseId: 't1', result: { stdout: '' } }));
  assert.equal(b2.hasPendingTool, false, '拿到结果');
  // 并行工具：只回来一个结果时仍在等待
  b2.addLine(assistant({ id: 'm2', u: { o: 1 }, toolUses: [{ id: 'a', name: 'Read' }, { id: 'b', name: 'Bash' }] }));
  b2.addLine(toolResult({ toolUseId: 'a', result: {} }));
  assert.equal(b2.hasPendingTool, true);
  b2.addLine(toolResult({ toolUseId: 'b', result: {} }));
  assert.equal(b2.hasPendingTool, false);
  // 新的纯文本消息、用户中断都会清空
  b2.addLine(assistant({ id: 'm3', u: { o: 1 }, toolUses: [{ id: 'c', name: 'Bash' }] }));
  b2.addLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  assert.equal(b2.hasPendingTool, false);
  b2.addLine(assistant({ id: 'm4', u: { o: 1 }, toolUses: [{ id: 'd', name: 'Bash' }] }));
  b2.addLine(assistant({ id: 'm5', u: { o: 1 } }));
  assert.equal(b2.hasPendingTool, false);
});

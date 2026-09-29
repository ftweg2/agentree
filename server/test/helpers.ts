// 测试用的日志行构造器与临时目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** 在系统临时目录下创建本次测试专用的目录，测试结束时由 cleanupTmp 删除 */
export function tmpDir(prefix = 'agentree-test-'): string {
  if (!/^agentree-[a-z]+-$/.test(prefix)) throw new Error(`临时目录前缀必须形如 agentree-xxx-：${prefix}`);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/** 删除本进程用 tmpDir 创建的目录。只删自己创建的、位于系统临时目录下、名字以 agentree- 开头的目录 */
export function cleanupTmp(): void {
  const tmp = path.resolve(os.tmpdir());
  for (const d of created.splice(0)) {
    const abs = path.resolve(d);
    if (path.dirname(abs) !== tmp || !path.basename(abs).startsWith('agentree-')) continue;
    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface U {
  i?: number;
  o?: number;
  cr?: number;
  cc?: number;
  c5?: number;
  c1?: number;
}

export function assistant(opts: {
  id?: string | null;
  requestId?: string | null;
  uuid?: string;
  model?: string;
  u?: U;
  ts?: string;
  effort?: string;
  advisorModel?: string;
  agentId?: string;
  toolUses?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  iterations?: Array<Record<string, unknown>>;
}): string {
  const u = opts.u ?? {};
  const cc = u.cc ?? (u.c5 ?? 0) + (u.c1 ?? 0);
  const rec: Record<string, unknown> = {
    type: 'assistant',
    uuid: opts.uuid ?? Math.random().toString(36).slice(2),
    requestId: opts.requestId === undefined ? undefined : opts.requestId,
    timestamp: opts.ts ?? '2026-09-28T10:00:00.000Z',
    sessionId: 'S',
    effort: opts.effort,
    advisorModel: opts.advisorModel,
    agentId: opts.agentId,
    message: {
      id: opts.id === null ? undefined : opts.id,
      model: opts.model ?? 'claude-opus-5-5',
      content: (opts.toolUses ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} })),
      usage: {
        input_tokens: u.i ?? 0,
        output_tokens: u.o ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        cache_creation_input_tokens: cc,
        cache_creation: { ephemeral_5m_input_tokens: u.c5 ?? cc - (u.c1 ?? 0), ephemeral_1h_input_tokens: u.c1 ?? 0 },
        iterations: opts.iterations ?? [{ type: 'message' }],
      },
    },
  };
  return JSON.stringify(rec);
}

export function toolResult(opts: { toolUseId: string; result: Record<string, unknown>; ts?: string }): string {
  return JSON.stringify({
    type: 'user',
    uuid: Math.random().toString(36).slice(2),
    timestamp: opts.ts ?? '2026-09-28T10:05:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: opts.toolUseId, content: 'x' }] },
    toolUseResult: opts.result,
  });
}

export function notification(taskId: string, status: string, ts = '2026-09-28T10:06:00.000Z'): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: ts,
    sessionId: 'S',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
  });
}

export function userPrompt(text: string, ts = '2026-09-28T09:59:00.000Z'): string {
  return JSON.stringify({ type: 'user', uuid: 'u0', timestamp: ts, cwd: 'C:\\proj', entrypoint: 'cli', version: '9.9.9', message: { role: 'user', content: text } });
}

// 子 agent 状态判断。纯函数。
import type { AgentStatus } from '../../shared/types.ts';
import { ACTIVE_WINDOW_MS } from './config.ts';

/** 最后一条记录是还没拿到结果的 tool_use 时，最多等多久仍算运行中（长时间编译等） */
export const PENDING_TOOL_WINDOW_MS = 30 * 60_000;

export interface StatusInput {
  now: number;
  /** 该 agent 文件的最近写入时间（毫秒）；没有文件为 null */
  lastWriteMs: number | null;
  /** 该 agent 文件最后一条记录的时间戳（毫秒） */
  lastRecordMs: number | null;
  /** 该 agent 文件最后一条记录是否是还没拿到结果的 tool_use */
  pendingTool: boolean;
  /** 父级的工具结果 */
  result: { status: string | null; isAsync: boolean; ts: string | null } | null;
  /** 任务通知里的状态（同一 agent 取最新一条） */
  notification: { status: string; ts: string | null } | null;
}

export interface StatusOutput {
  status: AgentStatus;
  /** 完成 / 失败 / 中止信号的时间 */
  doneMs: number | null;
}

function ms(ts: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

const FAILED = ['error', 'failed'];
const STOPPED = ['stopped', 'killed'];

/** 通知状态 -> agent 状态 */
export function notificationStatus(s: string): AgentStatus {
  const v = s.toLowerCase();
  if (FAILED.includes(v)) return 'failed';
  if (STOPPED.includes(v)) return 'stopped';
  return 'completed';
}

/** 没有结束信号时是否还在运行：最近 120 秒有写入；或最后一条是等待结果的 tool_use 且最后写入在 30 分钟内 */
export function isLive(i: Pick<StatusInput, 'now' | 'lastWriteMs' | 'pendingTool'>): boolean {
  if (i.lastWriteMs === null) return false;
  const age = i.now - i.lastWriteMs;
  if (age < ACTIVE_WINDOW_MS) return true;
  return i.pendingTool && age < PENDING_TOOL_WINDOW_MS;
}

export function agentStatus(i: StatusInput): StatusOutput {
  let status: AgentStatus = 'unknown';
  let doneMs: number | null = null;
  const r = i.result;
  const n = i.notification;
  if (r && r.status && FAILED.includes(r.status.toLowerCase())) {
    status = 'failed';
    doneMs = ms(r.ts);
  } else if (r && !r.isAsync) {
    status = 'completed';
    doneMs = ms(r.ts);
  } else if (n) {
    status = notificationStatus(n.status);
    doneMs = ms(n.ts);
  }
  const live = isLive(i);
  if (status !== 'unknown') {
    // 结束后又被继续（SendMessage 续跑）：结束信号之后还有新写入
    if (live && i.lastRecordMs !== null && doneMs !== null && i.lastRecordMs > doneMs + 2000) status = 'running';
  } else if (live) status = 'running';
  return { status, doneMs };
}

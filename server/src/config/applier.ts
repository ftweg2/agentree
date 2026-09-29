// 应用计划：逐个文件按"比对 hash -> 首写备份 -> 变更前备份 -> 写临时文件并刷盘 -> 再比对 hash -> 重命名"执行。
// 某个文件失败时，已成功的保留，后面的不再继续。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ApplyFailureCode, ApplyResult, ChangePlan } from '../../../shared/types.ts';
import { backupBeforeChange, backupFilePath } from './backups.ts';
import { checkWritable } from './paths.ts';
import type { InternalChange, StoredPlan } from './planner.ts';
import { sha256 } from './text.ts';

const RENAME_RETRIES = 3;
const RENAME_DELAY_MS = 100;

/** 内存里的计划：10 分钟过期，应用一次后作废 */
export class PlanStore {
  private plans = new Map<string, StoredPlan>();

  put(p: StoredPlan): void {
    this.gc();
    this.plans.set(p.plan.id, p);
  }

  /** 取出并作废。过期或不存在返回原因 */
  take(id: unknown): StoredPlan | string {
    this.gc();
    if (typeof id !== 'string') return 'planId 必须是字符串';
    const p = this.plans.get(id);
    if (!p) return '计划不存在、已经应用过或已过期，请重新生成计划';
    this.plans.delete(id);
    if (Date.parse(p.plan.expiresAt) <= Date.now()) return '计划已过期（超过 10 分钟），请重新生成计划';
    return p;
  }

  private gc() {
    const now = Date.now();
    for (const [id, p] of this.plans) if (Date.parse(p.plan.expiresAt) <= now) this.plans.delete(id);
  }
}

function currentHash(filePath: string): string | null {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function readIfExists(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => T): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= RENAME_RETRIES; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (i === RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) break;
      await sleep(RENAME_DELAY_MS);
    }
  }
  throw last;
}

function expectMatches(c: InternalChange, hash: string | null): string | null {
  if (c.kind === 'create') return hash === null ? null : '文件在生成计划之后被创建了，请重新生成计划';
  if (hash === null) return '文件在生成计划之后被删除了，请重新生成计划';
  if (hash !== c.baseHash) return '文件在生成计划之后被修改过，请重新生成计划';
  return null;
}

type OneResult = { backupId: string; backupPath: string | null } | { code: ApplyFailureCode; error: string };

function conflict(message: string): OneResult {
  return { code: 'conflict', error: message };
}

/** 把异常归类成失败代码 */
export function classifyError(e: unknown): ApplyFailureCode {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EROFS') return 'permission';
  return 'io';
}

async function applyOne(c: InternalChange, knownCwds: string[]): Promise<OneResult> {
  // 再过一次白名单（计划生成后目录可能被换成符号链接）
  let target: string;
  try {
    target = checkWritable(c.filePath, knownCwds).path;
  } catch (e) {
    return { code: 'not-allowed', error: (e as Error).message };
  }
  // 1-2. 读取并比对 hash
  const bytes = readIfExists(target);
  const mismatch = expectMatches(c, bytes ? sha256(bytes) : null);
  if (mismatch) return conflict(mismatch);
  // 3-4. 首写备份（如需要）和变更前备份
  const { preChange } = backupBeforeChange(target, bytes);
  const done = { backupId: preChange.id, backupPath: backupFilePath(preChange) };
  if (c.kind === 'delete') {
    // 删除：内容已在备份目录（相当于移到备份目录），再次比对后删除原文件
    const again = expectMatches(c, currentHash(target));
    if (again) return conflict(again);
    await withRetry(() => fs.unlinkSync(target));
    return done;
  }
  // 5. 写到同目录的临时文件并刷盘
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.agentree-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, c.afterBytes!);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // 6. 再次比对，防止在备份和写临时文件期间又被改
    const again = expectMatches(c, currentHash(target));
    if (again) {
      fs.rmSync(tmp, { force: true });
      return conflict(again);
    }
    // 7. 重命名覆盖（Windows 上失败重试 3 次，每次间隔 100 毫秒）
    await withRetry(() => fs.renameSync(tmp, target));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return done;
}

/**
 * 应用计划。applied 加 failed 的数量等于计划里的文件数：
 * 失败的文件之后的文件以 skipped 列在 failed 里；blocked 的计划每个文件都以 blocked 列出。
 */
export async function applyPlan(stored: StoredPlan, knownCwds: string[]): Promise<Omit<ApplyResult, 'config'>> {
  const plan: ChangePlan = stored.plan;
  const result: Omit<ApplyResult, 'config'> = { planId: plan.id, applied: [], failed: [] };
  if (plan.blocked) {
    const reason = `计划被阻止，不能应用：${plan.errors.join('；')}`;
    for (const c of stored.internal) result.failed.push({ filePath: c.filePath, code: 'blocked', reason });
    // 被阻止时可能一个文件变更都还没算出来：仍然给出一条说明
    if (!stored.internal.length) result.failed.push({ filePath: '', code: 'blocked', reason });
    return result;
  }
  for (let i = 0; i < stored.internal.length; i++) {
    const c = stored.internal[i];
    let r: OneResult;
    try {
      r = await applyOne(c, knownCwds);
    } catch (e) {
      const code = classifyError(e);
      r = { code, error: `${code === 'permission' ? '没有写权限或文件被占用' : '读写失败'}：${(e as Error).message}` };
    }
    if ('error' in r) {
      result.failed.push({ filePath: c.filePath, code: r.code, reason: r.error });
      for (const rest of stored.internal.slice(i + 1)) {
        result.failed.push({ filePath: rest.filePath, code: 'skipped', reason: '前面的文件失败，这个文件没有执行' });
      }
      break;
    }
    result.applied.push({ filePath: c.filePath, kind: c.kind, backupId: r.backupId, backupPath: r.backupPath });
  }
  return result;
}

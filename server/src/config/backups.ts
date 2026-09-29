// 备份：~/.agentree/backups/。首写备份永久保留；变更前备份每个文件保留最近 20 份。
// 每份备份是一对文件：<id>.bak（原文件字节，原文件不存在时没有）和 <id>.json（元数据）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupEntry } from '../../../shared/types.ts';
import { agentreeHome } from '../config.ts';

export const PRE_CHANGE_KEEP = 20;

export function backupDir(): string {
  const d = path.join(agentreeHome(), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const ID_RE = /^[0-9]{8}T[0-9]{9}-[0-9a-f]{8}-(fw|pc)$/;

export function isBackupId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function listBackups(): BackupEntry[] {
  const dir = backupDir();
  const out: BackupEntry[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BackupEntry;
      if (isBackupId(m.id) && typeof m.filePath === 'string') out.push(m);
    } catch {
      /* 坏的元数据跳过 */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function getBackup(id: string): { entry: BackupEntry; bytes: Buffer | null } | null {
  if (!isBackupId(id)) return null;
  const dir = backupDir();
  let entry: BackupEntry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
  const bytes = entry.existedBefore ? fs.readFileSync(path.join(dir, `${id}.bak`)) : null;
  return { entry, bytes };
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
}

function write(kind: BackupEntry['kind'], filePath: string, bytes: Buffer | null): BackupEntry {
  const dir = backupDir();
  const now = new Date();
  const id = `${stamp(now)}-${crypto.randomBytes(4).toString('hex')}-${kind === 'first-write' ? 'fw' : 'pc'}`;
  const entry: BackupEntry = {
    id,
    filePath,
    createdAt: now.toISOString(),
    kind,
    existedBefore: bytes !== null,
    size: bytes?.length ?? 0,
  };
  if (bytes) {
    const fd = fs.openSync(path.join(dir, `${id}.bak`), 'wx');
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2), { flag: 'wx' });
  return entry;
}

/** 备份内容文件的完整路径；备份时原文件不存在（那次操作是新建）则没有内容文件，返回 null */
export function backupFilePath(entry: BackupEntry): string | null {
  return entry.existedBefore ? path.join(backupDir(), `${entry.id}.bak`) : null;
}

export function hasFirstWrite(filePath: string): boolean {
  return listBackups().some((b) => b.kind === 'first-write' && samePath(b.filePath, filePath));
}

/** 修改一个文件之前调用：必要时做首写备份，然后做变更前备份，并清理多余的变更前备份 */
export function backupBeforeChange(filePath: string, bytes: Buffer | null): { firstWrite: BackupEntry | null; preChange: BackupEntry } {
  const firstWrite = hasFirstWrite(filePath) ? null : write('first-write', filePath, bytes);
  const preChange = write('pre-change', filePath, bytes);
  prune(filePath);
  return { firstWrite, preChange };
}

function prune(filePath: string) {
  const dir = backupDir();
  const pcs = listBackups().filter((b) => b.kind === 'pre-change' && samePath(b.filePath, filePath));
  for (const b of pcs.slice(PRE_CHANGE_KEEP)) {
    for (const ext of ['.bak', '.json']) {
      try {
        fs.unlinkSync(path.join(dir, b.id + ext));
      } catch {
        /* 已不存在 */
      }
    }
  }
}

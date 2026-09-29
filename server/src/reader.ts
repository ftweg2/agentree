// 按字节偏移量增量读取 jsonl。只处理到最后一个完整换行符，半行留到下次。
import fs from 'node:fs/promises';

const CHUNK = 4 * 1024 * 1024;
const FP_LEN = 64;

/** 偏移量之前若干字节的指纹，格式 "长度:base64"，用于发现文件被原地重写 */
export function fingerprintOf(bytes: Buffer): string {
  return `${bytes.length}:${bytes.toString('base64')}`;
}

export interface ReadResult {
  /** 处理完之后新的偏移量（指向下一行的开头） */
  offset: number;
  /** 未处理的尾部字节数（半行） */
  pendingBytes: number;
}

/**
 * 从 start 读到 end（不含），每凑满一批完整行就回调一次。
 * onLines 返回后才继续读，调用方可以在回调里同步写库并更新偏移量。
 * acceptTrailing 为 true 时，末尾没有换行但本身是完整 JSON 的最后一行也会被处理
 * （用于长时间没有写入、写入方显然已经结束的文件）。
 */
export async function readLines(
  filePath: string,
  start: number,
  end: number,
  onLines: (lines: string[], offsetAfter: number, tailFingerprint: string) => void | Promise<void>,
  opts: { acceptTrailing?: boolean } = {},
): Promise<ReadResult> {
  const fh = await fs.open(filePath, 'r');
  try {
    let pos = start;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = start; // carry 第一个字节在文件里的位置
    let offset = start;
    while (pos < end) {
      const len = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lines: string[] = [];
      let lineStart = 0;
      // 文件开头的 UTF-8 BOM
      if (carryStart === 0 && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) lineStart = 3;
      let nl = data.indexOf(0x0a, lineStart);
      while (nl !== -1) {
        let lineEnd = nl;
        if (lineEnd > lineStart && data[lineEnd - 1] === 0x0d) lineEnd--;
        if (lineEnd > lineStart) lines.push(data.toString('utf8', lineStart, lineEnd));
        lineStart = nl + 1;
        nl = data.indexOf(0x0a, lineStart);
      }
      const consumedTo = carryStart + lineStart;
      carry = Buffer.from(data.subarray(lineStart));
      carryStart = consumedTo;
      if (consumedTo > offset) {
        offset = consumedTo;
        await onLines(lines, offset, fingerprintOf(data.subarray(Math.max(0, lineStart - FP_LEN), lineStart)));
      }
    }
    if (carry.length && opts.acceptTrailing) {
      const text = carry.toString('utf8').trim();
      if (text) {
        let ok = false;
        try {
          JSON.parse(text);
          ok = true;
        } catch {
          ok = false;
        }
        if (ok) {
          offset = carryStart + carry.length;
          await onLines([text], offset, fingerprintOf(carry.subarray(Math.max(0, carry.length - FP_LEN))));
          carry = Buffer.alloc(0);
        }
      }
    }
    return { offset, pendingBytes: carry.length };
  } finally {
    await fh.close();
  }
}


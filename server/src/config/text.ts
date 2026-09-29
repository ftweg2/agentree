// 文本文件的读取与格式探测：UTF-8 校验、BOM、行尾符、sha256。
import crypto from 'node:crypto';
import fs from 'node:fs';

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface TextFile {
  exists: boolean;
  /** 原始字节；不存在为 null */
  bytes: Buffer | null;
  /** 去掉 BOM 之后的文本；不存在为 ''；不是 UTF-8 时为 null */
  text: string | null;
  bom: boolean;
  hash: string | null;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(bytes: Buffer): { text: string | null; bom: boolean } {
  const bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM);
  try {
    return { text: decoder.decode(bom ? bytes.subarray(3) : bytes), bom };
  } catch {
    return { text: null, bom };
  }
}

export function readTextFile(filePath: string): TextFile {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, bytes: null, text: '', bom: false, hash: null };
    throw e;
  }
  const { text, bom } = decodeUtf8(bytes);
  return { exists: true, bytes, text, bom, hash: sha256(bytes) };
}

export function encodeText(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([BOM, body]) : body;
}

/** 文件里有 CRLF 就用 CRLF，否则 LF */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 字符偏移 -> 1 起的行号和列号 */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

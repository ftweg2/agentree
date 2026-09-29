// 基于最长公共子序列的行级差异，不依赖第三方库。

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  /** 旧文件行号（从 1 开始）；新增行为 null */
  oldNo: number | null;
  /** 新文件行号；删除行为 null */
  newNo: number | null;
}

export interface TextInfo {
  lines: string[];
  /** 末尾是否有换行 */
  finalNewline: boolean;
  crlf: boolean;
  bom: boolean;
}

export function splitText(s: string | null): TextInfo {
  if (s == null) return { lines: [], finalNewline: false, crlf: false, bom: false };
  let t = s;
  const bom = t.charCodeAt(0) === 0xfeff;
  if (bom) t = t.slice(1);
  const crlf = t.includes('\r\n');
  const lines = t.split(/\r?\n/);
  const finalNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  if (lines.length === 1 && lines[0] === '' && t === '') lines.pop();
  return { lines, finalNewline, crlf, bom };
}

/** 超过这个规模（去掉首尾相同部分之后）就不做 LCS，直接显示整段替换 */
const MAX_CELLS = 6_000_000;

export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
      for (let i = 0; i < n; i++) out.push({ type: 'del', text: a[start + i], oldNo: start + i + 1, newNo: null });
      for (let j = 0; j < m; j++) out.push({ type: 'add', text: b[start + j], oldNo: null, newNo: start + j + 1 });
    } else {
      // dp[i][j] = a[start+i..] 与 b[start+j..] 的 LCS 长度
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * w + j] =
            a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
          out.push({ type: 'same', text: a[start + i], oldNo: start + i + 1, newNo: start + j + 1 });
          i++;
          j++;
        } else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
          out.push({ type: 'add', text: b[start + j], oldNo: null, newNo: start + j + 1 });
          j++;
        } else {
          out.push({ type: 'del', text: a[start + i], oldNo: start + i + 1, newNo: null });
          i++;
        }
      }
      // 同一处改动里先显示删除再显示新增，更易读
      reorderBlocks(out);
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ type: 'same', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return out;
}

function reorderBlocks(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'same') {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type !== 'same') j++;
    const block = lines.slice(i, j);
    const dels = block.filter((l) => l.type === 'del');
    const adds = block.filter((l) => l.type === 'add');
    lines.splice(i, j - i, ...dels, ...adds);
    i = j;
  }
}

export type DiffChunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'fold'; lines: DiffLine[] };

/** 只保留改动处上下 context 行，其余未改动的长段折叠 */
export function toChunks(lines: DiffLine[], context = 3): DiffChunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const chunks: DiffChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    const k = keep[i];
    while (j < lines.length && keep[j] === k) j++;
    const seg = lines.slice(i, j);
    // 很短的未改动段不值得折叠
    if (!k && seg.length >= 4) chunks.push({ kind: 'fold', lines: seg });
    else {
      const last = chunks[chunks.length - 1];
      if (last && last.kind === 'lines') last.lines.push(...seg);
      else chunks.push({ kind: 'lines', lines: seg });
    }
    i = j;
  }
  return chunks;
}

export function diffStats(lines: DiffLine[]) {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}

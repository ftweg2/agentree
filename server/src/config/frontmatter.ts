// agent 定义文件的 frontmatter：按行解析、按行修改。不用 YAML 库重新序列化。
// 格式以官方文档 sub-agents.md 为准：文件第一行是 ---，到下一行 --- 为止是 YAML frontmatter，之后是正文（系统提示词）。
// 只有第一对 --- 是边界，正文里再出现 --- 不影响。

export class FrontmatterError extends Error {}

export interface FmField {
  key: string;
  /** 在 lines 里的起止行（含 start，不含 end），包括多行值的续行 */
  start: number;
  end: number;
  /** 解析出来的值（标量为字符串，列表用 ", " 连接）；无法解析为 null */
  value: string | null;
}

export interface AgentDoc {
  eol: '\r\n' | '\n';
  bom: boolean;
  /** frontmatter 内部的行（不含两条 ---） */
  lines: string[];
  fields: FmField[];
  /** 开头那行 ---（保留原样，可能带尾随空格） */
  openLine: string;
  closeLine: string;
  /** 闭合 --- 之后是否有换行（文件只有 frontmatter 且末尾没换行时为 false） */
  closeEol: boolean;
  /** 闭合 --- 那一行之后的全部内容（正文），原样保留 */
  body: string;
}

const KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

function unquoteSingle(s: string): string {
  return s.slice(1, -1).replace(/''/g, "'");
}

function unquoteDouble(s: string): string {
  try {
    return JSON.parse(s.replace(/\\\//g, '/'));
  } catch {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
}

function stripComment(s: string): string {
  const i = s.search(/\s#/);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/** 解析一个字段的值（首行冒号后的部分 + 续行） */
function parseValue(first: string, cont: string[]): string | null {
  const v = first.trim();
  if (v === '' || v.startsWith('#')) {
    const items = cont.filter((l) => /^\s*-\s+/.test(l)).map((l) => stripComment(l.replace(/^\s*-\s+/, '')).replace(/^(['"])(.*)\1$/, '$2'));
    if (items.length) return items.join(', ');
    const nested = cont.filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (nested.length) return null; // 嵌套映射之类，agentree 不解释它
    return '';
  }
  const block = /^([|>])([+-]?)(\d*)\s*(#.*)?$/.exec(v);
  if (block) {
    const lines = [...cont];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
    const min = indents.length ? Math.min(...indents) : 0;
    const body = lines.map((l) => l.slice(min));
    if (block[1] === '|') return body.join('\n');
    // 折叠：段落内的行用空格连接，段落之间换行
    const paras: string[] = [];
    let cur: string[] = [];
    for (const l of body) {
      if (l.trim() === '') {
        if (cur.length) paras.push(cur.join(' '));
        cur = [];
      } else cur.push(l.trim());
    }
    if (cur.length) paras.push(cur.join(' '));
    return paras.join('\n');
  }
  if (v.startsWith('"')) {
    const all = [v, ...cont.map((l) => l.trim())].join(' ');
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(all);
    return m ? unquoteDouble(`"${m[1]}"`) : null;
  }
  if (v.startsWith("'")) {
    const all = [v, ...cont.map((l) => l.trim())].join(' ');
    const m = /^'((?:[^']|'')*)'/.exec(all);
    return m ? unquoteSingle(`'${m[1]}'`) : null;
  }
  if (v.startsWith('[')) {
    const all = [v, ...cont.map((l) => l.trim())].join(' ');
    const m = /^\[(.*)\]/.exec(all);
    if (!m) return null;
    return m[1]
      .split(',')
      .map((x) => x.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter(Boolean)
      .join(', ');
  }
  // 普通标量：续行折叠成空格
  const parts = [stripComment(v), ...cont.map((l) => stripComment(l)).filter(Boolean)];
  return parts.join(' ').trim();
}

/** 解析 agent 定义文件。没有 frontmatter 或格式异常时抛出带行号的错误 */
export function parseAgentDoc(text: string, bom = false): AgentDoc {
  const eol: '\r\n' | '\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const all = text.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(all[0] ?? '')) throw new FrontmatterError('第 1 行不是 ---，没有 frontmatter');
  let close = -1;
  for (let i = 1; i < all.length; i++) {
    if (/^---[ \t]*$/.test(all[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new FrontmatterError('frontmatter 没有闭合的 ---');
  const lines = all.slice(1, close);
  const fields: FmField[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = KEY_RE.exec(line);
    if (!m) {
      if (/^\s/.test(line) || /^-\s/.test(line)) {
        if (!fields.length) throw new FrontmatterError(`frontmatter 第 ${i + 2} 行是缩进内容，但前面没有字段`);
        continue; // 续行，属于上一个字段
      }
      throw new FrontmatterError(`frontmatter 第 ${i + 2} 行无法识别：不是 "字段: 值" 的格式`);
    }
    if (fields.some((f) => f.key === m[1])) throw new FrontmatterError(`frontmatter 第 ${i + 2} 行字段 ${m[1]} 重复`);
    fields.push({ key: m[1], start: i, end: i + 1, value: null });
  }
  // 确定每个字段的范围：到下一个字段为止，末尾的空行和注释行不归它
  for (let k = 0; k < fields.length; k++) {
    const f = fields[k];
    let end = k + 1 < fields.length ? fields[k + 1].start : lines.length;
    while (end > f.start + 1 && (!lines[end - 1].trim() || /^#/.test(lines[end - 1]))) end--;
    f.end = end;
    const first = KEY_RE.exec(lines[f.start])![2] ?? '';
    f.value = parseValue(first, lines.slice(f.start + 1, f.end));
  }
  // 正文：闭合行之后的原始文本
  let pos = 0;
  for (let i = 0; i <= close; i++) {
    pos = text.indexOf('\n', pos);
    if (pos < 0) {
      pos = text.length;
      break;
    }
    pos += 1;
  }
  const closeEol = close !== all.length - 1;
  const body = closeEol ? text.slice(pos) : '';
  return { eol, bom, lines, fields, openLine: all[0], closeLine: all[close], closeEol, body };
}

/**
 * 正文作为系统提示词。Claude Code 的约定是 frontmatter 和正文之间空一行，这个分隔用的空行属于文件格式、不属于提示词：
 * 正文以一个空行开头时去掉恰好这一行（再多的空行是提示词自己的）。文件里没有分隔空行时原样返回
 */
export function promptOf(doc: AgentDoc): string {
  const m = /^[ \t]*\r?\n/.exec(doc.body);
  return m ? doc.body.slice(m[0].length) : doc.body;
}

/**
 * 用系统提示词替换正文：文件原来有分隔空行的仍然保留，原来没有正文的补上一个（新建文件的写法）。
 * 换行按文件的风格。提示词没变时不动，返回 false
 */
export function setPrompt(doc: AgentDoc, prompt: string): boolean {
  const cur = promptOf(doc);
  const next = prompt.replace(/\r?\n/g, doc.eol);
  if (next === cur) return false;
  const lead = doc.body === '' ? doc.eol : doc.body.slice(0, doc.body.length - cur.length);
  doc.body = lead + next;
  doc.closeEol = true;
  return true;
}

export function getField(doc: AgentDoc, key: string): string | null {
  return doc.fields.find((f) => f.key === key)?.value ?? null;
}

/** 写入时是否需要加引号：含冒号、井号、首字符是 YAML 特殊字符、首尾空白、看起来像布尔 / 数字 / null */
export function needsQuote(v: string): boolean {
  if (v === '') return true;
  if (/[:#\n\r\t"'\\]/.test(v)) return true;
  if (/^[\s\-?,[\]{}&*!|>%@`]/.test(v) || /\s$/.test(v)) return true;
  if (/^(true|false|yes|no|on|off|null|~|y|n)$/i.test(v)) return true;
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v) || /^0x[0-9a-f]+$/i.test(v)) return true;
  return false;
}

/** YAML 双引号字符串（JSON 字符串是合法的 YAML 双引号标量） */
export function quote(v: string): string {
  return JSON.stringify(v);
}

export function formatScalar(key: string, v: string): string {
  // description 统一写成单行加引号
  if (key === 'description') return `${key}: ${quote(v)}`;
  return `${key}: ${needsQuote(v) ? quote(v) : v}`;
}

/**
 * 设置字段。value 为 null 删除该字段（包括它的续行）；
 * 已存在且值相同则不动（保留原来的写法）；不存在则追加在 frontmatter 末尾。
 */
export function setField(doc: AgentDoc, key: string, value: string | null): boolean {
  const idx = doc.fields.findIndex((f) => f.key === key);
  if (idx >= 0) {
    const f = doc.fields[idx];
    if (value !== null && f.value === value) return false;
    const replacement = value === null ? [] : [formatScalar(key, value)];
    const removed = f.end - f.start;
    doc.lines.splice(f.start, removed, ...replacement);
    const delta = replacement.length - removed;
    doc.fields.splice(idx, 1, ...(value === null ? [] : [{ key, start: f.start, end: f.start + 1, value }]));
    for (const g of doc.fields) if (g.start > f.start) {
      g.start += delta;
      g.end += delta;
    }
    return true;
  }
  if (value === null) return false;
  // 追加到最后一个非空行之后（保留末尾的空行 / 注释位置不变）
  let at = doc.lines.length;
  while (at > 0 && !doc.lines[at - 1].trim()) at--;
  doc.lines.splice(at, 0, formatScalar(key, value));
  doc.fields.push({ key, start: at, end: at + 1, value });
  return true;
}

export function serializeAgentDoc(doc: AgentDoc): string {
  return [doc.openLine, ...doc.lines, doc.closeLine].join(doc.eol) + (doc.closeEol || doc.body ? doc.eol : '') + doc.body;
}

/** 新建文件的内容 */
export function newAgentText(fields: Array<[string, string | null]>, body: string, eol: '\r\n' | '\n' = '\n'): string {
  const lines = fields.filter(([, v]) => v !== null).map(([k, v]) => formatScalar(k, v as string));
  const b = body.replace(/\r?\n/g, eol);
  return ['---', ...lines, '---'].join(eol) + eol + eol + b + (b.endsWith(eol) || b === '' ? '' : eol);
}

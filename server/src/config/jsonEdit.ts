// settings.json 的保留格式修改。
// 只用 jsonc-parser 定位节点，修改本身是按文本位置手工拼接的最小编辑：
// jsonc-parser 自带的 modify 在插入 / 删除时会顺带重排相邻属性（实测会把 {"a": 1} 展开成多行），
// 不满足"其余部分一个字节都不动"，所以不用它生成编辑。
import { findNodeAtLocation, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { detectEol, lineCol } from './text.ts';

export class JsonEditError extends Error {}

export interface JsonDoc {
  text: string;
  root: Node;
  eol: '\r\n' | '\n';
  /** 一级缩进单位（\t 或若干空格） */
  indent: string;
}

/** 从已有内容探测缩进单位：取以空白开头、后面跟着 " 的行里最短的缩进 */
export function detectIndent(text: string): string {
  let best: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([ \t]+)"/.exec(line);
    if (!m) continue;
    const ws = m[1];
    if (ws.includes('\t')) return '\t';
    if (best === null || ws.length < best.length) best = ws;
  }
  return best ?? '  ';
}

/** 严格解析（不允许注释和尾逗号）。失败时抛出带行列号的错误 */
export function parseJsonDoc(text: string, label = 'settings.json'): JsonDoc {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || !root) {
    const e = errors[0];
    if (e) {
      const { line, col } = lineCol(text, e.offset);
      throw new JsonEditError(`${label} 第 ${line} 行第 ${col} 列解析失败（${printParseErrorCode(e.error)}），不是合法的 JSON`);
    }
    throw new JsonEditError(`${label} 内容为空或无法解析`);
  }
  if (root.type !== 'object') throw new JsonEditError(`${label} 的根不是对象（实际是 ${root.type}），拒绝修改`);
  return { text, root, eol: detectEol(text), indent: detectIndent(text) };
}

function lineIndentAt(text: string, offset: number): string {
  let s = offset;
  while (s > 0 && text[s - 1] !== '\n') s--;
  const m = /^[ \t]*/.exec(text.slice(s, offset));
  return m ? m[0] : '';
}

function isOnOwnLine(text: string, offset: number): boolean {
  let s = offset;
  while (s > 0 && text[s - 1] !== '\n') {
    if (text[s - 1] !== ' ' && text[s - 1] !== '\t') return false;
    s--;
  }
  return true;
}

/** 按文档风格格式化一个值（只用于新增的键） */
function formatValue(value: unknown, indent: string, unit: string, eol: string, compact: boolean): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    if (compact) return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v, '', unit, eol, true)}`).join(', ')} }`;
    const inner = indent + unit;
    return `{${eol}${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatValue(v, inner, unit, eol, false)}`).join(`,${eol}`)}${eol}${indent}}`;
  }
  return JSON.stringify(value);
}

function propertyNode(obj: Node, key: string): Node | undefined {
  return obj.children?.find((p) => p.children?.[0]?.value === key);
}

/** 读取某个路径上的节点（不存在返回 undefined） */
export function nodeAt(doc: JsonDoc, path: string[]): Node | undefined {
  return findNodeAtLocation(doc.root, path);
}

/**
 * 设置 path 上的值为 value（只支持写入标量或由标量组成的对象）。
 * 已存在：只替换值本身的文本。不存在：作为所在对象的最后一个属性追加，中间缺的对象一并创建。
 * 路径上已有的节点不是对象时抛错，不做任何修改。
 */
export function setValue(doc: JsonDoc, path: string[], value: unknown, label = 'settings.json'): string {
  const { text, eol, indent: unit } = doc;
  let obj = doc.root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const prop = propertyNode(obj, key);
    if (prop) {
      const valNode = prop.children![1];
      if (i === path.length - 1) {
        return text.slice(0, valNode.offset) + JSON.stringify(value) + text.slice(valNode.offset + valNode.length);
      }
      if (valNode.type !== 'object') {
        throw new JsonEditError(`${label} 里 ${path.slice(0, i + 1).join('.')} 的类型是 ${valNode.type}，不是对象，拒绝修改`);
      }
      obj = valNode;
      continue;
    }
    // 从这里开始缺失：构造剩余路径的值
    let newValue: unknown = value;
    for (let j = path.length - 1; j > i; j--) newValue = { [path[j]]: newValue };
    const props = obj.children ?? [];
    const open = obj.offset; // '{'
    const close = obj.offset + obj.length - 1; // '}'
    if (props.length) {
      const lastProp = props[props.length - 1];
      const end = lastProp.offset + lastProp.length;
      if (isOnOwnLine(text, lastProp.offset)) {
        const ind = lineIndentAt(text, lastProp.offset);
        const ins = `,${eol}${ind}${JSON.stringify(key)}: ${formatValue(newValue, ind, unit, eol, false)}`;
        return text.slice(0, end) + ins + text.slice(end);
      }
      // 单行对象：保持单行
      const ins = `, ${JSON.stringify(key)}: ${formatValue(newValue, '', unit, eol, true)}`;
      return text.slice(0, end) + ins + text.slice(end);
    }
    // 空对象：展开成多行
    const parentIndent = obj === doc.root ? lineIndentAt(text, open) : lineIndentAt(text, open);
    const inner = parentIndent + unit;
    const body = `${eol}${inner}${JSON.stringify(key)}: ${formatValue(newValue, inner, unit, eol, false)}${eol}${parentIndent}`;
    return text.slice(0, open + 1) + body + text.slice(close);
  }
  return text;
}

/**
 * 删除 path 上的属性（不存在则原样返回）。
 * 只删除这个属性和它与相邻属性之间的逗号 / 空白，其余文本不动。
 * pruneEmptyParent 为 true 时，删除后父对象变空则把父属性也删掉（用于 modelSettings.<模型>）。
 */
export function removeValue(doc: JsonDoc, path: string[], label = 'settings.json', pruneEmptyParent = false): string {
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? findNodeAtLocation(doc.root, parentPath) : doc.root;
  if (!parent) return doc.text;
  if (parent.type !== 'object') throw new JsonEditError(`${label} 里 ${parentPath.join('.')} 不是对象，拒绝修改`);
  const props = parent.children ?? [];
  const idx = props.findIndex((p) => p.children?.[0]?.value === path[path.length - 1]);
  if (idx < 0) return doc.text;
  if (props.length === 1 && pruneEmptyParent && parentPath.length > 0) {
    return removeValue(parseJsonDoc(doc.text, label), parentPath, label, true);
  }
  const text = doc.text;
  const prop = props[idx];
  let start: number;
  let end: number;
  if (props.length === 1) {
    // 唯一的属性：清空对象内部，得到 {}
    start = parent.offset + 1;
    end = parent.offset + parent.length - 1;
  } else if (idx < props.length - 1) {
    // 不是最后一个：删到下一个属性的开头，下一个属性接替它的位置和缩进
    start = prop.offset;
    end = props[idx + 1].offset;
  } else {
    // 最后一个：从上一个属性末尾删到它自己末尾（带走中间的逗号）
    const prev = props[idx - 1];
    start = prev.offset + prev.length;
    end = prop.offset + prop.length;
  }
  return text.slice(0, start) + text.slice(end);
}

/** 新建 settings.json 时的内容：只含要写的键，两空格缩进，LF，末尾换行 */
export function newJsonText(entries: Array<[string[], unknown]>): string {
  let text = '{}';
  for (const [path, value] of entries) text = setValue(parseJsonDoc(text), path, value);
  return text + '\n';
}

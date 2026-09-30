// CLAUDE.md 里 agentree 管理的规则块（分工规则和 advisor 规则）。标记之外的内容一个字节都不动。
// 标记沿用最早的 advisor-rule 名字，兼容已经写进用户文件的块。默认文字按方案生成，见 shared/rule.ts
import { ADVISOR_RULE_TEXT } from '../../../shared/rule.ts';
import { detectEol } from './text.ts';

export const RULE_START = '<!-- agentree:advisor-rule:start -->';
export const RULE_END = '<!-- agentree:advisor-rule:end -->';

/**
 * 兜底文字：只在配置页手动启用规则（claudeMd.rule 不带正文）、而已保存的方案里既没有子 agent 也没有 advisor 时使用。
 * 其余情况的默认文字都按方案生成（shared/rule.ts 的 defaultRuleText）
 */
export const FALLBACK_RULE_TEXT = ADVISOR_RULE_TEXT;

export class RuleBlockError extends Error {}

export interface RuleBlock {
  /** 开始标记第一个字符的位置 */
  start: number;
  /** 结束标记最后一个字符之后的位置 */
  end: number;
  /** 标记之间的正文（去掉紧贴标记的换行） */
  text: string;
}

function countOf(text: string, needle: string): number {
  let n = 0;
  let i = text.indexOf(needle);
  while (i >= 0) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

/** 找规则块。没有返回 null；标记不成对或出现多次时抛错 */
export function findRuleBlock(text: string): RuleBlock | null {
  const ns = countOf(text, RULE_START);
  const ne = countOf(text, RULE_END);
  if (ns === 0 && ne === 0) return null;
  if (ns > 1 || ne > 1) throw new RuleBlockError('CLAUDE.md 里 agentree 的规则标记出现了多次，请手动处理后再试');
  if (ns !== ne) {
    throw new RuleBlockError(
      ns ? 'CLAUDE.md 里只有规则的开始标记，没有结束标记，请手动处理后再试' : 'CLAUDE.md 里只有规则的结束标记，没有开始标记，请手动处理后再试',
    );
  }
  const start = text.indexOf(RULE_START);
  const endMarker = text.indexOf(RULE_END);
  if (endMarker < start) throw new RuleBlockError('CLAUDE.md 里规则的结束标记在开始标记之前，请手动处理后再试');
  const inner = text.slice(start + RULE_START.length, endMarker).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return { start, end: endMarker + RULE_END.length, text: inner.replace(/\r\n/g, '\n') };
}

function normalizeRuleText(ruleText: string, eol: string): string {
  return ruleText.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split('\n').join(eol);
}

/**
 * 启用规则。没有规则块：追加到末尾，和原内容之间空一行；已有：只替换两个标记之间的内容。
 * 追加的形状保证停用时能逐字节还原：
 * - 原内容以换行结尾：原内容 + 换行 + 规则块 + 换行
 * - 原内容不以换行结尾：原内容 + 两个换行 + 规则块（末尾同样不加换行）
 * - 原内容为空：规则块 + 换行
 */
export function enableRule(text: string, ruleText: string): string {
  const eol = text ? detectEol(text) : '\n';
  const body = normalizeRuleText(ruleText, eol);
  const block = `${RULE_START}${eol}${body}${eol}${RULE_END}`;
  const existing = findRuleBlock(text);
  if (existing) return text.slice(0, existing.start) + block + text.slice(existing.end);
  if (text === '') return block + eol;
  if (text.endsWith('\n')) return text + eol + block + eol;
  return text + eol + eol + block;
}

/** 停用规则：删除标记和中间的内容，以及因此多出来的空行。没有规则块则原样返回 */
export function disableRule(text: string): string {
  const b = findRuleBlock(text);
  if (!b) return text;
  const eol = detectEol(text);
  let before = text.slice(0, b.start);
  let after = text.slice(b.end);
  const afterHadEol = after.startsWith(eol) || after.startsWith('\n');
  if (after.startsWith('\r\n')) after = after.slice(2);
  else if (after.startsWith('\n')) after = after.slice(1);
  if (after === '') {
    // 规则块在末尾：按启用时的形状去掉分隔
    if (afterHadEol) {
      if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
    } else if (before.endsWith(eol + eol)) {
      before = before.slice(0, -2 * eol.length);
    }
    return before + after;
  }
  // 规则块在中间：前后都是空行时去掉一个，避免出现多余的空行
  if ((before === '' || before.endsWith(eol + eol)) && (after.startsWith(eol) || after.startsWith('\n'))) {
    after = after.startsWith('\r\n') ? after.slice(2) : after.slice(1);
  }
  return before + after;
}

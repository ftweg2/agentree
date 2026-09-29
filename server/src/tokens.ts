import type { ModelUsage, TokenTotals } from '../../shared/types.ts';

export function zeroTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 };
}

export function makeTokens(input: number, output: number, cacheRead: number, cw5m: number, cw1h: number): TokenTotals {
  return { input, output, cacheRead, cacheWrite5m: cw5m, cacheWrite1h: cw1h, total: input + output + cacheRead + cw5m + cw1h };
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return makeTokens(
    a.input + b.input,
    a.output + b.output,
    a.cacheRead + b.cacheRead,
    a.cacheWrite5m + b.cacheWrite5m,
    a.cacheWrite1h + b.cacheWrite1h,
  );
}

/** 费用累加：任一有用量的部分查不到价格，结果就是 null（不猜、不给部分和） */
export class CostAcc {
  private sum = 0;
  private unknown = false;
  add(cost: number | null, tokens: number) {
    if (cost === null) {
      if (tokens > 0) this.unknown = true;
    } else this.sum += cost;
  }
  get value(): number | null {
    return this.unknown ? null : Math.round(this.sum * 1e6) / 1e6;
  }
}

/** 按模型名合并 ModelUsage 列表，按请求数、token 从多到少排序 */
export function mergeModelUsages(lists: ModelUsage[][], costOf: (model: string, t: TokenTotals) => number | null): ModelUsage[] {
  const map = new Map<string, { requests: number; tokens: TokenTotals }>();
  for (const list of lists) {
    for (const m of list) {
      const prev = map.get(m.model);
      if (prev) {
        prev.requests += m.requests;
        prev.tokens = addTokens(prev.tokens, m.tokens);
      } else map.set(m.model, { requests: m.requests, tokens: { ...m.tokens } });
    }
  }
  return sortModels([...map].map(([model, v]) => ({ model, requests: v.requests, tokens: v.tokens, costUsd: costOf(model, v.tokens) })));
}

export function sortModels(list: ModelUsage[]): ModelUsage[] {
  return list.sort((a, b) => b.requests - a.requests || b.tokens.total - a.tokens.total || a.model.localeCompare(b.model));
}

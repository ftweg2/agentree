// 价格：LiteLLM 价格表，缓存 24 小时。查不到的模型返回 null，不猜。
import fs from 'node:fs';
import path from 'node:path';
import { agentreeHome } from './config.ts';
import { normalizeModel } from './conformance.ts';
import type { TokenTotals } from '../../shared/types.ts';

const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 24 * 3600 * 1000;

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function pricingFile() {
  return path.join(agentreeHome(), 'pricing.json');
}

/** 价格表里的键归一化：去掉厂商前缀（anthropic/、bedrock/…、anthropic.）、版本后缀（-v1:0、@2024…）、日期 */
function normalizeKey(k: string): string {
  let m = k.toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/^(us|eu|apac|au|jp|global)\./, '').replace(/^anthropic\./, '');
  m = m.replace(/-v\d+(:\d+)?$/, '').replace(/@\d{8}$/, '').replace(/@latest$/, '');
  return normalizeModel(m);
}

export class Pricing {
  private table = new Map<string, Price>();
  version = 0;
  source: 'none' | 'cache' | 'network' = 'none';

  load(): void {
    try {
      const raw = fs.readFileSync(pricingFile(), 'utf8');
      this.ingest(JSON.parse(raw));
      this.source = 'cache';
    } catch {
      // 没有缓存
    }
  }

  /** 缓存超过 24 小时或不存在时下载；失败不影响其他功能 */
  async refresh(): Promise<void> {
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(pricingFile()).mtimeMs;
    } catch {
      /* 无缓存 */
    }
    if (age < MAX_AGE_MS && this.table.size > 0) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text);
      this.ingest(data);
      fs.writeFileSync(pricingFile(), text);
      this.source = 'network';
    } catch (e) {
      console.warn(`[agentree] 价格表下载失败（${(e as Error).message}），${this.table.size ? '继续使用缓存' : '费用将显示为空'}`);
    }
  }

  private ingest(data: Record<string, any>): void {
    const table = new Map<string, { price: Price; score: number }>();
    for (const [key, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object') continue;
      const inp = v.input_cost_per_token;
      const out = v.output_cost_per_token;
      if (typeof inp !== 'number' || typeof out !== 'number') continue;
      const price: Price = {
        input: inp,
        output: out,
        cacheRead: typeof v.cache_read_input_token_cost === 'number' ? v.cache_read_input_token_cost : inp * 0.1,
        cacheWrite5m: typeof v.cache_creation_input_token_cost === 'number' ? v.cache_creation_input_token_cost : inp * 1.25,
        cacheWrite1h:
          typeof v.cache_creation_input_token_cost_above_1hr === 'number' ? v.cache_creation_input_token_cost_above_1hr : inp * 2,
      };
      const nk = normalizeKey(key);
      // 同一归一化键有多个来源时，优先 Anthropic 官方条目、其次不带厂商前缀的原始键
      // 区域前缀（us./eu./…）的价格通常有溢价，排在最后
      const score =
        (v.litellm_provider === 'anthropic' ? 4 : 0) +
        (key.toLowerCase() === nk ? 2 : 0) -
        (/^(us|eu|apac|au|jp|global)\./i.test(key.slice(key.lastIndexOf('/') + 1)) ? 1 : 0);
      const prev = table.get(nk);
      if (!prev || score > prev.score) table.set(nk, { price, score });
    }
    this.table = new Map([...table].map(([k, v]) => [k, v.price]));
    this.version++;
  }

  /** 价格表里所有模型的归一化名字 */
  modelIds(): string[] {
    return [...this.table.keys()];
  }

  lookup(model: string): Price | null {
    if (!model || model === '<synthetic>') return null;
    return this.table.get(normalizeModel(model)) ?? null;
  }

  cost(model: string, t: TokenTotals): number | null {
    const p = this.lookup(model);
    if (!p) return null;
    const c = t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h;
    return Math.round(c * 1e6) / 1e6;
  }
}

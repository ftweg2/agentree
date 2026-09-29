// 可选的模型清单：价格表里的 Claude 模型，加上本机日志里出现过的模型。
// 价格表每天更新，新模型出来后不用改代码就会出现在清单里。
import type { ModelOption } from '../../shared/types.ts';
import { normalizeModel } from './conformance.ts';
import type { Store } from './db.ts';
import type { Pricing } from './pricing.ts';

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type Family = (typeof FAMILIES)[number];

/** claude-<系列>-<主版本>[-<次版本>]，如 claude-opus-5-5。旧式命名（claude-3-5-sonnet）和带其他后缀的不算 */
const ID_RE = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/;

/** 价格表和日志都没有数据时的兜底，保证下拉框不是空的 */
const FALLBACK = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];

function parse(id: string): { family: Family; major: number; minor: number } | null {
  const m = ID_RE.exec(id);
  // 次版本是 8 位数字的是日期（归一化时应该已经去掉），不当作版本号
  if (!m || (m[3] && m[3].length >= 6)) return null;
  return { family: m[1] as Family, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function labelOf(id: string): string {
  const p = parse(id);
  if (!p) return id;
  const name = p.family[0].toUpperCase() + p.family.slice(1);
  return `${name} ${p.major}${p.minor ? `.${p.minor}` : ''}`;
}

export function modelCatalog(pricing: Pricing, store: Store): ModelOption[] {
  const used = new Map<string, { requests: number; lastUsedAt: string | null }>();
  const rows = store.db.prepare('SELECT model, COUNT(*) AS c, MAX(ts) AS last FROM requests WHERE model IS NOT NULL GROUP BY model').all() as Array<{
    model: string;
    c: number;
    last: string | null;
  }>;
  for (const r of rows) {
    const id = normalizeModel(r.model);
    if (!id.startsWith('claude-')) continue;
    const prev = used.get(id);
    used.set(id, {
      requests: (prev?.requests ?? 0) + Number(r.c),
      lastUsedAt: [prev?.lastUsedAt ?? null, r.last].filter((x): x is string => !!x).sort().pop() ?? null,
    });
  }

  const ids = new Set<string>();
  for (const id of pricing.modelIds()) if (parse(id)) ids.add(id);
  // 用过的模型一定列出来，即使价格表里没有或者命名不合常规
  for (const id of used.keys()) ids.add(id);
  if (ids.size === 0) for (const id of FALLBACK) ids.add(id);

  const out: ModelOption[] = [...ids].map((id) => {
    const p = parse(id);
    const u = used.get(id);
    return { id, label: labelOf(id), family: p?.family ?? 'other', requests: u?.requests ?? 0, lastUsedAt: u?.lastUsedAt ?? null };
  });
  const rank = (f: string) => {
    const i = (FAMILIES as readonly string[]).indexOf(f);
    return i < 0 ? FAMILIES.length : i;
  };
  // 按系列排，同系列新版本在前
  return out.sort((a, b) => {
    const d = rank(a.family) - rank(b.family);
    if (d) return d;
    const pa = parse(a.id);
    const pb = parse(b.id);
    if (pa && pb) return pb.major - pa.major || pb.minor - pa.minor;
    if (pa || pb) return pa ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other';
export type ThemeName = 'dark' | 'light';

export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  other: '其他',
};

// 模型系列配色：全应用统一使用这里的颜色。
// 颜色从不单独承担信息：每个出现颜色的地方旁边都有模型名，图表有图例和悬停提示。
const FAMILY_COLORS: Record<ThemeName, Record<ModelFamily, string>> = {
  dark: {
    opus: '#f59e4b',
    sonnet: '#5b9dff',
    fable: '#b48cff',
    haiku: '#3ecfb2',
    other: '#8b93a3',
  },
  light: {
    opus: '#dd7a16',
    sonnet: '#2f6fe0',
    fable: '#8454e0',
    haiku: '#12a389',
    other: '#6b7280',
  },
};

/** 图表里堆叠和图例的固定顺序（按系列，不按排名） */
export const FAMILY_ORDER: ModelFamily[] = ['opus', 'sonnet', 'fable', 'haiku', 'other'];

export function sortModelsByFamily(models: string[]): string[] {
  return [...models].sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(modelFamily(a));
    const fb = FAMILY_ORDER.indexOf(modelFamily(b));
    return fa !== fb ? fa - fb : a.localeCompare(b);
  });
}

export function modelFamily(model: string | null | undefined): ModelFamily {
  if (!model) return 'other';
  const m = model.toLowerCase();
  for (const f of MODEL_ALIASES) {
    if (m.includes(f)) return f;
  }
  return 'other';
}

/** 去掉 claude- 前缀与末尾日期，保留 [1m] 等后缀 */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '—';
  let s = model.replace(/^anthropic[./]/, '').replace(/^claude-/, '');
  const suffix = s.match(/\[[^\]]*\]$/)?.[0] ?? '';
  if (suffix) s = s.slice(0, -suffix.length);
  s = s.replace(/-\d{8}$/, '');
  return s + suffix;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function mix(hex: string, target: string, amount: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const ch = (x: number, sh: number) => (x >> sh) & 0xff;
  const r = Math.round(ch(a, 16) + (ch(b, 16) - ch(a, 16)) * amount);
  const g = Math.round(ch(a, 8) + (ch(b, 8) - ch(a, 8)) * amount);
  const bl = Math.round(ch(a, 0) + (ch(b, 0) - ch(a, 0)) * amount);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

export function familyColor(family: ModelFamily, theme: ThemeName): string {
  return FAMILY_COLORS[theme][family];
}

/**
 * 模型颜色：系列决定色相，同系列不同版本用明暗区分（由模型名确定，全应用一致）。
 * 别名（opus 等）直接用系列基色。
 */
export function modelColor(model: string | null | undefined, theme: ThemeName): string {
  const fam = modelFamily(model);
  const base = FAMILY_COLORS[theme][fam];
  if (!model || (MODEL_ALIASES as readonly string[]).includes(model)) return base;
  const norm = shortModel(model).replace(/\[[^\]]*\]$/, '');
  // 按版本号决定明暗，相邻版本（如 opus-5 与 opus-5-5）一定不同；没有版本号时退回哈希
  const nums = norm.match(/\d+/g);
  const shade = nums ? (Number(nums[0]) * 10 + Number(nums[1] ?? 0)) % 3 : hash(norm) % 3;
  if (shade === 0) return base;
  const toward = shade === 1 ? '#ffffff' : '#000000';
  return mix(base, toward, 0.22);
}

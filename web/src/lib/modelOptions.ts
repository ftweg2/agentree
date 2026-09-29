import { useEffect, useState } from 'react';
import type { ModelOption } from '../types';
import { api } from '../api/client';

/**
 * 可选的模型清单。画布上每个节点都有模型下拉框，所以整个应用只请求一次、大家共用。
 * 后端拿不到时用内置的清单兜底，下拉框不会是空的。
 */
const FALLBACK: ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', requests: 0, lastUsedAt: null },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', requests: 0, lastUsedAt: null },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', requests: 0, lastUsedAt: null },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', requests: 0, lastUsedAt: null },
];

let cache: ModelOption[] | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<(m: ModelOption[]) => void>();

function load() {
  if (cache || pending) return;
  pending = api
    .models()
    .then((list) => {
      cache = Array.isArray(list) && list.length ? list : FALLBACK;
      for (const l of listeners) l(cache);
    })
    .catch(() => {
      // 失败时不缓存，下次有组件挂载时再试
    })
    .finally(() => {
      pending = null;
    });
}

export function useModelOptions(): ModelOption[] {
  const [list, setList] = useState<ModelOption[]>(cache ?? FALLBACK);
  useEffect(() => {
    if (cache) {
      setList(cache);
      return;
    }
    listeners.add(setList);
    load();
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

export const FAMILY_NAME: Record<ModelOption['family'], string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: '其他' };

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure } from '../api/client';

export interface ApiState<T> {
  data: T | null;
  error: ApiFailure | null;
  /** 首次加载中（还没有任何数据） */
  loading: boolean;
  /** 最近一次成功获取的时间 */
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

function toFailure(e: unknown): ApiFailure {
  if (e instanceof ApiFailure) return e;
  return new ApiFailure('bad-response', e instanceof Error ? e.message : String(e));
}

/**
 * 请求并可选轮询。
 * - key 变化时清空旧数据重新请求
 * - 轮询刷新时保留旧数据；数据没变化时不触发重渲染
 * - 页面隐藏时暂停轮询
 * - 刷新失败时保留上一次的数据，同时给出 error
 */
export function useApi<T>(key: string, fetcher: () => Promise<T>, intervalMs: number | null = null): ApiState<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: ApiFailure | null; updatedAt: number | null; loading: boolean }>(
    { key, data: null, error: null, updatedAt: null, loading: true },
  );
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  keyRef.current = key;
  const inflight = useRef(false);
  const lastJson = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const k = keyRef.current;
    try {
      const d = await fetcherRef.current();
      if (keyRef.current !== k) return;
      const json = JSON.stringify(d);
      const same = json === lastJson.current;
      lastJson.current = json;
      setState((s) => ({
        key: k,
        data: same && s.data ? s.data : d,
        error: null,
        updatedAt: Date.now(),
        loading: false,
      }));
    } catch (e) {
      if (keyRef.current !== k) return;
      setState((s) => ({ ...s, key: k, error: toFailure(e), loading: false }));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    lastJson.current = null;
    inflight.current = false;
    setState({ key, data: null, error: null, updatedAt: null, loading: true });
    void load();
  }, [key, load]);

  // 连不上后端时，即使页面本身不轮询，也每 5 秒重试一次，后端启动后自动恢复
  const offline = state.error?.kind === 'offline';
  const effectiveInterval = intervalMs ?? (offline ? 5000 : null);
  useEffect(() => {
    if (!effectiveInterval) return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, effectiveInterval);
    return () => window.clearInterval(id);
  }, [effectiveInterval, key, load]);

  // 从后台切回前台时立即刷新一次
  useEffect(() => {
    if (!intervalMs) return;
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [intervalMs, load]);

  const stale = state.key !== key;
  return {
    data: stale ? null : state.data,
    error: stale ? null : state.error,
    loading: stale ? true : state.loading,
    updatedAt: stale ? null : state.updatedAt,
    refresh: load,
  };
}

/** 本地持久化的小状态（主题、视图选项等），读写失败时退回内存 */
export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {
      /* 忽略 */
    }
    return initial;
  });
  const set = useCallback(
    (nv: T | ((p: T) => T)) => {
      setV((prev) => {
        const next = typeof nv === 'function' ? (nv as (p: T) => T)(prev) : nv;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* 忽略 */
        }
        return next;
      });
    },
    [key],
  );
  return [v, set];
}

/** 每隔一段时间触发重渲染，用于相对时间显示 */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

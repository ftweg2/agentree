import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * 数字补间：首次出现时从 0 数上来，之后数值变化时从旧值过渡到新值。
 * 页面在后台时 requestAnimationFrame 不会触发，所以用超时兜底，保证最终一定落在真实值上。
 */
export function useAnimatedNumber(target: number | null | undefined, duration = 700): number | null {
  const reduced = useReducedMotion();
  const [value, setValue] = useState<number | null>(target == null ? null : reduced ? target : 0);
  const fromRef = useRef<number>(0);
  const shownRef = useRef<number>(0);

  useEffect(() => {
    if (target == null || Number.isNaN(target)) {
      setValue(null);
      return;
    }
    if (reduced || document.hidden) {
      shownRef.current = target;
      setValue(target);
      return;
    }
    const from = shownRef.current;
    fromRef.current = from;
    if (from === target) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = from + (target - from) * easeOutExpo(t);
      shownRef.current = t >= 1 ? target : v;
      setValue(shownRef.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const guard = window.setTimeout(() => {
      shownRef.current = target;
      setValue(target);
    }, duration + 120);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(guard);
    };
  }, [target, duration, reduced]);

  return value;
}

/**
 * 数值变化时短暂返回 true，用来给刚更新的数字加一个高亮。
 * 首次渲染不算变化。
 */
export function useFlash(value: unknown, ms = 900): boolean {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      prev.current = value;
      return;
    }
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return on;
}

/** 挂载后的一小段时间内为 true，用来只在首次出现时播放图表动画，轮询刷新时不重播 */
export function useFirstPaint(ms = 1100): boolean {
  const [first, setFirst] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setFirst(false), ms);
    return () => window.clearTimeout(id);
  }, [ms]);
  return first;
}

export interface Thumb {
  /** 选中项相对容器的偏移：横向时是左边距，纵向时是上边距 */
  offset: number;
  /** 选中项的尺寸：横向时是宽度，纵向时是高度 */
  size: number;
  ready: boolean;
}

/**
 * 量出容器里"当前选中项"的位置，给滑动指示条用。
 * selector 选中的元素位置变化（切换、窗口缩放、字体加载）时都会重新测量。
 */
export function useThumb(selector: string, dep: unknown, axis: 'x' | 'y' = 'x'): [React.RefObject<HTMLDivElement | null>, Thumb] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<Thumb>({ offset: 0, size: 0, ready: false });

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>(selector);
      if (!el) {
        setThumb((t) => (t.size === 0 ? t : { offset: t.offset, size: 0, ready: t.ready }));
        return;
      }
      const next = axis === 'x' ? { offset: el.offsetLeft, size: el.offsetWidth, ready: true } : { offset: el.offsetTop, size: el.offsetHeight, ready: true };
      setThumb((t) => (t.offset === next.offset && t.size === next.size && t.ready ? t : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [selector, dep, axis]);

  return [ref, thumb];
}

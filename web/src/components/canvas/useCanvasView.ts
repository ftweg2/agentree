import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface Pt {
  x: number;
  y: number;
}
export interface View {
  x: number;
  y: number;
  /** 缩放比例 */
  k: number;
}
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_K = 0.25;
const MAX_K = 1.75;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 画布上不应该触发平移的区域：节点、浮动工具条、菜单 */
const NO_PAN = '[data-nopan]';

/**
 * 无限画布的视图：拖动空白处平移，滚轮以鼠标位置为中心缩放。
 * 没有滚动条，位置和缩放完全由这里的状态决定。
 */
export function useCanvasView() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const [wheeling, setWheeling] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  /** 刚结束一次拖动时为 true，用来吞掉随后的那次 click */
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, nextK: number) => {
    const v = viewRef.current;
    const k = clamp(nextK, MIN_K, MAX_K);
    setView({ k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = boxRef.current;
      if (!el) return;
      zoomAt(el.clientWidth / 2, el.clientHeight / 2, Math.round(viewRef.current.k * factor * 100) / 100);
    },
    [zoomAt],
  );

  const resetZoom = useCallback(() => {
    const el = boxRef.current;
    if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1);
  }, [zoomAt]);

  /** 缩放到能看到给定范围并居中；内容比窗口小时保持 100%，不放大 */
  const fit = useCallback((b: Bounds, pad = { x: 48, top: 76, bottom: 72 }) => {
    const el = boxRef.current;
    if (!el || b.w <= 0 || b.h <= 0) return;
    const availW = Math.max(120, el.clientWidth - pad.x * 2);
    const availH = Math.max(120, el.clientHeight - pad.top - pad.bottom);
    const k = clamp(Math.min(1, availW / b.w, availH / b.h), MIN_K, MAX_K);
    setView({
      k,
      x: Math.round(pad.x + (availW - b.w * k) / 2 - b.x * k),
      y: Math.round(pad.top + (availH - b.h * k) / 2 - b.y * k),
    });
  }, []);

  /** 把某个点移到窗口正中 */
  const centerOn = useCallback((p: Pt) => {
    const el = boxRef.current;
    if (!el) return;
    const k = viewRef.current.k;
    setView({ k, x: Math.round(el.clientWidth / 2 - p.x * k), y: Math.round(el.clientHeight / 2 - p.y * k) });
  }, []);

  /** 屏幕坐标换算成画布坐标 */
  const toCanvas = useCallback((clientX: number, clientY: number): Pt => {
    const el = boxRef.current;
    const v = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement;
      // 工具条、菜单、节点里的输入框保持各自的滚轮行为
      if (t.closest('.canvas-tools, .menu, textarea, select')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setWheeling(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWheeling(false), 160);
      zoomAt(e.clientX - r.left, e.clientY - r.top, viewRef.current.k * Math.exp(-e.deltaY * 0.0016));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(timer);
    };
  }, [zoomAt]);

  const pan = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest(NO_PAN)) return;
    const v = viewRef.current;
    pan.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false, id: e.pointerId };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = pan.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      d.moved = true;
      setPanning(true);
      boxRef.current?.setPointerCapture(e.pointerId);
    }
    setView((v) => ({ k: v.k, x: d.vx + dx, y: d.vy + dy }));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = pan.current;
    pan.current = null;
    if (!d || !d.moved) return;
    setPanning(false);
    boxRef.current?.releasePointerCapture?.(e.pointerId);
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 0);
  }, []);

  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClick.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };

  return { boxRef, view, viewRef, setView, size, panning, wheeling, zoomAt, zoomBy, resetZoom, fit, centerOn, toCanvas, handlers, suppressClick };
}

/**
 * 拖动节点。移动超过几个像素才算拖动，否则算点击。
 * 屏幕上的位移要除以缩放比例才是画布上的位移。
 */
export function useNodeDrag(opts: {
  getScale: () => number;
  onMove: (id: string, pos: Pt) => void;
  onEnd?: (id: string, moved: boolean) => void;
  suppressClick: React.MutableRefObject<boolean>;
}) {
  const ref = useRef(opts);
  ref.current = opts;
  const [movingId, setMovingId] = useState<string | null>(null);

  const start = useCallback((e: React.PointerEvent, id: string, from: Pt) => {
    if (e.button !== 0) return;
    // 输入框、下拉、按钮、接口上的按下不算拖动节点
    if ((e.target as HTMLElement).closest('input, select, textarea, button, .socket, a')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        setMovingId(id);
      }
      const k = ref.current.getScale();
      ref.current.onMove(id, { x: Math.round(from.x + dx / k), y: Math.round(from.y + dy / k) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setMovingId(null);
      if (moved) {
        ref.current.suppressClick.current = true;
        window.setTimeout(() => (ref.current.suppressClick.current = false), 0);
      }
      ref.current.onEnd?.(id, moved);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);

  return { start, movingId };
}

/** 两个接口之间的连线：水平方向伸出的贝塞尔曲线，和 ComfyUI 的连线形状一致 */
export function noodle(a: Pt, b: Pt): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** 竖直方向伸出的连线，用于从上到下排列的树 */
export function noodleV(a: Pt, b: Pt): string {
  const dy = Math.max(30, Math.abs(b.y - a.y) * 0.5);
  return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
}

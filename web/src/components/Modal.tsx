import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { prefersReducedMotion } from '../lib/motion';

// 多个对话框叠在一起时，只有最上面的响应 Esc
const stack: string[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  title: ReactNode;
  /** Esc 或点"取消"时调用；为 undefined 时暂时不能关闭（如正在写入） */
  onCancel?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 放在标题下方、不随正文滚动的区域（用于警告） */
  pinned?: ReactNode;
  width?: number;
  /** 打开时聚焦的元素选择器 */
  initialFocus?: string;
}

/**
 * 模态对话框：
 * - 点背景不会关闭，只能点"取消"或按 Esc
 * - Tab 焦点限制在对话框内，关闭后焦点回到打开前的元素
 * - 窄屏时铺满屏幕
 */
export default function Modal({ title, onCancel, children, footer, pinned, width = 880, initialFocus }: Props) {
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // 取消时先播放退出动画再真正关闭。动画期间重复触发不会重复关闭
  const requestClose = useCallback(() => {
    if (!onCancelRef.current || closeTimer.current != null) return;
    if (prefersReducedMotion()) {
      onCancelRef.current();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onCancelRef.current?.();
    }, 170);
  }, []);
  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  cancelRef.current = onCancel ? requestClose : undefined;

  useEffect(() => {
    stack.push(id);
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const box = boxRef.current;
    const first = (initialFocus && box?.querySelector<HTMLElement>(initialFocus)) || box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        if (cancelRef.current) {
          e.preventDefault();
          cancelRef.current();
        }
        return;
      }
      if (e.key === 'Tab' && box) {
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === firstEl || !box.contains(document.activeElement))) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && (document.activeElement === lastEl || !box.contains(document.activeElement))) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
    // 只在挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleId = `${id}-title`;
  return createPortal(
    <div className={`modal-backdrop ${closing ? 'closing' : ''}`}>
      <div
        ref={boxRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: width }}
      >
        <div className="modal-h">
          <h2 id={titleId}>{title}</h2>
          <span className="spacer" />
          {onCancel && (
            <button className="btn icon sm ghost" onClick={requestClose} aria-label="取消并关闭" title="取消（Esc）">
              ✕
            </button>
          )}
        </div>
        {pinned && <div className="modal-pinned">{pinned}</div>}
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

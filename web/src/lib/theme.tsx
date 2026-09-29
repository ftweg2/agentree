import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { ThemeName } from './models';
import { prefersReducedMotion } from './motion';

const KEY = 'agentree.theme';

interface ThemeCtx {
  theme: ThemeName;
  /** origin：触发切换的位置（视口坐标），新主题从这里向外铺开 */
  toggle: (origin?: { x: number; y: number }) => void;
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };

const Ctx = createContext<ThemeCtx>({ theme: 'dark', toggle: () => {} });

function initialTheme(): ThemeName {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* 忽略 */
  }
  return 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  const toggle = useCallback((origin?: { x: number; y: number }) => {
    const flip = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
    const doc = document as ViewTransitionDoc;
    if (!origin || !doc.startViewTransition || prefersReducedMotion()) {
      flip();
      return;
    }
    // 新主题以点击位置为圆心向外铺开。属性要同步改掉，否则截图时还是旧主题
    const root = document.documentElement;
    root.classList.add('theme-switching');
    const vt = doc.startViewTransition(() => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      flushSync(flip);
    });
    const r = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y));
    vt.ready
      .then(() => {
        const anim = root.animate(
          { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${r}px at ${origin.x}px ${origin.y}px)`] },
          { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
        );
        anim.onfinish = anim.oncancel = () => root.classList.remove('theme-switching');
      })
      .catch(() => root.classList.remove('theme-switching'));
  }, []);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}

/** 从 CSS 变量读取当前主题的颜色，供图表使用 */
export function chartColors(theme: ThemeName) {
  return theme === 'dark'
    ? {
        grid: '#272e3a',
        axis: '#8b949e',
        text: '#c9d1d9',
        tooltipBg: '#12171f',
        tooltipBorder: '#272e3a',
        fiveHour: '#f0883e',
        sevenDay: '#6cb6ff',
        requests: '#7ee787',
      }
    : {
        grid: '#d0d7de',
        axis: '#57606a',
        text: '#24292f',
        tooltipBg: '#ffffff',
        tooltipBorder: '#d0d7de',
        fiveHour: '#bc4c00',
        sevenDay: '#0969da',
        requests: '#1a7f37',
      };
}

import { Component, useEffect, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, checkBackend, fetchToken, USE_MOCK } from './api/client';
import { useApi } from './lib/useApi';
import { useTheme } from './lib/theme';
import { useThumb } from './lib/motion';
import { Empty } from './components/ui';
import OverviewPage from './pages/Overview';
import LivePage from './pages/Live';
import SessionsPage from './pages/Sessions';
import SessionDetailPage from './pages/SessionDetail';
import BuilderPage from './pages/Builder';
import ConfigPage from './pages/Config';

function useBackendStatus() {
  // 每 5 秒探测一次 /api/live，同时给"实时"导航显示活跃会话数
  const live = useApi('header-live', api.live, 5000);
  const ok = !!live.data && !live.error;
  const count = live.data?.sessions.length ?? 0;
  return { ok, count, loading: live.loading, error: live.error };
}

function Logo() {
  // 一个根节点分出三个子节点
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <path className="branch" pathLength={1} d="M7 12H11.5M11.5 12V5.5H16M11.5 12H16M11.5 12V18.5H16" />
      <circle className="root-dot" cx="4.8" cy="12" r="2.6" />
      <circle className="leaf" cx="18.6" cy="5.5" r="2.2" />
      <circle className="leaf" cx="18.6" cy="12" r="2.2" />
      <circle className="leaf" cx="18.6" cy="18.5" r="2.2" />
    </svg>
  );
}

const ICONS = {
  overview: <path d="M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z" />,
  live: <path d="M3 12h4l2.5-7 4 14 2.5-7h5" />,
  sessions: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  // 两个节点之间连着一条线
  preset: <path d="M3 5h6v5H3zM15 14h6v5h-6zM9 7.5h2.5a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2H15" />,
  config: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4.5v5M6 14.5v5" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function Rail() {
  const { theme, toggle } = useTheme();
  const st = useBackendStatus();
  const { pathname } = useLocation();
  const [navRef, thumb] = useThumb('a.active', pathname, 'y');
  return (
    <aside className="rail">
      <Link to="/" className="brand" title="agentree">
        <Logo />
        <span>agentree</span>
      </Link>
      <nav className="nav" ref={navRef as React.RefObject<HTMLElement | null>}>
        <span
          className="nav-thumb"
          aria-hidden="true"
          style={{ height: thumb.size, transform: `translateY(${thumb.offset}px)`, opacity: thumb.size ? 1 : 0, transition: thumb.ready ? undefined : 'none' }}
        />
        <NavLink to="/" end title="总览">
          <Icon name="overview" />
          <span className="label">总览</span>
        </NavLink>
        <NavLink to="/live" title="实时">
          <Icon name="live" />
          <span className="label">实时</span>
          {st.count > 0 && <span className="count">{st.count}</span>}
        </NavLink>
        <NavLink to="/sessions" title="会话">
          <Icon name="sessions" />
          <span className="label">会话</span>
        </NavLink>
        <NavLink to="/preset" title="搭建">
          <Icon name="preset" />
          <span className="label">搭建</span>
        </NavLink>
        <NavLink to="/config" title="配置">
          <Icon name="config" />
          <span className="label">配置</span>
        </NavLink>
      </nav>
      <div className="rail-foot">
        {USE_MOCK ? (
          <span className="badge warn" title="VITE_USE_MOCK=1，所有数据都是模拟的">
            模拟数据
          </span>
        ) : (
          !st.loading && (
            <span className={`conn ${st.ok ? 'ok' : 'down'}`} title={st.ok ? '后端连接正常' : st.error?.message ?? '后端不可用'}>
              <span className="dot" />
              <span className="label">{st.ok ? '已连接' : '后端未连接'}</span>
            </span>
          )
        )}
        <span className="spacer" />
        <button
          className="btn icon sm ghost theme-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label="切换主题"
        >
          <span>{theme === 'dark' ? '☀' : '☾'}</span>
        </button>
      </div>
    </aside>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="alert error" style={{ margin: 28 }}>
          <div className="alert-body">
            <div className="title">页面渲染出错</div>
            <div className="mono small">{this.state.error.message}</div>
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // 启动时取一次写接口令牌；失败没关系，第一次写请求时会再取
  useEffect(() => {
    fetchToken().catch(() => {});
  }, []);
  // 切换页面时让新页面重新播放进入动画；同一页面内的参数变化（筛选、选中节点）不重播
  const { pathname } = useLocation();
  // 更新后没重启应用时，后端还是旧的。每 10 秒核对一次，重启之后提示自己消失
  const version = useApi('backend-version', () => checkBackend(true), 10000);
  return (
    <div className="shell">
      <Rail />
      {(version.data === 'backend-old' || version.data === 'frontend-old') && (
        <div className="version-bar" role="alert">
          <b>{version.data === 'backend-old' ? '需要重启 agentree' : '需要刷新页面'}</b>
          <span>
            {version.data === 'backend-old'
              ? '程序更新过，但后端还是旧版本。请从托盘图标选“退出”，再重新打开。重启之前不能保存或应用方案。'
              : '程序更新过，这个页面还是旧版本。请按 Ctrl+R 刷新。'}
          </span>
        </div>
      )}
      <main className="view">
        <ErrorBoundary key={pathname}>
          <div className="page" key={pathname}>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/live" element={<LivePage />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/sessions/:id" element={<SessionDetailPage />} />
              <Route path="/preset" element={<BuilderPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route
                path="*"
                element={
                  <Empty icon="404" title="页面不存在">
                    <Link to="/">回到总览</Link>
                  </Empty>
                }
              />
            </Routes>
          </div>
        </ErrorBoundary>
      </main>
    </div>
  );
}

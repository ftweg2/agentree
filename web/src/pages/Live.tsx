import { useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { LiveAgent, LiveSession, LiveState } from '../types';
import { api } from '../api/client';
import { useApi, useNow } from '../lib/useApi';
import { fullNumber, relativeTime, projectLabel, shortDuration, toolLabel } from '../lib/format';
import { ErrorBox, Flash, ModelTag, Skeleton, Tok } from '../components/ui';

/** 按 parentId 把运行中的 agent 排成树序；父节点不在运行列表里的直接放顶层 */
function orderAgents(agents: LiveAgent[]): LiveAgent[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, LiveAgent[]>();
  const tops: LiveAgent[] = [];
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) {
      const l = kids.get(a.parentId) ?? [];
      l.push(a);
      kids.set(a.parentId, l);
    } else tops.push(a);
  }
  const out: LiveAgent[] = [];
  const walk = (a: LiveAgent) => {
    out.push(a);
    (kids.get(a.id) ?? []).forEach(walk);
  };
  tops.sort((a, b) => a.depth - b.depth).forEach(walk);
  return out;
}

/** 工具名变化时重新挂载，播放一次切换动画 */
function ToolChip({ tool }: { tool: string | null | undefined }) {
  const t = toolLabel(tool);
  if (!t) return <span className="dim small">—</span>;
  return (
    <span className="tool" key={t.full} title={`最近一次发起的工具：${t.full}`}>
      {t.short}
    </span>
  );
}

function elapsed(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const t = new Date(startedAt).getTime();
  if (Number.isNaN(t)) return null;
  return shortDuration(Math.max(0, now - t));
}

function SessionCard({ s, now }: { s: LiveSession; now: number }) {
  const agents = orderAgents(s.runningAgents);
  const minDepth = agents.length ? Math.min(...agents.map((a) => a.depth)) : 1;
  const busy = s.mainActive || agents.length > 0;
  return (
    <Link to={`/sessions/${encodeURIComponent(s.sessionId)}`} className={`card live-card ${busy ? 'active' : ''}`}>
      <div className="card-h" style={{ alignItems: 'flex-start', borderBottom: 'none' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`dot ${s.mainActive ? 'running' : 'completed'}`} title={s.mainActive ? '主会话最近有写入' : '主会话暂时没有写入'} />
            <h2 className="ellipsis" style={{ minWidth: 0, fontSize: 14 }} title={s.title ?? s.sessionId}>
              {s.title ?? <span className="muted">（无标题）{s.sessionId.slice(0, 8)}</span>}
            </h2>
          </div>
          <div className="small muted row wrap" style={{ gap: 10, marginTop: 3 }}>
            <span className="mono" title={s.cwd ?? ''}>
              {s.cwd ? projectLabel('', s.cwd) : '—'}
            </span>
            <span>最近写入 {relativeTime(s.lastActivityAt, now)}</span>
          </div>
        </div>
        <span className={`badge ${agents.length ? 'running' : 'muted'}`}>
          {agents.length ? `${agents.length} 个 agent 运行中` : s.mainActive ? '仅主会话' : '空闲'}
        </span>
      </div>

      <div className="live-agent" style={{ borderTop: '1px solid var(--border-muted)' }}>
        <span className={`dot ${s.mainActive ? 'running' : 'completed'}`} />
        <span className="mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          主会话
        </span>
        <span className="muted ellipsis" style={{ flex: 1, minWidth: 0 }}>
          {s.mainActive ? '正在工作' : agents.length ? '等待子 agent 返回' : '暂时没有写入'}
        </span>
        <ModelTag model={s.mainModel} />
        <ToolChip tool={s.mainTool} />
      </div>

      {agents.map((a) => (
        <div key={a.id} className="live-agent">
          <span style={{ width: Math.max(1, a.depth - minDepth + 1) * 14, flex: 'none', textAlign: 'right' }} className="dim mono small">
            └
          </span>
          <span className="dot running" />
          <span className="mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {a.agentType ?? '未知'}
          </span>
          <span className="ellipsis muted" style={{ flex: 1, minWidth: 0 }} title={a.description ?? ''}>
            {a.description ?? ''}
          </span>
          <span className="live-usage" title={`请求 ${fullNumber(a.requests)} 次 · 工具调用 ${fullNumber(a.toolCalls)} 次${elapsed(a.startedAt, now) ? ` · 已运行 ${elapsed(a.startedAt, now)}` : ''}`}>
            <Flash value={a.requests}>{fullNumber(a.requests)}</Flash> 次 ·{' '}
            <Flash value={a.tokens}>
              <Tok n={a.tokens} />
            </Flash>
          </span>
          <ModelTag model={a.model} />
          <ToolChip tool={a.currentTool} />
          <span className="dim small nowrap" style={{ width: 56, textAlign: 'right' }}>
            {relativeTime(a.lastActivityAt, now)}
          </span>
        </div>
      ))}

      <div className="live-totals">
        <span>
          整个会话 <b>{fullNumber(s.requests)}</b> 次请求
        </span>
        <span>
          <b>
            <Tok n={s.tokens} animate />
          </b>{' '}
          token
        </span>
        <span>
          派发过 <b>{fullNumber(s.agentCount)}</b> 个子 agent
        </span>
      </div>
    </Link>
  );
}

export default function LivePage() {
  const q = useApi<LiveState>('live', api.live, 2000);
  const now = useNow(1000);
  const running = q.data?.sessions.reduce((n, s) => n + s.runningAgents.length, 0) ?? 0;

  // 后端按最近写入时间排序，两个会话交替写入时顺序会来回变，卡片就会不停换位置。
  // 这里让已经显示的卡片保持原位，新出现的会话插到最前面。
  const orderRef = useRef<string[]>([]);
  const sessions = useMemo(() => {
    const list = q.data?.sessions ?? [];
    const byId = new Map(list.map((s) => [s.sessionId, s]));
    const kept = orderRef.current.filter((id) => byId.has(id));
    const keptSet = new Set(kept);
    const fresh = list.filter((s) => !keptSet.has(s.sessionId)).map((s) => s.sessionId);
    orderRef.current = [...fresh, ...kept];
    return orderRef.current.map((id) => byId.get(id)!);
  }, [q.data]);

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>实时</h1>
        <span className="small muted">
          {q.data ? (
            <>
              <span className="num">{q.data.sessions.length}</span> 个活跃会话 · <span className="num">{running}</span> 个 agent 运行中 · 每 2 秒刷新
            </>
          ) : (
            '每 2 秒刷新'
          )}
        </span>
        <span className="spacer" />
        {q.data && <span className="small dim num">后端时间 {new Date(q.data.now).toLocaleTimeString('zh-CN')}</span>}
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.refresh} stale={!!q.data} />}
      {q.loading && !q.data && (
        <div className="live-grid" aria-busy="true" aria-label="读取运行状态">
          {[0, 1].map((i) => (
            <div className="card" key={i} style={{ padding: 16 }}>
              <Skeleton w="55%" h={16} />
              <Skeleton w="35%" h={11} style={{ marginTop: 10 }} />
              <Skeleton h={12} style={{ marginTop: 18 }} />
              <Skeleton h={12} style={{ marginTop: 10 }} />
            </div>
          ))}
        </div>
      )}
      {q.data &&
        (q.data.sessions.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="radar" aria-hidden="true" />
              <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>现在没有活跃的会话</div>
              <div className="small">
                在 Claude Code 里开始工作后，这里会自动出现。
                <div style={{ marginTop: 8 }}>
                  <Link to="/sessions">查看历史会话 →</Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="live-grid">
            {sessions.map((s) => (
              <SessionCard key={s.sessionId} s={s} now={now} />
            ))}
          </div>
        ))}
    </div>
  );
}

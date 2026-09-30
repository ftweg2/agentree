import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { SessionSummary } from '../types';
import { api } from '../api/client';
import { useApi, useNow } from '../lib/useApi';
import { awaitingMinutes, formatDateTime, fullNumber, projectLabel, relativeTime } from '../lib/format';
import { Cost, EffortTag, Empty, ErrorBox, ModelTag, SkeletonRows, Tok, VerdictBadge } from '../components/ui';

type SortKey = 'recent' | 'started' | 'tokens' | 'requests' | 'agents';

const SORT_LABEL: Record<SortKey, string> = {
  recent: '最近活动',
  started: '开始时间',
  tokens: 'token 数',
  requests: '请求数',
  agents: '子 agent 数',
};

const VERDICT_ROW_COLOR: Record<string, string> = {
  mismatch: 'var(--fail)',
  unplanned: 'var(--unplanned)',
  match: 'var(--ok)',
  'not-checked': 'transparent',
};

export default function SessionsPage() {
  const q = useApi<SessionSummary[]>('sessions', () => api.sessions(1000), 10_000);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const now = useNow(10_000);

  const project = params.get('project') ?? '';
  const search = params.get('q') ?? '';
  const sort = (params.get('sort') as SortKey) || 'recent';
  const verdict = params.get('verdict') ?? '';
  const desc = params.get('dir') !== 'asc';

  const set = (k: string, v: string) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );

  const projects = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const s of q.data ?? []) {
      const cur = m.get(s.projectDir);
      if (cur) cur.count++;
      else m.set(s.projectDir, { label: projectLabel(s.projectDir, s.cwd), count: 1 });
    }
    // 不同项目目录的最后一段可能同名，同名时显示完整目录名以便区分
    const labelCount = new Map<string, number>();
    for (const v of m.values()) labelCount.set(v.label, (labelCount.get(v.label) ?? 0) + 1);
    for (const [dir, v] of m) if ((labelCount.get(v.label) ?? 0) > 1) v.label = `${v.label}（${dir}）`;
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [q.data]);

  const rows = useMemo(() => {
    let list = q.data ?? [];
    if (project) list = list.filter((s) => s.projectDir === project);
    if (verdict) list = list.filter((s) => s.conformance.verdict === verdict);
    if (search.trim()) {
      const t = search.trim().toLowerCase();
      list = list.filter((s) => (s.title ?? '').toLowerCase().includes(t) || s.id.toLowerCase().includes(t));
    }
    const key = (s: SessionSummary): number | string => {
      switch (sort) {
        case 'recent':
          return s.lastActivityAt ?? '';
        case 'started':
          return s.startedAt ?? '';
        case 'tokens':
          return s.tokens.total;
        case 'requests':
          return s.requests;
        case 'agents':
          return s.agentCount;
      }
    };
    return [...list].sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return desc ? -c : c;
    });
  }, [q.data, project, verdict, search, sort, desc]);

  const totals = useMemo(
    () => rows.reduce((a, s) => ({ tokens: a.tokens + s.tokens.total, requests: a.requests + s.requests }), { tokens: 0, requests: 0 }),
    [rows],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>会话</h1>
          <div className="page-sub">
            {q.data ? (
              <>
                共 <span className="num">{q.data.length}</span> 个{rows.length !== q.data.length && <>，筛选后 <span className="num">{rows.length}</span> 个</>} · 请求{' '}
                <span className="num">{fullNumber(totals.requests)}</span> 次 · token <Tok n={totals.tokens} />
              </>
            ) : (
              ' '
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="toolbar">
          <input
            className="input"
            style={{ flex: '1 1 220px', maxWidth: 360 }}
            placeholder="按标题或会话 ID 搜索"
            value={search}
            onChange={(e) => set('q', e.target.value)}
          />
          <select className="select" value={project} onChange={(e) => set('project', e.target.value)} style={{ maxWidth: 260 }}>
            <option value="">全部项目</option>
            {projects.map(([dir, p]) => (
              <option key={dir} value={dir} title={dir}>
                {p.label}（{p.count}）
              </option>
            ))}
          </select>
          <select className="select" value={verdict} onChange={(e) => set('verdict', e.target.value)}>
            <option value="">和预设对比：全部</option>
            <option value="mismatch">不符合</option>
            <option value="unplanned">用了预设外的 agent</option>
            <option value="match">符合</option>
            <option value="not-checked">没有对比</option>
          </select>
          <span className="row" style={{ gap: 4 }}>
            <span className="small muted">排序</span>
            <select className="select" value={sort} onChange={(e) => set('sort', e.target.value === 'recent' ? '' : e.target.value)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
            <button className="btn icon" onClick={() => set('dir', desc ? 'asc' : '')} title={desc ? '当前从大到小（从新到旧）' : '当前从小到大（从旧到新）'}>
              {desc ? '↓' : '↑'}
            </button>
          </span>
          {(project || search || verdict) && (
            <button
              className="btn sm ghost"
              onClick={() =>
                setParams(
                  (prev) => {
                    const n = new URLSearchParams(prev);
                    ['project', 'q', 'verdict'].forEach((k) => n.delete(k));
                    return n;
                  },
                  { replace: true },
                )
              }
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {q.error && <ErrorBox error={q.error} onRetry={q.refresh} stale={!!q.data} />}
      {q.loading && !q.data && <SkeletonRows rows={10} label="读取会话列表" />}

      {q.data && (
        <div className="card">
          {rows.length === 0 ? (
            <Empty title={q.data.length ? '没有符合条件的会话' : '还没有会话'}>
              {q.data.length ? '换个筛选条件试试。' : '后端还没有索引到任何日志。如果刚启动，稍等片刻再刷新。'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data rows-in">
                <thead>
                  <tr>
                    <th>会话</th>
                    <th>最近活动</th>
                    <th>主模型</th>
                    <th className="num">子 agent</th>
                    <th className="num" title="主对话被压缩的次数（自动 / 手动）">
                      压缩
                    </th>
                    <th className="num">请求</th>
                    <th className="num">token</th>
                    <th className="num">费用</th>
                    <th>和预设对比</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => {
                    // 在等模型回复超过 1 分钟：告诉用户它在思考，不是死了
                    const awaitMin = awaitingMinutes(s.awaitingReply?.since, now);
                    return (
                      <tr
                        key={s.id}
                        className="clickable"
                        style={{ ['--i' as string]: i }}
                        onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}
                      >
                        <td className="verdict-cell" style={{ maxWidth: 0, width: '42%', ['--vc' as string]: VERDICT_ROW_COLOR[s.conformance.verdict] }}>
                          <div className="row" style={{ gap: 8, minWidth: 0 }}>
                            {(s.isActive || awaitMin !== null) && <span className="dot running" title={awaitMin !== null ? '在等模型回复' : '进行中'} />}
                            <Link
                              to={`/sessions/${encodeURIComponent(s.id)}`}
                              className="ellipsis"
                              style={{ color: 'var(--text)', minWidth: 0, fontWeight: 550 }}
                              title={s.title ?? s.id}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {s.title ?? <span className="dim">（无标题）{s.id.slice(0, 8)}</span>}
                            </Link>
                          </div>
                          <div className="small dim ellipsis" style={{ marginTop: 2 }} title={s.cwd ?? s.projectDir}>
                            <span className="mono">{projectLabel(s.projectDir, s.cwd)}</span> · {formatDateTime(s.startedAt)} 开始
                          </div>
                        </td>
                        <td className="nowrap small" title={formatDateTime(s.lastActivityAt)}>
                          {awaitMin !== null ? (
                            <span style={{ color: 'var(--running)' }} title="最后一条是用户消息或工具结果，模型还没有回复。高强度下模型会先思考很久，思考完成之前日志里没有任何输出">
                              已等待回复 {awaitMin} 分钟
                            </span>
                          ) : s.isActive ? (
                            <span style={{ color: 'var(--running)' }}>进行中</span>
                          ) : (
                            relativeTime(s.lastActivityAt, now)
                          )}
                        </td>
                        <td className="nowrap">
                          <span className="row" style={{ gap: 6 }}>
                            <ModelTag model={s.mainModel} />
                            {s.mainEffort && <EffortTag efforts={s.mainEffort} />}
                          </span>
                        </td>
                        <td className="num">
                          {s.agentCount}
                          {s.maxDepth > 1 && <span className="dim small" title="最大嵌套深度"> ·{s.maxDepth}层</span>}
                        </td>
                        <td className="num" title={s.compactions.total ? `自动 ${s.compactions.auto} 次，手动 ${s.compactions.manual} 次` : '没有被压缩过'}>
                          {s.compactions.total ? s.compactions.total : <span className="dim">—</span>}
                        </td>
                        <td className="num">{fullNumber(s.requests)}</td>
                        <td className="num">
                          <Tok n={s.tokens.total} />
                        </td>
                        <td className="num">
                          <Cost usd={s.costUsd} />
                        </td>
                        <td className="nowrap">
                          {s.conformance.verdict === 'not-checked' ? (
                            <span className="dim small">—</span>
                          ) : (
                            <VerdictBadge verdict={s.conformance.verdict} fail={s.conformance.fail} warn={s.conformance.warn} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

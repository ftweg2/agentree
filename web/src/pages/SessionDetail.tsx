import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { AgentNode, SessionDetail } from '../types';
import { api } from '../api/client';
import { useApi, useLocalState } from '../lib/useApi';
import { useThumb } from '../lib/motion';
import { formatDateTime, formatDuration, fullNumber, projectLabel } from '../lib/format';
import { Cost, EffortTag, Empty, ErrorBox, ModelTag, Num, Skeleton, StatusBadge, Tok, VerdictBadge, VerdictMark } from '../components/ui';
import { AgentTypeTable, ChecksList, ModelUsageTable } from '../components/tables';
import TreeCanvas, { type Orientation } from '../components/tree/TreeCanvas';
import NodeDetail from '../components/tree/NodeDetail';
import { ancestors, buildIndex, hasWarn, nodeLabel, type UsageMode } from '../components/tree/treeModel';

type Tab = 'tree' | 'table' | 'checks';

function loadCollapsed(id: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(`agentree.collapsed.${id}`);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* 忽略 */
  }
  return new Set();
}

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const fetcher = useCallback(() => api.session(id), [id]);
  const [active, setActive] = useState(false);
  const q = useApi<SessionDetail>(`session:${id}`, fetcher, active ? 2000 : null);

  useEffect(() => {
    if (q.data) setActive(q.data.summary.isActive);
  }, [q.data]);

  const [tab, setTab] = useLocalState<Tab>('agentree.sessionTab', 'tree');
  const [usage, setUsage] = useLocalState<UsageMode>('agentree.usageMode', 'own');
  const [orientation, setOrientation] = useLocalState<Orientation>('agentree.treeOrientation', 'h');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(id));
  const [tabsRef, tabThumb] = useThumb('button.on', tab);

  useEffect(() => {
    setCollapsed(loadCollapsed(id));
  }, [id]);
  useEffect(() => {
    try {
      sessionStorage.setItem(`agentree.collapsed.${id}`, JSON.stringify([...collapsed]));
    } catch {
      /* 忽略 */
    }
  }, [collapsed, id]);

  const detail = q.data;
  const index = useMemo(() => (detail ? buildIndex(detail) : null), [detail]);
  const selectedParam = params.get('node');
  // 没有选中任何节点时不显示检查器，画布占满整个区域
  const selectedId = index && selectedParam && index.byId.has(selectedParam) ? selectedParam : null;
  const selected = selectedId && index ? index.byId.get(selectedId) ?? null : null;

  const select = useCallback(
    (nid: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('node', nid);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const deselect = useCallback(() => {
    setParams(
      (prev) => {
        if (!prev.has('node')) return prev;
        const next = new URLSearchParams(prev);
        next.delete('node');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  // 选中节点被折叠在某个祖先里时，自动展开祖先（每次选中只处理一次，不影响之后用户手动折叠）
  const handledSel = useRef<string | null>(null);
  useEffect(() => {
    if (!index || !selectedId || handledSel.current === selectedId) return;
    handledSel.current = selectedId;
    const anc = ancestors(index, selectedId);
    if (anc.some((a) => collapsed.has(a))) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        anc.forEach((a) => next.delete(a));
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, index]);

  const toggle = useCallback((nid: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nid)) next.delete(nid);
      else next.add(nid);
      return next;
    });
  }, []);

  if (q.loading && !detail) {
    return (
      <div className="fill" aria-busy="true" aria-label="读取会话">
        <div className="sd-top" style={{ paddingBottom: 20 }}>
          <Skeleton w={300} h={22} />
          <Skeleton w="55%" h={13} />
        </div>
        <div className="sd-body">
          <div className="canvas" style={{ display: 'grid', placeItems: 'center' }}>
            <div className="row" style={{ gap: 96 }}>
              <Skeleton w={276} h={78} style={{ borderRadius: 10 }} />
              <div className="stack" style={{ gap: 16 }}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} w={276} h={78} style={{ borderRadius: 10 }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (!detail || !index) {
    return (
      <div style={{ padding: 36 }}>
        {q.error?.kind === 'notfound' ? (
          <Empty icon="404" title="找不到这个会话">
            <span className="mono">{id}</span>
            <div style={{ marginTop: 10 }}>
              <Link to="/sessions">返回会话列表</Link>
            </div>
          </Empty>
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={q.refresh} />
        ) : null}
      </div>
    );
  }

  const s = detail.summary;
  const counts: Record<AgentNode['status'], number> = { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  detail.agents.forEach((a) => {
    if (a.kind !== 'main') counts[a.status]++;
  });
  const firstLevelOnly = () => {
    const next = new Set<string>();
    detail.agents.forEach((a) => {
      if (a.depth >= 1 && (index.kids.get(a.id)?.length ?? 0) > 0) next.add(a.id);
    });
    setCollapsed(next);
  };

  // 需要用户留意的检查项：会话级的，加上每个节点自己的
  const issues = [
    ...detail.sessionChecks.filter((c) => c.level !== 'ok').map((c) => ({ node: index.root!, check: c })),
    ...detail.agents.filter((a) => a.kind !== 'main').flatMap((a) => a.conformance.checks.filter((c) => c.level === 'fail' || c.level === 'warn').map((c) => ({ node: a, check: c }))),
  ];
  const nFail = issues.filter((i) => i.check.level === 'fail').length;
  const nWarn = issues.filter((i) => i.check.level === 'warn').length;
  const nInfo = issues.filter((i) => i.check.level === 'info').length;

  return (
    <div className="fill">
      <header className="sd-top">
        <div className="sd-title">
          <Link to="/sessions" className="sd-back" title="返回会话列表" aria-label="返回会话列表">
            ←
          </Link>
          <h1 className="ellipsis" title={s.title ?? ''}>
            {s.title ?? <span className="muted">（无标题会话）</span>}
          </h1>
          {s.isActive ? (
            <span className="badge running" title="最近有写入，每 2 秒自动刷新">
              <span className="dot running" style={{ width: 6, height: 6 }} />
              进行中
            </span>
          ) : (
            <span className="badge muted">已结束</span>
          )}
          {s.conformance.verdict !== 'not-checked' && <VerdictBadge verdict={s.conformance.verdict} fail={s.conformance.fail} warn={s.conformance.warn} />}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => void q.refresh()} title="立即刷新">
            刷新
          </button>
        </div>

        <div className="sd-facts">
          <span className="fact" title={s.cwd ?? s.projectDir}>
            项目 <b className="mono">{projectLabel(s.projectDir, s.cwd)}</b>
          </span>
          {s.scheme && (
            <span
              className="fact"
              title={
                s.scheme.scope === 'project'
                  ? `这个项目有自己的方案（${s.scheme.projectCwd}）。检查时用的是项目方案叠在全局方案上的结果`
                  : s.scheme.scope === 'user'
                    ? '这个项目没有自己的方案，按全局方案检查'
                    : '还没有方案，所以没有检查'
              }
            >
              对照 <b>{s.scheme.scope === 'project' ? '项目方案' : s.scheme.scope === 'user' ? '全局方案' : '无'}</b>
            </span>
          )}
          <span className="fact">
            主模型 <ModelTag model={s.mainModel} />
            {s.mainEffort && <EffortTag efforts={s.mainEffort} />}
          </span>
          <span className="fact">
            advisor{' '}
            {s.advisorModel ? (
              <>
                <ModelTag model={s.advisorModel} />
                <span className={s.advisorCalls === 0 ? 'badge warn' : 'badge muted'} title={s.advisorCalls === 0 ? '配置了 advisor，但这次会话一次都没有调用过' : undefined}>
                  {s.advisorCalls === 0 ? '从未调用' : `调用 ${s.advisorCalls} 次`}
                </span>
              </>
            ) : (
              <span className="dim">未配置</span>
            )}
          </span>
          <span className="fact">
            子 agent{' '}
            <b>
              <Num n={s.agentCount} animate />
            </b>
            <span className="dim">最深 {s.maxDepth} 层</span>
          </span>
          <span className="fact">
            请求{' '}
            <b>
              <Num n={s.requests} animate />
            </b>
          </span>
          <span className="fact">
            token{' '}
            <b>
              <Tok n={s.tokens.total} animate />
            </b>
          </span>
          <span className="fact" title="按公开的 API 价格折算，订阅用户仅供参考">
            费用{' '}
            <b>
              <Cost usd={s.costUsd} animate />
            </b>
          </span>
          <span className="fact dim num">
            {formatDateTime(s.startedAt)} → {s.isActive ? '现在' : formatDateTime(s.lastActivityAt)}
          </span>
        </div>

        <div className="tabs" role="tablist" ref={tabsRef}>
          <span
            className="tab-thumb"
            aria-hidden="true"
            style={{ width: tabThumb.size, transform: `translateX(${tabThumb.offset}px)`, opacity: tabThumb.size ? 1 : 0, transition: tabThumb.ready ? undefined : 'none' }}
          />
          <button role="tab" aria-selected={tab === 'tree'} className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')}>
            树
          </button>
          <button role="tab" aria-selected={tab === 'table'} className={tab === 'table' ? 'on' : ''} onClick={() => setTab('table')}>
            明细<span className="n">{detail.agents.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'checks'} className={tab === 'checks' ? 'on' : ''} onClick={() => setTab('checks')}>
            检查
            {issues.length > 0 && <span className={`n ${nFail ? 'fail' : nWarn ? 'warn' : ''}`}>{issues.length}</span>}
          </button>
        </div>
      </header>

      {q.error && (
        <div style={{ padding: '12px 28px 0' }}>
          <ErrorBox error={q.error} onRetry={q.refresh} stale />
        </div>
      )}

      <div className={`sd-body ${tab === 'tree' && selected ? 'has-insp' : ''}`}>
        {tab === 'tree' && (
          <>
            <TreeCanvas
              key={id}
              sessionId={id}
              index={index}
              collapsed={collapsed}
              selectedId={selectedId}
              usageMode={usage}
              setUsageMode={setUsage}
              orientation={orientation}
              setOrientation={setOrientation}
              sessionTitle={s.title}
              counts={counts}
              onSelect={select}
              onDeselect={deselect}
              onToggle={toggle}
              onExpandAll={() => setCollapsed(new Set())}
              onFirstLevelOnly={firstLevelOnly}
            />
            {selected && <NodeDetail node={selected} index={index} sessionChecks={detail.sessionChecks} onSelect={select} onClose={deselect} />}
          </>
        )}

        {tab === 'table' && (
          <div className="sd-scroll">
            <div className="stack">
              <AgentTable
                agents={detail.agents}
                selectedId={selectedId}
                usage={usage}
                onOpen={(nid) => {
                  select(nid);
                  setTab('tree');
                }}
              />
              <div className="grid grid-2">
                <div className="card">
                  <div className="card-h">
                    <h2>按 agent 类型</h2>
                  </div>
                  <div className="card-b flush">
                    <AgentTypeTable types={detail.agentTypes} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-h">
                    <h2>按模型</h2>
                  </div>
                  <div className="card-b flush">
                    <ModelUsageTable models={detail.models} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'checks' && (
          <div className="sd-scroll">
            <div className="stack" style={{ maxWidth: 920 }}>
              <div className="card">
                <div className="card-h">
                  <h2>需要留意的项</h2>
                  <span className="small muted">
                    {issues.length === 0 ? '没有' : [nFail && `${nFail} 项不符`, nWarn && `${nWarn} 项注意`, nInfo && `${nInfo} 项提示`].filter(Boolean).join('，')}
                  </span>
                  <span className="spacer" />
                  <Link to="/preset" className="small">
                    去搭建页调整预设 →
                  </Link>
                </div>
                <div className="card-b">
                  {issues.length === 0 ? (
                    <div className="small muted">
                      {s.conformance.verdict === 'not-checked'
                        ? '还没有设置预设，所以没有可以对比的期望值。到搭建页搭一棵期望的 agent 树并保存，之后每个会话都会和它对比。'
                        : '实际运行和预设一致。'}
                    </div>
                  ) : (
                    issues.map((it, i) => (
                      <div key={i} style={{ marginBottom: 14 }}>
                        <a
                          href="#"
                          className="row small"
                          style={{ marginBottom: 6, color: 'var(--text)' }}
                          onClick={(e) => {
                            e.preventDefault();
                            select(it.node.id);
                            setTab('tree');
                          }}
                        >
                          <b className="mono">{nodeLabel(it.node)}</b>
                          <span className="muted ellipsis" style={{ minWidth: 0 }}>
                            {it.node.description ?? ''}
                          </span>
                          <span className="dim">在树中查看 →</span>
                        </a>
                        <ChecksList checks={[it.check]} />
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="card">
                <div className="card-h">
                  <h2>会话级检查的全部结果</h2>
                  <span className="small muted">主模型、主 effort、advisor</span>
                </div>
                <div className="card-b">
                  <ChecksList checks={detail.sessionChecks} empty="预设里没有设置主会话和 advisor 的期望值，所以没有会话级检查。" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type SortKey = 'start' | 'requests' | 'own' | 'subtree' | 'duration';

function AgentTable({ agents, selectedId, onOpen, usage }: { agents: AgentNode[]; selectedId: string | null; onOpen: (id: string) => void; usage: UsageMode }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'start', desc: false });
  const rows = useMemo(() => {
    const val = (a: AgentNode): number | string => {
      switch (sort.key) {
        case 'start':
          return a.kind === 'main' ? '' : a.startedAt ?? '';
        case 'requests':
          return a.requests;
        case 'own':
          return a.tokens.total;
        case 'subtree':
          return a.subtree.tokens.total;
        case 'duration':
          return a.durationMs ?? -1;
      }
    };
    return [...agents].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.desc ? -c : c;
    });
  }, [agents, sort]);

  const th = (key: SortKey, label: string, num = true) => (
    <th className={`sortable ${num ? 'num' : ''}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'start' }))}>
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div className="card">
      <div className="card-h">
        <h2>每个 agent 的用量</h2>
        <span className="small muted">点一行在树中定位</span>
      </div>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="data">
          <thead>
            <tr>
              <th>agent</th>
              <th>任务</th>
              <th>模型</th>
              <th>状态</th>
              {th('requests', '请求')}
              {th('own', 'token')}
              {th('subtree', '含后代')}
              <th className="num">工具</th>
              {th('duration', '耗时')}
              <th className="num">费用</th>
              <th />
              {th('start', '开始', false)}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={`clickable ${selectedId === a.id ? 'selected' : ''}`} onClick={() => onOpen(a.id)}>
                <td className="mono nowrap" style={{ paddingLeft: 20 + Math.min(a.depth, 4) * 14 }}>
                  {nodeLabel(a)}
                </td>
                <td className="ellipsis muted" style={{ maxWidth: 300 }} title={a.description ?? ''}>
                  {a.description ?? ''}
                </td>
                <td className="nowrap">
                  <span className="row" style={{ gap: 6 }}>
                    <ModelTag model={a.primaryModel} />
                    {a.models.length > 1 && <span className="badge warn">+{a.models.length - 1}</span>}
                    <EffortTag efforts={a.efforts} />
                  </span>
                </td>
                <td className="nowrap">
                  <StatusBadge status={a.status} />
                </td>
                <td className="num">{fullNumber(a.requests)}</td>
                <td className="num" style={usage === 'own' ? { fontWeight: 600 } : undefined}>
                  <Tok n={a.tokens.total} />
                </td>
                <td className="num" style={usage === 'subtree' ? { fontWeight: 600 } : { color: 'var(--text-2)' }}>
                  <Tok n={a.subtree.tokens.total} />
                </td>
                <td className="num">{fullNumber(a.toolCalls)}</td>
                <td className="num nowrap">{formatDuration(a.durationMs)}</td>
                <td className="num">
                  <Cost usd={a.costUsd} />
                </td>
                <td>
                  <VerdictMark verdict={a.conformance.verdict} hasWarn={hasWarn(a)} />
                </td>
                <td className="num nowrap dim">{formatDateTime(a.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

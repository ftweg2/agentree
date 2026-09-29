import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AgentTypeUsage, DailyPoint, ModelUsage, Overview, QuotaInfo } from '../types';
import { api } from '../api/client';
import { useApi, useLocalState } from '../lib/useApi';
import { chartColors, useTheme } from '../lib/theme';
import { useFirstPaint } from '../lib/motion';
import { formatDateTime, fullNumber, pct, relativeTime, shortNumber } from '../lib/format';
import { modelColor, sortModelsByFamily } from '../lib/models';
import { Cost, Empty, ErrorBox, ModelTag, Num, Seg, SkeletonRows, SkeletonStats, Tok } from '../components/ui';

const RANGES = [7, 30, 90] as const;

export default function OverviewPage() {
  const [days, setDays] = useLocalState<number>('agentree.overviewDays', 30);
  const [indexing, setIndexing] = useState(false);
  const fetcher = useCallback(() => api.overview(days), [days]);
  const q = useApi<Overview>(`overview:${days}`, fetcher, indexing ? 2000 : 30_000);
  const [reindexBusy, setReindexBusy] = useState(false);

  const isIndexing = q.data?.index.state === 'indexing';
  useEffect(() => {
    if (q.data) setIndexing(isIndexing);
  }, [q.data, isIndexing]);

  const reindex = async () => {
    setReindexBusy(true);
    try {
      await api.reindex();
      setIndexing(true);
      await q.refresh();
    } catch {
      /* 错误会在下一次刷新时显示 */
    } finally {
      setReindexBusy(false);
    }
  };

  const d = q.data;
  const ix = d?.index;
  const done = ix && ix.filesTotal ? Math.min(100, (ix.filesIndexed / ix.filesTotal) * 100) : 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>总览</h1>
          <div className="page-sub">
            {ix ? (
              isIndexing ? (
                <>
                  正在读取日志 <span className="num">{done.toFixed(0)}%</span>，数字可能还不完整
                </>
              ) : (
                <>
                  已读取 <span className="num">{fullNumber(ix.filesTotal)}</span> 个日志文件 · {relativeTime(ix.lastIndexedAt)}更新
                  {ix.skippedLines > 0 && (
                    <span title="日志里无法解析的行，已跳过">
                      {' '}
                      · 跳过 <span className="num">{fullNumber(ix.skippedLines)}</span> 行无法解析的内容
                    </span>
                  )}
                </>
              )
            ) : (
              ' '
            )}
          </div>
        </div>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => void reindex()} disabled={reindexBusy || isIndexing} title="立即检查有没有新的日志">
          {reindexBusy || isIndexing ? '读取中…' : '重新读取'}
        </button>
        <Seg label="时间范围" value={days} onChange={setDays} options={RANGES.map((r) => ({ value: r as number, label: `最近 ${r} 天` }))} />
      </div>

      {isIndexing && (
        <div className="progress striped">
          <span style={{ width: `${done}%` }} />
        </div>
      )}
      {q.error && <ErrorBox error={q.error} onRetry={q.refresh} stale={!!d} />}
      {q.loading && !d && (
        <>
          <SkeletonStats n={5} />
          <SkeletonRows rows={5} label="读取统计" />
        </>
      )}

      {d && (
        <>
          <div className="stats">
            <Stat label="会话" value={<Num n={d.totals.sessions} animate />} />
            <Stat label="子 agent" value={<Num n={d.totals.agents} animate />} sub={d.totals.sessions ? `平均每个会话 ${(d.totals.agents / d.totals.sessions).toFixed(1)} 个` : undefined} />
            <Stat label="API 请求" value={<Num n={d.totals.requests} animate />} sub="同一次请求只算一次" />
            <Stat
              label="token"
              value={<Tok n={d.totals.tokens.total} animate />}
              sub={`其中缓存读取占 ${d.totals.tokens.total ? ((d.totals.tokens.cacheRead / d.totals.tokens.total) * 100).toFixed(0) : 0}%`}
            />
            <Stat label="按 API 价格折算" value={<Cost usd={d.totals.costUsd} animate />} sub={d.totals.costUsd == null ? '没有可用的价格数据' : '订阅用户仅供参考'} />
          </div>

          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)' }}>
            <DailyChart daily={d.daily} />
            <QuotaCard quota={d.quota} />
          </div>

          <div className="grid grid-2">
            <ModelBars models={d.models} />
            <TypeBars types={d.agentTypes} />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function ModelBars({ models }: { models: ModelUsage[] }) {
  const { theme } = useTheme();
  const rows = [...models].sort((a, b) => b.tokens.total - a.tokens.total);
  const max = Math.max(1, ...rows.map((m) => m.tokens.total));
  return (
    <div className="card">
      <div className="card-h">
        <h2>各模型的用量</h2>
      </div>
      <div className="card-b flush">
        {rows.length === 0 ? (
          <Empty title="这段时间没有数据" />
        ) : (
          <div className="bars">
            <div className="bar-row head">
              <span>模型</span>
              <span />
              <span className="right">请求</span>
              <span className="right">token</span>
              <span className="right">费用</span>
            </div>
            {rows.map((m) => (
              <div className="bar-row" key={m.model} style={{ ['--mc' as string]: modelColor(m.model, theme) }}>
                <span className="name">
                  <ModelTag model={m.model} />
                </span>
                <div className="bar-track" title={`占最大值的 ${((m.tokens.total / max) * 100).toFixed(0)}%`}>
                  <span style={{ width: `${Math.max(1, (m.tokens.total / max) * 100)}%` }} />
                </div>
                <span className="num right">{fullNumber(m.requests)}</span>
                <span className="right">
                  <Tok n={m.tokens.total} />
                </span>
                <span className="right">
                  <Cost usd={m.costUsd} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypeBars({ types }: { types: AgentTypeUsage[] }) {
  const { theme } = useTheme();
  const max = Math.max(1, ...types.map((t) => t.tokens.total));
  return (
    <div className="card">
      <div className="card-h">
        <h2>各类 agent 的用量</h2>
        <span className="small muted">每一类只算它自己的请求</span>
      </div>
      <div className="card-b flush">
        {types.length === 0 ? (
          <Empty title="这段时间没有数据" />
        ) : (
          <div className="bars">
            <div className="bar-row head">
              <span>类型</span>
              <span />
              <span className="right">派发</span>
              <span className="right">请求</span>
              <span className="right">token</span>
            </div>
            {types.map((t) => (
              <div className="bar-row" key={t.agentType} style={{ ['--mc' as string]: modelColor(t.models[0], theme) }} title={t.models.length ? `用过的模型：${t.models.join('、')}` : undefined}>
                <span className="name mono">{t.agentType === 'main' ? '主会话' : t.agentType}</span>
                <div className="bar-track">
                  <span style={{ width: `${Math.max(1, (t.tokens.total / max) * 100)}%` }} />
                </div>
                <span className="num right">{t.agentType === 'main' ? '—' : fullNumber(t.spawns)}</span>
                <span className="num right">{fullNumber(t.requests)}</span>
                <span className="right">
                  <Tok n={t.tokens.total} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const first = useFirstPaint();
  const [metric, setMetric] = useLocalState<'tokens' | 'requests'>('agentree.dailyMetric', 'tokens');
  const models = useMemo(() => sortModelsByFamily(Array.from(new Set(daily.flatMap((p) => Object.keys(p.byModel))))), [daily]);
  const data = useMemo(
    () =>
      daily.map((p) => {
        const row: Record<string, number | string> = { date: p.date.slice(5), fullDate: p.date, total: metric === 'tokens' ? p.tokens : p.requests };
        for (const m of models) row[m] = p.byModel[m]?.[metric] ?? 0;
        return row;
      }),
    [daily, models, metric],
  );
  const hasData = daily.some((p) => p.requests > 0);

  return (
    <div className="card">
      <div className="card-h">
        <h2>每天的用量</h2>
        <span className="row wrap" style={{ gap: 12 }}>
          {models.map((m) => (
            <ModelTag key={m} model={m} />
          ))}
        </span>
        <span className="spacer" />
        <Seg
          label="指标"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'tokens', label: 'token' },
            { value: 'requests', label: '请求数' },
          ]}
        />
      </div>
      <div className="card-b">
        {!hasData ? (
          <Empty title="这段时间没有数据" />
        ) : (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke={c.grid} strokeOpacity={0.7} />
                <XAxis dataKey="date" tick={{ fill: c.axis, fontSize: 11.5 }} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={{ fill: c.axis, fontSize: 11.5 }} axisLine={false} tickLine={false} width={46} tickFormatter={(v: number) => shortNumber(v)} />
                <Tooltip
                  cursor={{ fill: 'var(--hover)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as Record<string, number | string>;
                    const items = models.filter((m) => Number(row[m]) > 0).reverse();
                    const fmt = (v: number) => (metric === 'tokens' ? shortNumber(v) : fullNumber(v));
                    return (
                      <div className="chart-tip">
                        <div className="num" style={{ marginBottom: 4, fontWeight: 600 }}>
                          {row.fullDate}
                        </div>
                        {items.map((m) => (
                          <div key={m} className="tip-row">
                            <ModelTag model={m} />
                            <span className="num">{fmt(Number(row[m]))}</span>
                          </div>
                        ))}
                        <div className="tip-row" style={{ borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 4 }}>
                          <span className="muted">合计</span>
                          <span className="num">{fmt(Number(row.total))}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                {models.map((m, i) => (
                  <Bar
                    key={m}
                    dataKey={m}
                    stackId="a"
                    fill={modelColor(m, theme)}
                    radius={i === models.length - 1 ? [4, 4, 0, 0] : 0}
                    isAnimationActive={first}
                    animationDuration={650}
                    animationBegin={120}
                    animationEasing="ease-out"
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

/** 用量越接近上限颜色越警示：75% 以上黄色，90% 以上红色 */
function quotaColor(p: number): string {
  return p >= 90 ? 'var(--fail)' : p >= 75 ? 'var(--warn)' : 'var(--ok)';
}

function Ring({ value, label }: { value: number; label: string }) {
  const r = 48;
  const len = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="ring" style={{ ['--rc' as string]: quotaColor(v) }} title={`${label}已用 ${pct(value)}`}>
      <svg viewBox="0 0 116 116" aria-hidden="true">
        <circle className="track" cx="58" cy="58" r={r} />
        <circle className="value" cx="58" cy="58" r={r} strokeDasharray={len} strokeDashoffset={len * (1 - v / 100)} />
      </svg>
      <div className="center">
        <b style={{ color: v >= 75 ? quotaColor(v) : undefined }}>{pct(value)}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

function QuotaCard({ quota }: { quota: QuotaInfo | null }) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const first = useFirstPaint(1600);
  const data = useMemo(() => (quota?.samples ?? []).map((s) => ({ t: s.t, fh: s.fiveHourPct, sd: s.sevenDayPct })), [quota]);

  return (
    <div className="card">
      <div className="card-h">
        <h2>订阅额度</h2>
        <span className="small muted">已经用掉的比例</span>
      </div>
      <div className="card-b">
        {!quota || !quota.latest ? (
          <Empty icon="—" title="没有额度数据">
            额度数据来自 Claude 桌面版，本机没有找到。
          </Empty>
        ) : (
          <>
            <div className="rings">
              <Ring value={quota.latest.fiveHourPct} label="5 小时" />
              <Ring value={quota.latest.sevenDayPct} label="7 天" />
            </div>
            {data.length > 1 && (
              <div style={{ height: 96, marginTop: 14 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                    <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
                    <YAxis domain={[0, 100]} hide />
                    <Tooltip
                      cursor={{ stroke: c.axis, strokeWidth: 1 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as (typeof data)[number];
                        return (
                          <div className="chart-tip">
                            <div className="num" style={{ marginBottom: 4, fontWeight: 600 }}>
                              {formatDateTime(new Date(p.t).toISOString())}
                            </div>
                            <div className="tip-row">
                              <span className="muted">5 小时</span>
                              <span className="num">{pct(p.fh)}</span>
                            </div>
                            <div className="tip-row">
                              <span className="muted">7 天</span>
                              <span className="num">{pct(p.sd)}</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Line type="monotone" dataKey="fh" stroke={c.text} strokeWidth={1.8} dot={false} isAnimationActive={first} animationDuration={1000} animationEasing="ease-out" />
                    <Line type="monotone" dataKey="sd" stroke={c.axis} strokeWidth={1.8} strokeDasharray="4 4" dot={false} isAnimationActive={first} animationDuration={1000} animationBegin={150} animationEasing="ease-out" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="row small dim" style={{ justifyContent: 'center', gap: 16, marginTop: 6 }}>
              <span className="row" style={{ gap: 6 }}>
                <svg width="16" height="4" aria-hidden="true">
                  <line x1="0" y1="2" x2="16" y2="2" stroke={c.text} strokeWidth="2" />
                </svg>
                5 小时
              </span>
              <span className="row" style={{ gap: 6 }}>
                <svg width="16" height="4" aria-hidden="true">
                  <line x1="0" y1="2" x2="16" y2="2" stroke={c.axis} strokeWidth="2" strokeDasharray="4 3" />
                </svg>
                7 天
              </span>
              <span>最近 {Math.max(1, Math.round((data[data.length - 1]?.t - data[0]?.t) / 86400000) || 1)} 天的变化</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

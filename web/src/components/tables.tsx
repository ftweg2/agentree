import type { AgentTypeUsage, ConformanceCheck, ModelUsage, TokenTotals } from '../types';
import { Cost, LevelBadge, ModelTag, Tok } from './ui';
import { fullNumber } from '../lib/format';

const FIELD_LABEL: Record<ConformanceCheck['field'], string> = {
  agent: 'agent 类型',
  model: '模型',
  effort: 'effort',
  advisor: 'advisor',
};

export function ChecksList({ checks, empty }: { checks: ConformanceCheck[]; empty?: string }) {
  if (!checks.length) return <div className="small muted">{empty ?? '没有检查项。'}</div>;
  return (
    <div>
      {checks.map((c, i) => (
        <div key={i} className="check-item" style={{ borderLeft: `3px solid var(--${c.level === 'ok' ? 'ok' : c.level})` }}>
          <div className="row">
            <b style={{ fontSize: 12 }}>{FIELD_LABEL[c.field] ?? c.field}</b>
            <span className="spacer" />
            <LevelBadge level={c.level} />
          </div>
          <div className="ev">
            <span>期望</span>
            <span>{c.expected ?? '—'}</span>
            <span>实际</span>
            <span>{c.actual ?? '—'}</span>
          </div>
          <div className="msg">{c.message}</div>
        </div>
      ))}
    </div>
  );
}

const TOKEN_ROWS: Array<[keyof TokenTotals, string, string]> = [
  ['input', '输入', '未命中缓存的输入'],
  ['output', '输出', ''],
  ['cacheRead', '缓存读取', ''],
  ['cacheWrite5m', '缓存写入 5 分钟', ''],
  ['cacheWrite1h', '缓存写入 1 小时', ''],
];

export function TokenBreakdown({ own, subtree }: { own: TokenTotals; subtree?: TokenTotals }) {
  const max = Math.max(1, ...TOKEN_ROWS.map(([k]) => own[k]));
  return (
    <table className="data compact">
      <thead>
        <tr>
          <th>项</th>
          <th className="num">自己</th>
          {subtree && <th className="num">含后代</th>}
          <th style={{ width: '30%' }} />
        </tr>
      </thead>
      <tbody>
        {TOKEN_ROWS.map(([k, label, hint]) => (
          <tr key={k}>
            <td title={hint || undefined}>{label}</td>
            <td className="num">
              <Tok n={own[k]} />
            </td>
            {subtree && (
              <td className="num">
                <Tok n={subtree[k]} />
              </td>
            )}
            <td>
              <div className="meter">
                <span style={{ width: `${(own[k] / max) * 100}%`, background: 'var(--info)' }} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>合计</td>
          <td className="num">
            <Tok n={own.total} />
          </td>
          {subtree && (
            <td className="num">
              <Tok n={subtree.total} />
            </td>
          )}
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

export function ModelUsageTable({ models, detailed }: { models: ModelUsage[]; detailed?: boolean }) {
  if (!models.length) return <div className="small muted" style={{ padding: 12 }}>没有计入的请求。</div>;
  const sorted = [...models].sort((a, b) => b.tokens.total - a.tokens.total);
  const total = sorted.reduce((a, m) => a + m.tokens.total, 0) || 1;
  return (
    <div className="table-wrap">
      <table className="data compact">
        <thead>
          <tr>
            <th>模型</th>
            <th className="num">请求</th>
            {detailed && (
              <>
                <th className="num">输入</th>
                <th className="num">输出</th>
                <th className="num">缓存读</th>
                <th className="num">写 5m</th>
                <th className="num">写 1h</th>
              </>
            )}
            <th className="num">token</th>
            {!detailed && <th className="num">占比</th>}
            <th className="num">费用</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.model}>
              <td>
                <ModelTag model={m.model} full />
              </td>
              <td className="num">{fullNumber(m.requests)}</td>
              {detailed && (
                <>
                  <td className="num">
                    <Tok n={m.tokens.input} />
                  </td>
                  <td className="num">
                    <Tok n={m.tokens.output} />
                  </td>
                  <td className="num">
                    <Tok n={m.tokens.cacheRead} />
                  </td>
                  <td className="num">
                    <Tok n={m.tokens.cacheWrite5m} />
                  </td>
                  <td className="num">
                    <Tok n={m.tokens.cacheWrite1h} />
                  </td>
                </>
              )}
              <td className="num">
                <Tok n={m.tokens.total} />
              </td>
              {!detailed && <td className="num dim">{((m.tokens.total / total) * 100).toFixed(1)}%</td>}
              <td className="num">
                <Cost usd={m.costUsd} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentTypeTable({ types }: { types: AgentTypeUsage[] }) {
  if (!types.length) return <div className="small muted" style={{ padding: 12 }}>没有数据。</div>;
  return (
    <div className="table-wrap">
      <table className="data compact">
        <thead>
          <tr>
            <th>agent 类型</th>
            <th className="num">派发次数</th>
            <th className="num">请求</th>
            <th className="num">token</th>
            <th className="num">费用</th>
            <th>用过的模型</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.agentType}>
              <td className="mono">{t.agentType === 'main' ? '主会话' : t.agentType}</td>
              <td className="num">{t.agentType === 'main' ? '—' : fullNumber(t.spawns)}</td>
              <td className="num">{fullNumber(t.requests)}</td>
              <td className="num">
                <Tok n={t.tokens.total} />
              </td>
              <td className="num">
                <Cost usd={t.costUsd} />
              </td>
              <td>
                <span className="row wrap" style={{ gap: 8 }}>
                  {t.models.map((m) => (
                    <ModelTag key={m} model={m} />
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

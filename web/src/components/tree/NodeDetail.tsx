import type { AgentNode, ConformanceCheck, TokenTotals } from '../../types';
import { Cost, EffortTag, Flash, ModelTag, StatusBadge, Tok, VerdictBadge } from '../ui';
import { ChecksList, ModelUsageTable } from '../tables';
import { formatDuration, formatFullDateTime, fullNumber, shortNumber } from '../../lib/format';
import { nodeLabel, type TreeIndex } from './treeModel';

interface Props {
  node: AgentNode;
  index: TreeIndex;
  sessionChecks: ConformanceCheck[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

const PARTS: Array<{ key: keyof TokenTotals; label: string; color: string; hint?: string }> = [
  { key: 'cacheRead', label: '缓存读取', color: '#5b9dff' },
  { key: 'cacheWrite1h', label: '缓存写入 1 小时', color: '#b48cff' },
  { key: 'cacheWrite5m', label: '缓存写入 5 分钟', color: '#3ecfb2' },
  { key: 'input', label: '输入', color: '#f59e4b', hint: '未命中缓存的输入' },
  { key: 'output', label: '输出', color: '#6fdc8c' },
];

/** token 构成：一根分段的条，下面列出每一段的数值 */
function TokenSplit({ own, subtree }: { own: TokenTotals; subtree?: TokenTotals }) {
  const total = own.total || 1;
  return (
    <>
      <div className="split" role="img" aria-label="token 构成">
        {PARTS.filter((p) => own[p.key] > 0).map((p) => (
          <span key={p.key} style={{ width: `${(own[p.key] / total) * 100}%`, background: p.color }} title={`${p.label} ${fullNumber(own[p.key])}`} />
        ))}
      </div>
      <div className="split-legend">
        {PARTS.map((p) => (
          <div key={p.key} style={{ display: 'contents' }}>
            <span className="k" title={p.hint}>
              <i style={{ background: p.color }} />
              {p.label}
            </span>
            <span className="num right">
              <Tok n={own[p.key]} />
            </span>
            <span className="num right dim" style={{ minWidth: 44 }}>
              {own.total ? `${((own[p.key] / own.total) * 100).toFixed(own[p.key] / own.total < 0.1 ? 1 : 0)}%` : '—'}
            </span>
          </div>
        ))}
        {subtree && (
          <div style={{ display: 'contents' }}>
            <span className="k dim" style={{ paddingTop: 6 }}>
              含后代合计
            </span>
            <span className="num right" style={{ paddingTop: 6 }}>
              <Tok n={subtree.total} />
            </span>
            <span />
          </div>
        )}
      </div>
    </>
  );
}

export default function NodeDetail({ node, index, sessionChecks, onSelect, onClose }: Props) {
  const parent = node.parentId ? index.byId.get(node.parentId) : null;
  const kids = index.kids.get(node.id) ?? [];
  const isMain = node.kind === 'main';
  const checks = isMain ? sessionChecks : node.conformance.checks;
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const hasKids = kids.length > 0;

  return (
    <aside className="inspector" aria-label="节点详情" data-nopan>
      <div className="insp-head">
        <div className="row">
          <h2 className="ellipsis" style={{ minWidth: 0 }}>
            {nodeLabel(node)}
          </h2>
          <StatusBadge status={node.status} />
          {node.background && <span className="badge outline">后台</span>}
          <span className="spacer" />
          <button className="btn icon sm ghost" onClick={onClose} title="关闭" aria-label="关闭详情">
            ✕
          </button>
        </div>
        {!isMain && node.description && (
          <div className="muted small" style={{ marginTop: 6 }}>
            {node.description}
          </div>
        )}
        <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
          <ModelTag model={node.primaryModel} full />
          <EffortTag efforts={node.efforts} />
          {node.efforts.length > 1 && (
            <span className="small" style={{ color: 'var(--warn)' }}>
              effort 中途变化过
            </span>
          )}
        </div>
      </div>

      {/* key 让切换节点时内容重新淡入；轮询刷新时 key 不变，不会重播 */}
      <div className="insp-body" key={node.id}>
        <div className="insp-sec">
          <div className="tiles">
            <div className="tile">
              <div className="k">请求</div>
              <div className="v">
                <Flash value={node.requests}>{fullNumber(node.requests)}</Flash>
              </div>
              {hasKids && <div className="s">含后代 {fullNumber(node.subtree.requests)}</div>}
            </div>
            <div className="tile">
              <div className="k">token</div>
              <div className="v">
                <Flash value={node.tokens.total}>
                  <Tok n={node.tokens.total} />
                </Flash>
              </div>
              {hasKids && (
                <div className="s">
                  含后代 <Tok n={node.subtree.tokens.total} />
                </div>
              )}
            </div>
            <div className="tile">
              <div className="k">工具调用</div>
              <div className="v">
                <Flash value={node.toolCalls}>{fullNumber(node.toolCalls)}</Flash>
              </div>
              {hasKids && <div className="s">含后代 {fullNumber(node.subtree.toolCalls)}</div>}
            </div>
            <div className="tile">
              <div className="k">{node.status === 'running' ? '已运行' : '耗时'}</div>
              <div className="v" style={{ fontSize: 16, lineHeight: '25px' }}>
                {formatDuration(node.durationMs)}
              </div>
              <div className="s" title="按公开的 API 价格折算，订阅用户仅供参考">
                费用 <Cost usd={node.costUsd} />
              </div>
            </div>
          </div>
        </div>

        <div className="insp-sec">
          <h3>一致性检查{isMain ? '（会话级）' : ''}</h3>
          {checks.length > 0 && (
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <VerdictBadge verdict={node.conformance.verdict} fail={fails} warn={warns} />
              {node.conformance.presetAgent && (
                <span className="small muted">
                  对应预设 <span className="mono">{node.conformance.presetAgent}</span>
                </span>
              )}
            </div>
          )}
          <ChecksList checks={checks} empty={isMain ? '预设里没有设置主会话和 advisor 的期望值。' : '预设里没有这个 agent 的期望值，所以没有可比的项。'} />
        </div>

        <div className="insp-sec">
          <h3>token 构成</h3>
          <TokenSplit own={node.tokens} subtree={hasKids ? node.subtree.tokens : undefined} />
        </div>

        {node.models.length > 1 && (
          <div className="insp-sec" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <h3 style={{ padding: '0 20px' }}>用了 {node.models.length} 个模型</h3>
            <ModelUsageTable models={node.models} />
          </div>
        )}

        {(isMain || node.advisorModel) && (
          <div className="insp-sec">
            <h3>advisor</h3>
            {node.advisorModel ? (
              <div className="row wrap">
                <ModelTag model={node.advisorModel} />
                <span className={node.advisorCalls === 0 ? 'badge warn' : 'badge muted'}>{node.advisorCalls === 0 ? '从未调用' : `调用 ${fullNumber(node.advisorCalls)} 次`}</span>
              </div>
            ) : (
              <span className="dim small">未配置</span>
            )}
          </div>
        )}

        {(isMain || node.compactions.total > 0) && (
          <div className="insp-sec">
            <h3>上下文压缩</h3>
            {node.compactions.total === 0 ? (
              <span className="dim small">{isMain ? '主对话没有被压缩过' : '没有被压缩过'}</span>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row wrap">
                  <span className="badge muted">共 {node.compactions.total} 次</span>
                  <span className="small muted">
                    自动 {node.compactions.auto} 次 · 手动（/compact）{node.compactions.manual} 次
                    {node.compactions.total > node.compactions.auto + node.compactions.manual && ` · 不明 ${node.compactions.total - node.compactions.auto - node.compactions.manual} 次`}
                  </span>
                </div>
                {node.compactions.autoPreTokens.length > 0 && (
                  <div className="small muted">
                    自动压缩前的上下文：
                    {node.compactions.autoPreTokens.map((n, i) => (
                      <span key={i}>
                        {i > 0 && '、'}
                        <span className="num" title={`${fullNumber(n)} token`}>
                          {shortNumber(n)}
                        </span>
                      </span>
                    ))}
                    <span className="dim"> token</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {(parent || hasKids) && (
          <div className="insp-sec">
            <h3>关系</h3>
            {parent && (
              <a
                href="#"
                className="kid-link"
                onClick={(e) => {
                  e.preventDefault();
                  onSelect(parent.id);
                }}
              >
                <span className="dim">由</span>
                <span className="mono">{nodeLabel(parent)}</span>
                <span className="dim">派发 · 第 {node.depth} 层</span>
              </a>
            )}
            {kids.map((k) => {
              const c = index.byId.get(k);
              if (!c) return null;
              return (
                <a
                  key={k}
                  href="#"
                  className="kid-link"
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(k);
                  }}
                >
                  <span className={`dot ${c.status}`} />
                  <span className="mono">{nodeLabel(c)}</span>
                  <span className="ellipsis muted" style={{ minWidth: 0 }}>
                    {c.description}
                  </span>
                </a>
              );
            })}
          </div>
        )}

        <div className="insp-sec">
          <details className="more">
            <summary>技术细节</summary>
            <dl className="kv">
              <dt>ID</dt>
              <dd className="mono small">{node.id}</dd>
              {!isMain && (
                <>
                  <dt>派发时指定的模型</dt>
                  <dd className="mono small">{node.requestedModel ?? <span className="dim">没有指定</span>}</dd>
                </>
              )}
              <dt>开始</dt>
              <dd className="num">{formatFullDateTime(node.startedAt)}</dd>
              <dt>结束</dt>
              <dd className="num">{node.endedAt ? formatFullDateTime(node.endedAt) : node.status === 'running' ? '运行中' : '—'}</dd>
              {node.toolUseId && (
                <>
                  <dt>toolUseId</dt>
                  <dd className="mono small dim">{node.toolUseId}</dd>
                </>
              )}
            </dl>
          </details>
        </div>
      </div>
    </aside>
  );
}

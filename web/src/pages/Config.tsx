import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentDefinition,
  BackupEntry,
  ChangePlan,
  ClaudeConfigSnapshot,
  ClaudeMdRuleState,
  ConfigAction,
} from '../types';
import { api } from '../api/client';
import { useApi, type ApiState } from '../lib/useApi';
import { formatFullDateTime, fullNumber, relativeTime } from '../lib/format';
import { Empty, ErrorBox, Loading, ModelTag } from '../components/ui';
import { EffortSelect, ModelInput } from '../components/inputs';
import EnvTable from '../components/EnvTable';
import Modal from '../components/Modal';
import PlanDialog from '../components/plan/PlanDialog';
import AgentEditor from '../components/config/AgentEditor';

interface PlanRequest {
  title: string;
  load: () => Promise<ChangePlan>;
}

export default function ConfigPage() {
  const configQ = useApi<ClaudeConfigSnapshot>('config', api.config);
  const ruleQ = useApi<ClaudeMdRuleState>('config-rule', api.rule);
  const backupsQ = useApi<BackupEntry[]>('config-backups', api.backups);

  const [planReq, setPlanReq] = useState<PlanRequest | null>(null);
  const [editor, setEditor] = useState<{ def: AgentDefinition | null } | null>(null);
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null);

  const refreshAll = useCallback(() => {
    void configQ.refresh();
    void ruleQ.refresh();
    void backupsQ.refresh();
  }, [configQ, ruleQ, backupsQ]);

  const c = configQ.data;
  // 项目级 agent 只能建在后端给出的 projectCwds 里（旧后端没有这个字段时为空）。
  // 编辑已有的项目级 agent 时，下拉框里补上它自己的目录，仅用于显示（编辑时范围不能改）
  const projects = useMemo(() => {
    const list = Array.isArray(c?.projectCwds) ? [...c!.projectCwds] : [];
    const own = editor?.def?.projectCwd;
    if (own && !list.includes(own)) list.push(own);
    return list;
  }, [c, editor]);

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>配置</h1>
        <span className="small muted">修改 Claude Code 的配置文件。每次修改都会先显示差异，确认后才写入，原文件会先备份。</span>
      </div>
      <nav className="section-nav" aria-label="本页目录">
        <a href="#/config" onClick={(e) => jump(e, 'sec-agents')}>子 agent</a>
        <a href="#/config" onClick={(e) => jump(e, 'sec-main')}>主会话与 advisor</a>
        <a href="#/config" onClick={(e) => jump(e, 'sec-rule')}>CLAUDE.md 规则</a>
        <a href="#/config" onClick={(e) => jump(e, 'sec-env')}>环境变量</a>
        <a href="#/config" onClick={(e) => jump(e, 'sec-backups')}>备份</a>
      </nav>

      {configQ.error && <ErrorBox error={configQ.error} onRetry={configQ.refresh} stale={!!c} />}
      {configQ.loading && !c && <Loading text="读取 Claude Code 配置" />}

      {c && (
        <>
          <AgentsSection
            c={c}
            onNew={() => setEditor({ def: null })}
            onEdit={(d) => setEditor({ def: d })}
            onDelete={(d) => setDeleting(d)}
          />
          <MainSection c={c} onPlan={(title, actions) => setPlanReq({ title, load: () => api.plan(actions) })} />
        </>
      )}

      <RuleSection q={ruleQ} onPlan={(title, actions) => setPlanReq({ title, load: () => api.plan(actions) })} />

      <section id="sec-env" className="card">
        <div className="card-h">
          <h2>环境变量检查</h2>
          <span className="small muted">只读。agentree 只报告，不修改环境变量</span>
        </div>
        {c ? <EnvTable env={c.env} /> : <div className="empty small">—</div>}
      </section>

      <BackupsSection q={backupsQ} onRestore={(b) => setPlanReq({ title: `从备份恢复：${b.filePath}`, load: () => api.restore(b.id) })} />

      {editor && c && (
        <AgentEditor
          def={editor.def}
          definitions={c.definitions}
          projects={projects}
          builtins={c.builtinAgentTypes}
          onCancel={() => setEditor(null)}
          onDone={() => {
            setEditor(null);
            refreshAll();
          }}
        />
      )}
      {deleting && (
        <DeleteConfirm
          def={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            setPlanReq({
              title: `删除 agent：${d.name}`,
              load: async () => {
                const detail = await api.agentDetail(d.filePath);
                return api.plan([{ type: 'agent.delete', filePath: d.filePath, baseHash: detail.hash }]);
              },
            });
          }}
        />
      )}
      {planReq && <PlanDialog title={planReq.title} load={planReq.load} onClose={() => setPlanReq(null)} onApplied={refreshAll} />}
    </div>
  );
}

function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- 子 agent ----------

function AgentsSection({
  c,
  onNew,
  onEdit,
  onDelete,
}: {
  c: ClaudeConfigSnapshot;
  onNew: () => void;
  onEdit: (d: AgentDefinition) => void;
  onDelete: (d: AgentDefinition) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, AgentDefinition[]>();
    for (const d of c.definitions) {
      const k = d.source === 'user' ? '__user' : d.projectCwd ?? '（未知项目）';
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '__user' ? -1 : b[0] === '__user' ? 1 : a[0].localeCompare(b[0])));
  }, [c.definitions]);

  return (
    <section id="sec-agents" className="card">
      <div className="card-h">
        <h2>子 agent</h2>
        <span className="small muted">{c.definitions.length} 个定义文件</span>
        <span className="spacer" />
        <button className="btn sm primary" onClick={onNew}>
          + 新建 agent
        </button>
      </div>
      {groups.length === 0 ? (
        <Empty title="还没有 agent 定义文件">点"新建 agent"创建第一个。</Empty>
      ) : (
        groups.map(([k, defs]) => (
          <div key={k}>
            <div className="small" style={{ padding: '8px 14px 4px', color: 'var(--text-muted)', fontWeight: 600 }}>
              {k === '__user' ? (
                <>用户级 <span className="mono dim" style={{ fontWeight: 400 }}>{c.configDir}\agents</span></>
              ) : (
                <>项目级 <span className="mono dim" style={{ fontWeight: 400, overflowWrap: 'anywhere' }}>{k}</span></>
              )}
            </div>
            <div className="table-wrap">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>名字</th>
                    <th>模型</th>
                    <th>effort</th>
                    <th>工具</th>
                    <th>描述</th>
                    <th style={{ width: 120 }} />
                  </tr>
                </thead>
                <tbody>
                  {defs.map((d) => (
                    <tr key={d.filePath}>
                      <td className="mono nowrap" title={d.filePath}>
                        {d.name}
                      </td>
                      <td className="nowrap">
                        {!d.model ? <span className="dim">默认</span> : d.model === 'inherit' ? <span className="mono muted">inherit</span> : <ModelTag model={d.model} />}
                      </td>
                      <td className="mono">{d.effort ?? <span className="dim">—</span>}</td>
                      <td className="small ellipsis" style={{ maxWidth: 180 }} title={d.tools ?? '全部工具'}>
                        {d.tools ?? <span className="dim">全部</span>}
                      </td>
                      <td className="small ellipsis" style={{ maxWidth: 320 }} title={d.description ?? ''}>
                        {d.description ?? <span className="dim">（无法读取描述）</span>}
                      </td>
                      <td className="nowrap right">
                        <button className="btn sm" onClick={() => onEdit(d)}>
                          编辑
                        </button>{' '}
                        <button className="btn sm danger" onClick={() => onDelete(d)} aria-label={`删除 ${d.name}`}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      <div className="small muted" style={{ padding: '8px 14px 10px' }}>
        内置类型（{c.builtinAgentTypes.join('、')}）没有定义文件，不能在这里修改。
      </div>
    </section>
  );
}

function DeleteConfirm({ def, onCancel, onConfirm }: { def: AgentDefinition; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title={`删除 agent：${def.name}？`}
      onCancel={onCancel}
      width={560}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn danger" onClick={onConfirm} style={{ borderColor: 'var(--fail)' }}>
            继续，查看删除计划
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className="mono small" style={{ overflowWrap: 'anywhere' }}>
          {def.filePath}
        </div>
        <div>
          这个文件会被<b>移到 agentree 的备份目录</b>（~/.agentree/backups），不会永久删除，之后可以在本页"备份"里恢复。
        </div>
        <div className="small muted">下一步会显示删除计划和文件的原内容，以及后端给出的生效说明，确认后才执行。</div>
      </div>
    </Modal>
  );
}

// ---------- 主会话与 advisor ----------

interface EffortRow {
  key: number;
  model: string;
  effort: string | null;
  /** 原来就有的行记录原模型名，便于识别删除 */
  original: string | null;
}
let rowSeq = 1;

function MainSection({ c, onPlan }: { c: ClaudeConfigSnapshot; onPlan: (title: string, actions: ConfigAction[]) => void }) {
  const s = c.settings;
  const baseKey = JSON.stringify(s);
  const init = useCallback(
    () => ({
      model: s.model,
      advisor: s.advisorModel,
      effort: s.effortLevel,
      rows: Object.entries(s.modelEffort).map(([m, e]) => ({ key: rowSeq++, model: m, effort: e, original: m }) as EffortRow),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseKey],
  );
  const [f, setF] = useState(init);
  // 应用成功后配置快照会变，这时用新值重置表单
  useEffect(() => setF(init()), [init]);

  const actions: ConfigAction[] = [];
  const norm = (v: string | null) => (v && v.trim() ? v.trim() : null);
  if (norm(f.model) !== s.model) actions.push({ type: 'settings.mainModel', value: norm(f.model) });
  if (norm(f.advisor) !== s.advisorModel) actions.push({ type: 'settings.advisorModel', value: norm(f.advisor) });
  if (f.effort !== s.effortLevel) actions.push({ type: 'settings.effort', model: null, value: f.effort });
  const rowErrors = new Map<number, string>();
  const seen = new Set<string>();
  for (const r of f.rows) {
    const m = r.model.trim();
    if (!m) rowErrors.set(r.key, '请填写完整模型 ID');
    else if (seen.has(m)) rowErrors.set(r.key, '模型重复');
    seen.add(m);
  }
  for (const r of f.rows) {
    const m = r.model.trim();
    if (!m || rowErrors.has(r.key)) continue;
    if (r.original && r.original !== m) actions.push({ type: 'settings.effort', model: r.original, value: null });
    if (s.modelEffort[m] !== (r.effort ?? undefined)) actions.push({ type: 'settings.effort', model: m, value: r.effort });
  }
  for (const orig of Object.keys(s.modelEffort)) {
    if (!f.rows.some((r) => r.original === orig)) actions.push({ type: 'settings.effort', model: orig, value: null });
  }
  const dedup = actions.filter((a, i) => actions.findIndex((b) => JSON.stringify(b) === JSON.stringify(a)) === i);

  return (
    <section id="sec-main" className="card">
      <div className="card-h">
        <h2>主会话与 advisor</h2>
        <span className="small mono dim" style={{ overflowWrap: 'anywhere' }}>
          {c.configDir}\settings.json
        </span>
      </div>
      <div className="card-b stack" style={{ gap: 12 }}>
        <div className="alert warn small">
          <div className="alert-body">
            本机的会话都是从桌面版启动的，桌面版在界面上按会话选择模型和 effort。settings.json 里的设置对命令行启动的会话有效，对桌面版是否生效尚未验证。
            {c.ccSwitchDetected && ' 另外检测到 cc-switch，它切换供应商时会覆盖 model 和 advisorModel。'}
          </div>
        </div>
        <div className="form-grid">
          <label>主模型 model</label>
          <div>
            <ModelInput value={f.model} onChange={(v) => setF({ ...f, model: v })} emptyLabel="不设置（删除这个键）" placeholder="如 claude-opus-5-5" />
            <div className="field-hint">当前：{s.model ?? '未设置'}</div>
          </div>
          <label>advisorModel</label>
          <div>
            <ModelInput value={f.advisor} onChange={(v) => setF({ ...f, advisor: v })} emptyLabel="不设置（删除这个键）" placeholder="如 fable" />
            <div className="field-hint">当前：{s.advisorModel ?? '未设置'}</div>
          </div>
          <label>全局 effortLevel</label>
          <div>
            <EffortSelect value={f.effort} onChange={(v) => setF({ ...f, effort: v })} emptyLabel="不设置" allowMax={false} />
            <div className="field-hint">对 Opus 5、Fable 5.1 及更早的模型有效；Opus 5.5 及之后的模型会忽略它，请在下面按模型设置。settings 不接受 max。</div>
          </div>
          <label className="top">按模型的 effort</label>
          <div className="stack" style={{ gap: 6 }}>
            {f.rows.length === 0 && <div className="small dim">没有设置（modelSettings.&lt;模型&gt;.effortLevel）</div>}
            {f.rows.map((r) => (
              <div key={r.key}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <input
                    className={`input mono ${rowErrors.has(r.key) ? 'invalid' : ''}`}
                    style={{ flex: '1 1 200px', maxWidth: 280 }}
                    value={r.model}
                    placeholder="完整模型 ID，如 claude-opus-5-5"
                    aria-label="模型 ID"
                    onChange={(e) => setF({ ...f, rows: f.rows.map((x) => (x.key === r.key ? { ...x, model: e.target.value } : x)) })}
                    spellCheck={false}
                  />
                  <EffortSelect
                    value={r.effort}
                    allowMax={false}
                    emptyLabel="删除这项"
                    onChange={(v) => setF({ ...f, rows: f.rows.map((x) => (x.key === r.key ? { ...x, effort: v } : x)) })}
                  />
                  <button className="btn icon sm ghost danger" aria-label="移除这一行" title="移除这一行" onClick={() => setF({ ...f, rows: f.rows.filter((x) => x.key !== r.key) })}>
                    ✕
                  </button>
                </div>
                {rowErrors.has(r.key) && <div className="field-err">{rowErrors.get(r.key)}</div>}
              </div>
            ))}
            <div>
              <button className="btn sm" onClick={() => setF({ ...f, rows: [...f.rows, { key: rowSeq++, model: '', effort: 'high', original: null }] })}>
                + 添加模型
              </button>
            </div>
          </div>
        </div>
        <div className="row wrap">
          <button className="btn primary" disabled={dedup.length === 0 || rowErrors.size > 0} onClick={() => onPlan('修改 settings.json', dedup)}>
            {dedup.length ? `预览这 ${dedup.length} 项修改…` : '没有修改'}
          </button>
          <button className="btn" disabled={dedup.length === 0} onClick={() => setF(init())}>
            撤销
          </button>
          <span className="small muted">只改这几个键，settings.json 里的其他内容（hooks、permissions、env 等）一个字节都不动。</span>
        </div>
      </div>
    </section>
  );
}

// ---------- CLAUDE.md 规则 ----------

function RuleSection({
  q,
  onPlan,
}: {
  q: ApiState<ClaudeMdRuleState>;
  onPlan: (title: string, actions: ConfigAction[]) => void;
}) {
  const r = q.data;
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState('');
  const baseKey = r ? JSON.stringify(r) : '';
  useEffect(() => {
    if (!r) return;
    setEnabled(r.enabled);
    setText(r.text ?? r.defaultText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  if (!r) {
    return (
      <section id="sec-rule" className="card">
        <div className="card-h">
          <h2>CLAUDE.md 规则</h2>
        </div>
        <div className="card-b">{q.error ? <ErrorBox error={q.error} onRetry={q.refresh} /> : <Loading />}</div>
      </section>
    );
  }
  const currentText = r.text ?? r.defaultText;
  // error 字段是后来加的，旧后端没有，按 null 处理
  const broken = r.error != null && r.error !== '';
  const changed = !broken && (enabled !== r.enabled || (enabled && text.replace(/\s+$/, '') !== currentText.replace(/\s+$/, '')));
  const submit = () => {
    const t = text.replace(/\s+$/, '');
    onPlan(enabled ? (r.enabled ? '更新 CLAUDE.md 规则' : '启用 CLAUDE.md 规则') : '停用 CLAUDE.md 规则', [
      { type: 'claudeMd.rule', enabled, text: enabled ? (t === r.defaultText.replace(/\s+$/, '') ? null : t) : null },
    ]);
  };
  return (
    <section id="sec-rule" className="card">
      <div className="card-h">
        <h2>CLAUDE.md 规则</h2>
        <span className={`badge ${r.enabled ? 'ok' : 'muted'}`}>{r.enabled ? '当前已启用' : '当前未启用'}</span>
        <span className="small mono dim" style={{ overflowWrap: 'anywhere' }}>
          {r.filePath}
          {!r.fileExists && '（文件不存在，启用时会新建）'}
        </span>
      </div>
      <div className="card-b stack" style={{ gap: 10 }}>
        <div className="small muted">
          告诉主会话什么时候该咨询 advisor。规则写在两个标记之间，agentree 只改标记之间的内容，文件里的其他内容一个字节都不动。
        </div>
        {broken && (
          <div className="alert error" role="alert">
            <span className="mono" style={{ fontWeight: 700, color: 'var(--fail)' }}>
              ✗
            </span>
            <div className="alert-body">
              <div className="title">CLAUDE.md 里的规则标记损坏，已停用这里的开关</div>
              <div className="small">{r.error}</div>
              <div className="small">
                请用编辑器打开 <span className="mono">{r.filePath}</span>，检查 <span className="mono">&lt;!-- agentree:advisor-rule:start --&gt;</span> 和{' '}
                <span className="mono">&lt;!-- agentree:advisor-rule:end --&gt;</span> 是否各只有一个且成对，修好后点"重新检查"。
              </div>
            </div>
            <button className="btn sm" onClick={() => void q.refresh()}>
              重新检查
            </button>
          </div>
        )}
        <label className="switch" style={broken ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
          <input type="checkbox" checked={enabled} disabled={broken} onChange={(e) => setEnabled(e.target.checked)} />
          {enabled ? '启用规则' : '不启用（会删除规则块）'}
        </label>
        {enabled && !broken && (
          <>
            <textarea className="textarea mono" rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="规则文案" spellCheck={false} />
            <div className="row wrap">
              <button className="btn sm" onClick={() => setText(r.defaultText)} disabled={text === r.defaultText}>
                恢复默认文案
              </button>
            </div>
          </>
        )}
        <div className="row wrap">
          <button className="btn primary" disabled={!changed} onClick={submit}>
            {broken ? '标记损坏，无法修改' : !changed ? '没有修改' : enabled ? (r.enabled ? '预览：更新规则…' : '预览：启用规则…') : '预览：停用规则…'}
          </button>
          {changed && (
            <button
              className="btn"
              onClick={() => {
                setEnabled(r.enabled);
                setText(currentText);
              }}
            >
              撤销
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- 备份 ----------

function BackupsSection({ q, onRestore }: { q: ApiState<BackupEntry[]>; onRestore: (b: BackupEntry) => void }) {
  const [filter, setFilter] = useState('');
  const list = (q.data ?? []).filter((b) => !filter || b.filePath.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section id="sec-backups" className="card">
      <div className="card-h">
        <h2>备份</h2>
        <span className="small muted">~/.agentree/backups · {q.data ? `${q.data.length} 份` : ''}</span>
        <span className="spacer" />
        <input className="input" placeholder="按文件路径筛选" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
        <button className="btn sm" onClick={() => void q.refresh()}>
          刷新
        </button>
      </div>
      <div className="small muted" style={{ padding: '8px 14px 0' }}>
        首写备份是 agentree 第一次修改某个文件之前的原件，永久保留；变更前备份每个文件保留最近 20 份。恢复也会先显示差异，并在恢复前对当前状态再备份一次。
      </div>
      {q.error && (
        <div className="card-b">
          <ErrorBox error={q.error} onRetry={q.refresh} stale={!!q.data} />
        </div>
      )}
      {q.loading && !q.data && <Loading text="读取备份" />}
      {q.data &&
        (list.length === 0 ? (
          <Empty title={q.data.length ? '没有匹配的备份' : '还没有备份'}>{q.data.length ? '' : 'agentree 修改文件之前会自动备份。'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data compact">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>文件</th>
                  <th>类型</th>
                  <th className="num">大小</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td className="nowrap small" title={formatFullDateTime(b.createdAt)}>
                      {formatFullDateTime(b.createdAt)}
                      <div className="dim">{relativeTime(b.createdAt)}</div>
                    </td>
                    <td className="mono small" style={{ overflowWrap: 'anywhere', minWidth: 220 }}>
                      {b.filePath}
                      <div className="dim">ID {b.id}</div>
                    </td>
                    <td className="nowrap">
                      <span className={`badge ${b.kind === 'first-write' ? 'info' : 'muted'}`}>{b.kind === 'first-write' ? '首写备份 · 永久' : '变更前'}</span>
                      {!b.existedBefore && <div className="small dim">当时文件不存在</div>}
                    </td>
                    <td className="num small">{b.existedBefore ? `${fullNumber(b.size)} B` : '—'}</td>
                    <td className="right">
                      <button className="btn sm" onClick={() => onRestore(b)} title={b.existedBefore ? '把文件恢复成这份备份的内容' : '这份备份表示当时文件不存在，恢复即删除当前文件'}>
                        恢复…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

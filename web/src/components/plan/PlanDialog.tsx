import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApplyResult, ChangePlan, FileChange, PlanNote } from '../../types';
import { api, ApiFailure } from '../../api/client';
import { diffLines, diffStats, splitText } from '../../lib/diff';
import { useNow } from '../../lib/useApi';
import Modal from '../Modal';
import DiffView from './DiffView';
import { LevelBadge } from '../ui';

const KIND_LABEL: Record<FileChange['kind'], string> = { create: '新建', modify: '修改', delete: '删除' };
const KIND_CLS: Record<FileChange['kind'], string> = { create: 'ok', modify: 'info', delete: 'fail' };
const LEVEL_ORDER = { fail: 0, warn: 1, info: 2, ok: 3 } as const;

type Phase =
  | { t: 'loading' }
  | { t: 'error'; error: string }
  | { t: 'review'; plan: ChangePlan }
  | { t: 'applying'; plan: ChangePlan }
  | { t: 'done'; plan: ChangePlan; result: ApplyResult }
  /** stale：计划已用过或已过期（409），确定没有写入；unknown：请求没有正常返回 */
  | { t: 'apply-error'; plan: ChangePlan; error: string; stale: boolean };

interface Props {
  title: string;
  /** 已经生成好的计划（可选）。没有时打开后调用 load 生成 */
  initialPlan?: ChangePlan;
  /** 生成（或重新生成）计划 */
  load: () => Promise<ChangePlan>;
  onClose: () => void;
  /** 应用接口返回后调用（不论全部成功还是部分失败） */
  onApplied?: (r: ApplyResult) => void;
  /** 全部写入成功后显示的"接下来做什么" */
  nextSteps?: ReactNode;
}

function errText(e: unknown) {
  return e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : String(e);
}

/**
 * 差异确认对话框：所有写入 Claude Code 配置的操作都经过这里。
 * 生成计划 → 看提示和逐文件差异 → 点"应用这 N 项修改" → 看每个文件的结果。
 */
export default function PlanDialog({ title, initialPlan, load, onClose, onApplied, nextSteps }: Props) {
  const [phase, setPhase] = useState<Phase>(initialPlan ? { t: 'review', plan: initialPlan } : { t: 'loading' });

  const regenerate = useCallback(async () => {
    setPhase({ t: 'loading' });
    try {
      setPhase({ t: 'review', plan: await load() });
    } catch (e) {
      setPhase({ t: 'error', error: errText(e) });
    }
  }, [load]);

  // 只在打开时生成一次（开发模式的 StrictMode 会把 effect 执行两次，用 ref 防止重复生成计划）
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!initialPlan) void regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (plan: ChangePlan) => {
    setPhase({ t: 'applying', plan });
    try {
      const result = await api.apply(plan.id);
      setPhase({ t: 'done', plan, result });
      onApplied?.(result);
    } catch (e) {
      setPhase({ t: 'apply-error', plan, error: errText(e), stale: e instanceof ApiFailure && e.status === 409 });
    }
  };

  const busy = phase.t === 'applying';
  const plan = 'plan' in phase ? phase.plan : null;

  return (
    <Modal
      title={title}
      onCancel={busy ? undefined : onClose}
      width={980}
      pinned={plan ? <Pinned phase={phase} plan={plan} /> : undefined}
      footer={<Footer phase={phase} onClose={onClose} onApply={apply} onRegenerate={regenerate} />}
    >
      {phase.t === 'loading' && <div className="loading">正在生成修改计划（不会写入任何文件）</div>}
      {phase.t === 'error' && (
        <div className="alert error" role="alert">
          <div className="alert-body">
            <div className="title">生成计划失败，没有修改任何文件</div>
            <div>{phase.error}</div>
          </div>
        </div>
      )}
      {(phase.t === 'review' || phase.t === 'applying' || phase.t === 'apply-error') && <ChangeList plan={phase.plan} />}
      {phase.t === 'done' && (
        <div className="stack" style={{ gap: 14 }}>
          {phase.result.failed.length === 0 && phase.result.applied.length > 0 && (
            <>
              {nextSteps && (
                <div className="next-box">
                  <h3>接下来</h3>
                  {nextSteps}
                </div>
              )}
              {/* 写入前看过的提示里，和"什么时候生效"有关的在写入后仍然有用 */}
              {phase.plan.notes.filter((n) => n.level !== 'ok').length > 0 && (
                <NotesBox notes={[...phase.plan.notes].filter((n) => n.level !== 'ok').sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])} />
              )}
            </>
          )}
          <ResultList plan={phase.plan} result={phase.result} />
        </div>
      )}
    </Modal>
  );
}

// ---------- 顶部固定区：错误、提示、结果摘要 ----------

function Pinned({ phase, plan }: { phase: Phase; plan: ChangePlan }) {
  const now = useNow(1000);
  const expiresIn = new Date(plan.expiresAt).getTime() - now;
  const notes = [...plan.notes].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  if (phase.t === 'done') return <ResultSummary plan={plan} result={phase.result} />;

  return (
    <div className="stack" style={{ gap: 8 }}>
      {plan.blocked && (
        <div className="alert error" role="alert">
          <span className="mono" style={{ fontWeight: 700, color: 'var(--fail)' }}>
            ✗
          </span>
          <div className="alert-body">
            <div className="title">这个计划无法安全执行，已被阻止。不会写入任何文件。</div>
            {(plan.conflicts ?? []).length > 0 && (
              <div className="small" style={{ margin: '4px 0' }}>
                以下文件在你打开之后被其他程序修改过，为了不覆盖别人的修改没有生成计划。请关闭后重新加载再操作：
                <ul className="plain-list">
                  {plan.conflicts.map((p) => (
                    <li key={p} className="mono small">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.errors.length ? (
              <ul className="plain-list">
                {plan.errors.map((e, i) => (
                  <li key={i} className="mono small">
                    {e}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="small">后端没有给出具体原因。</div>
            )}
          </div>
        </div>
      )}
      {phase.t === 'apply-error' && (
        <div className="alert error" role="alert">
          {phase.stale ? (
            <div className="alert-body">
              <div className="title">这个计划已经用过或已过期，没有写入任何文件</div>
              <div className="small">{phase.error}</div>
              <div className="small">每个计划只能应用一次，10 分钟后过期。请点"重新生成计划"，按文件的当前状态重新计算。</div>
            </div>
          ) : (
            <div className="alert-body">
              <div className="title">应用请求失败</div>
              <div className="small">{phase.error}</div>
              <div className="small">请求没有正常返回，无法确定哪些文件已经写入。建议关闭后到"配置 → 备份"查看，或重新生成计划核对当前状态。</div>
            </div>
          )}
        </div>
      )}
      {notes.length > 0 && <NotesBox notes={notes} />}
      {!plan.blocked && phase.t === 'review' && (
        <div className={`small ${expiresIn <= 0 ? '' : 'muted'}`} style={expiresIn <= 0 ? { color: 'var(--fail)' } : undefined}>
          {expiresIn <= 0
            ? '计划已过期（10 分钟），请重新生成。'
            : `计划将在 ${Math.floor(expiresIn / 60000)} 分 ${String(Math.floor((expiresIn % 60000) / 1000)).padStart(2, '0')} 秒后过期。点"应用"之前不会写入任何文件。`}
        </div>
      )}
    </div>
  );
}

function NotesBox({ notes }: { notes: PlanNote[] }) {
  return (
    <div className="notes-box" role="list" aria-label="提示和警告">
      {notes.map((n, i) => (
        <div key={i} className={`note-row ${n.level}`} role="listitem">
          <LevelBadge level={n.level} />
          <span>{n.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- 文件列表 ----------

function ChangeList({ plan }: { plan: ChangePlan }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(plan.changes.length <= 2 ? plan.changes.map((_, i) => i) : []));
  if (plan.changes.length === 0) {
    return <div className="empty small">{plan.blocked ? '计划被阻止，没有可执行的修改。' : '没有需要修改的内容：当前配置已经和目标一致。'}</div>;
  }
  const allOpen = open.size === plan.changes.length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row small muted">
        <span>
          共 {plan.changes.length} 个文件：
          {(['create', 'modify', 'delete'] as const)
            .map((k) => [k, plan.changes.filter((c) => c.kind === k).length] as const)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${KIND_LABEL[k]} ${n}`)
            .join('，')}
        </span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(plan.changes.map((_, i) => i)))}>
          {allOpen ? '全部收起' : '全部展开差异'}
        </button>
      </div>
      {plan.changes.map((c, i) => (
        <FileItem
          key={c.filePath + i}
          change={c}
          index={i}
          open={open.has(i)}
          onToggle={() =>
            setOpen((s) => {
              const n = new Set(s);
              if (n.has(i)) n.delete(i);
              else n.add(i);
              return n;
            })
          }
        />
      ))}
    </div>
  );
}

function FileItem({ change, index, open, onToggle }: { change: FileChange; index: number; open: boolean; onToggle: () => void }) {
  const stats = useMemo(() => diffStats(diffLines(splitText(change.before).lines, splitText(change.after).lines)), [change]);
  const panelId = `file-diff-${index}`;
  return (
    <div className="file-item">
      <button type="button" className="file-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <span className="file-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={`badge ${KIND_CLS[change.kind]}`}>{KIND_LABEL[change.kind]}</span>
        <span className="file-main">
          <span className="file-path mono">{change.filePath}</span>
          <span className="file-summary">{change.summary}</span>
        </span>
        <span className="file-stats num">
          {stats.add > 0 && <span style={{ color: 'var(--ok)' }}>+{stats.add}</span>}
          {stats.del > 0 && <span style={{ color: 'var(--fail)' }}> −{stats.del}</span>}
        </span>
      </button>
      {open && (
        <div id={panelId} className="file-body">
          {change.kind === 'create' && <div className="small muted" style={{ marginBottom: 4 }}>新文件的完整内容：</div>}
          {change.kind === 'delete' && (
            <div className="small muted" style={{ marginBottom: 4 }}>
              文件会被移到 agentree 的备份目录，不会永久删除，可以在"配置 → 备份"里恢复。原内容：
            </div>
          )}
          <DiffView before={change.before} after={change.after} />
        </div>
      )}
    </div>
  );
}

// ---------- 结果 ----------

function classify(plan: ChangePlan, result: ApplyResult) {
  const applied = new Map(result.applied.map((a) => [a.filePath, a]));
  const failed = new Map(result.failed.filter((f) => f.filePath).map((f) => [f.filePath, f]));
  // 后端对整个计划的失败（如 blocked）可能不带 filePath，这时套用到所有没有结果的文件上
  const general = result.failed.find((f) => !f.filePath) ?? null;
  const rows = plan.changes.map((c) => {
    const a = applied.get(c.filePath) ?? null;
    return { change: c, applied: a, failed: failed.get(c.filePath) ?? (a ? null : general) };
  });
  if (general && plan.changes.length === 0) {
    rows.push({ change: { filePath: '（整个计划）', kind: 'modify', before: null, after: null, baseHash: null, summary: '' }, applied: null, failed: general });
  }
  // 结果里有、计划里没有的文件（理论上不该发生）也要显示出来
  for (const a of result.applied) if (!plan.changes.some((c) => c.filePath === a.filePath)) rows.push({ change: { filePath: a.filePath, kind: a.kind, before: null, after: null, baseHash: null, summary: '' }, applied: a, failed: null });
  for (const f of result.failed)
    if (f.filePath && !plan.changes.some((c) => c.filePath === f.filePath))
      rows.push({ change: { filePath: f.filePath, kind: 'modify', before: null, after: null, baseHash: null, summary: '' }, applied: null, failed: f });
  const withState = rows.map((r) => ({ ...r, state: rowState(r) }));
  const ok = withState.filter((r) => r.state === 'ok').length;
  const bad = withState.filter((r) => r.state === 'fail').length;
  const skipped = withState.filter((r) => r.state === 'skip').length;
  return { rows: withState, ok, bad, skipped };
}

type Failed = ApplyResult['failed'][number];

/** 失败项里 code 为 skipped 的算"未执行"；结果里完全没出现的文件（旧后端）也算未执行 */
function rowState(r: { applied: ApplyResult['applied'][number] | null; failed: Failed | null }): 'ok' | 'fail' | 'skip' {
  if (r.failed) return r.failed.code === 'skipped' ? 'skip' : 'fail';
  return r.applied ? 'ok' : 'skip';
}

const CODE_LABEL: Record<string, string> = {
  conflict: '文件在生成计划后被修改过',
  permission: '没有写权限或文件被占用',
  'not-allowed': '路径不在允许写入的范围内',
  blocked: '计划被阻止',
  io: '读写错误',
};

/** 只有文件在计划生成后被改过时，重新生成计划才有意义；旧后端没有 code 时也给出这个选项 */
export function shouldOfferRegenerate(result: ApplyResult): boolean {
  return result.failed.some((f) => f.code === 'conflict' || f.code == null);
}

function ResultSummary({ plan, result }: { plan: ChangePlan; result: ApplyResult }) {
  const { ok, bad, skipped } = classify(plan, result);
  const conflict = result.failed.some((f) => f.code === 'conflict');
  const cls = bad === 0 && skipped === 0 ? 'info' : 'error';
  return (
    <div className={`alert ${cls}`} role="status">
      <span className="mono" style={{ fontWeight: 700, color: cls === 'info' ? 'var(--ok)' : 'var(--fail)' }}>
        {cls === 'info' ? '✓' : '✗'}
      </span>
      <div className="alert-body">
        <div className="title">
          {bad === 0 && skipped === 0
            ? `全部 ${ok} 项修改已写入`
            : ok === 0
              ? `没有写入任何文件：失败 ${bad} 项${skipped ? `，未执行 ${skipped} 项` : ''}`
              : `部分失败：成功 ${ok} 项，失败 ${bad} 项${skipped ? `，未执行 ${skipped} 项` : ''}`}
        </div>
        <div className="small">
          {bad > 0 && '失败的文件保持原样。某个文件失败后，排在它后面的文件不会继续执行。已成功的修改不会自动回滚，可以在"配置 → 备份"里恢复。'}
          {conflict && ' 有文件在生成计划之后被其他程序修改过，点"重新生成计划"按最新内容重新计算。'}
          {bad === 0 && '修改前的原文件已经备份（位置见下方每个文件），可以在"配置 → 备份"里恢复。'}
        </div>
      </div>
    </div>
  );
}

function ResultList({ plan, result }: { plan: ChangePlan; result: ApplyResult }) {
  const { rows } = classify(plan, result);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => {
        const state = r.state;
        return (
          <div key={i} className={`result-row ${state}`} style={{ ['--i' as string]: Math.min(i, 8) }}>
            <span className={`badge ${state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : 'muted'}`}>
              {state === 'ok' ? '✓ 成功' : state === 'fail' ? '✗ 失败' : '— 未执行'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono small file-path">
                <span className="dim">{KIND_LABEL[r.change.kind]} · </span>
                {r.change.filePath}
              </div>
              {r.change.summary && <div className="small muted">{r.change.summary}</div>}
              {r.failed && state === 'fail' && (
                <div className="small" style={{ color: 'var(--fail)', overflowWrap: 'anywhere' }}>
                  {r.failed.code && CODE_LABEL[r.failed.code] ? `${CODE_LABEL[r.failed.code]}：` : '原因：'}
                  {r.failed.reason}
                </div>
              )}
              {r.applied && (
                <div className="small dim" style={{ overflowWrap: 'anywhere' }}>
                  {r.applied.kind === 'create' || !r.applied.backupPath ? (
                    // 新建的文件没有"修改前的内容"，后端只记了一条元数据，恢复它等于删掉这个新文件
                    r.applied.backupId ? (
                      '这是新建的文件，之前不存在。要撤销，可以在"配置 → 备份"里恢复到新建之前。'
                    ) : (
                      '这是新建的文件，之前不存在。'
                    )
                  ) : (
                    <>
                      修改前的备份：<span className="mono">{r.applied.backupPath}</span>
                    </>
                  )}
                </div>
              )}
              {state === 'skip' && <div className="small dim">{r.failed?.reason || '前面的文件失败后停止，这个文件没有被修改。'}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 底部按钮 ----------

function Footer({
  phase,
  onClose,
  onApply,
  onRegenerate,
}: {
  phase: Phase;
  onClose: () => void;
  onApply: (p: ChangePlan) => void;
  onRegenerate: () => void;
}) {
  const now = useNow(1000);
  if (phase.t === 'done') {
    return (
      <>
        {shouldOfferRegenerate(phase.result) && (
          <button className="btn" onClick={onRegenerate} title="按文件的当前状态重新计算修改">
            重新生成计划
          </button>
        )}
        <span className="spacer" />
        <button className="btn primary" onClick={onClose} data-autofocus>
          关闭
        </button>
      </>
    );
  }
  if (phase.t === 'loading' || phase.t === 'error') {
    return (
      <>
        {phase.t === 'error' && (
          <button className="btn" onClick={onRegenerate}>
            重试
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          取消
        </button>
      </>
    );
  }
  const plan = phase.plan;
  const n = plan.changes.length;
  const expired = new Date(plan.expiresAt).getTime() <= now;
  const disabled = phase.t !== 'review' || plan.blocked || n === 0 || expired;
  const label =
    phase.t === 'applying'
      ? `正在写入 ${n} 个文件…`
      : plan.blocked
        ? '无法应用（计划被阻止）'
        : n === 0
          ? '没有需要应用的修改'
          : expired
            ? '计划已过期'
            : `应用这 ${n} 项修改`;
  return (
    <>
      {(expired || phase.t === 'apply-error') && (
        <button className="btn" onClick={onRegenerate}>
          重新生成计划
        </button>
      )}
      <span className="spacer" />
      <button className="btn" onClick={onClose} disabled={phase.t === 'applying'}>
        取消
      </button>
      <button className={`btn ${plan.blocked ? 'danger' : 'primary'}`} disabled={disabled} onClick={() => onApply(plan)}>
        {label}
      </button>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, AgentDefinitionDetail, ChangePlan, ConfigAction } from '../../types';
import { api, ApiFailure } from '../../api/client';
import Modal from '../Modal';
import PlanDialog from '../plan/PlanDialog';
import { EffortSelect, ModelInput } from '../inputs';
import { Loading } from '../ui';

export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 后端返回的计划是不是"文件被其他程序改过"导致的冲突。以 conflicts 字段为准；旧后端没有这个字段时当作没有冲突 */
export function isConflictPlan(plan: ChangePlan): boolean {
  return Array.isArray(plan.conflicts) && plan.conflicts.length > 0;
}

export function validateAgentName(name: string, builtins: string[]): string | null {
  if (!name) return '名字不能为空';
  if (!AGENT_NAME_RE.test(name)) return '只能用字母、数字、- 和 _，以字母或数字开头，最长 64 个字符';
  if (WIN_RESERVED.test(name)) return `${name} 是 Windows 保留名，不能用作文件名`;
  if (builtins.some((b) => b.toLowerCase() === name.toLowerCase())) return `${name} 是内置类型，内置类型无法通过定义文件修改`;
  return null;
}

interface Form {
  name: string;
  scope: 'user' | 'project';
  projectCwd: string;
  description: string;
  model: string | null;
  effort: string | null;
  tools: string;
  body: string;
}

interface Props {
  /** 编辑已有文件时传入；新建时为 null */
  def: AgentDefinition | null;
  definitions: AgentDefinition[];
  projects: string[];
  builtins: string[];
  onCancel: () => void;
  /** 写入完成（有文件成功写入）后关闭编辑器时调用 */
  onDone: () => void;
}

export default function AgentEditor({ def, definitions, projects, builtins, onCancel, onDone }: Props) {
  const editing = !!def;
  const [detail, setDetail] = useState<AgentDefinitionDetail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(() => ({
    name: '',
    scope: 'user',
    projectCwd: projects[0] ?? '',
    description: '',
    model: null,
    effort: null,
    tools: '',
    body: '',
  }));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ plan: ChangePlan; action: ConfigAction } | null>(null);
  const appliedRef = useRef(false);

  const load = useCallback(async () => {
    if (!def) return;
    setLoadErr(null);
    setDetail(null);
    try {
      const d = await api.agentDetail(def.filePath);
      setDetail(d);
      setForm({
        name: d.name,
        scope: d.source,
        projectCwd: d.projectCwd ?? '',
        description: d.description ?? '',
        model: d.model,
        effort: d.effort,
        tools: d.tools ?? '',
        body: d.body,
      });
      setConflict(null);
      setPlanErr(null);
    } catch (e) {
      setLoadErr(e instanceof ApiFailure ? e.message : String(e));
    }
  }, [def]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTouched(true);
  };

  const name = form.name.trim();
  const dirPrefix = form.scope === 'user' ? null : form.projectCwd;
  const nameError = useMemo(() => {
    const base = validateAgentName(name, builtins);
    if (base) return base;
    const renamed = editing && detail && name !== detail.name;
    if (!editing || renamed) {
      const clash = definitions.find(
        (d) => d.name.toLowerCase() === name.toLowerCase() && d.source === form.scope && (form.scope === 'user' || d.projectCwd === dirPrefix),
      );
      if (clash) return editing ? `改名失败：同一位置已有 ${clash.name}` : `同名文件已存在（${clash.filePath}），请在列表里编辑它`;
    }
    return null;
  }, [name, builtins, editing, detail, definitions, form.scope, dirPrefix]);
  const descError = form.description.trim() ? null : '描述不能为空：Claude Code 靠它决定什么时候派发这个 agent';
  const scopeError = form.scope === 'project' && !form.projectCwd ? '请选择项目' : null;
  const valid = !nameError && !descError && !scopeError && (!editing || !!detail);

  const buildAction = (): ConfigAction => {
    const bodyChanged = editing ? form.body !== detail!.body : form.body.trim() !== '';
    return {
      type: 'agent.upsert',
      scope: form.scope,
      projectCwd: form.scope === 'project' ? form.projectCwd : null,
      name,
      originalName: editing && detail && detail.name !== name ? detail.name : null,
      fields: {
        description: form.description.trim(),
        model: form.model?.trim() ? form.model.trim() : null,
        effort: form.effort,
        tools: form.tools.trim() ? form.tools.trim() : null,
      },
      body: bodyChanged ? form.body : null,
      baseHash: editing ? detail!.hash : null,
    };
  };

  const preview = async () => {
    setTouched(true);
    if (!valid) return;
    const action = buildAction();
    setBusy(true);
    setPlanErr(null);
    setConflict(null);
    try {
      const p = await api.plan([action]);
      if (editing && isConflictPlan(p)) {
        setConflict([...p.conflicts, ...p.errors].filter((x, i, arr) => arr.indexOf(x) === i).join('\n'));
        return;
      }
      setPlan({ plan: p, action });
    } catch (e) {
      setPlanErr(e instanceof ApiFailure ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (touched && !window.confirm('重新加载会丢掉你在这个表单里的修改，改用磁盘上的最新内容。继续吗？')) return;
    await load();
    setTouched(false);
  };

  const title = editing ? `编辑 agent：${def!.name}` : '新建 agent';
  const footer = (
    <>
      <span className="small muted">下一步会先显示差异，确认后才写入</span>
      <span className="spacer" />
      <button className="btn" onClick={onCancel}>
        取消
      </button>
      <button className="btn primary" onClick={preview} disabled={busy || (editing && !detail) || !!conflict}>
        {busy ? '正在生成计划…' : '预览修改…'}
      </button>
    </>
  );

  return (
    <>
      <Modal
        title={title}
        onCancel={onCancel}
        width={860}
        footer={footer}
        initialFocus="#ae-name"
        pinned={
          conflict ? (
            <div className="alert error" role="alert">
              <div className="alert-body">
                <div className="title">文件在你打开之后被其他程序修改过</div>
                <div className="small">为了不覆盖别人的修改，这次没有生成计划。重新加载会读取磁盘上的最新内容（你在表单里的修改会丢失）。</div>
                <div className="small mono dim" style={{ whiteSpace: 'pre-wrap' }}>
                  {conflict}
                </div>
              </div>
              <button className="btn sm" onClick={reload}>
                重新加载
              </button>
            </div>
          ) : planErr ? (
            <div className="alert error" role="alert">
              <div className="alert-body">
                <div className="title">生成计划失败</div>
                <div className="small">{planErr}</div>
              </div>
            </div>
          ) : undefined
        }
      >
        {editing && !detail && !loadErr && <Loading text="读取定义文件" />}
        {loadErr && (
          <div className="alert error">
            <div className="alert-body">
              读取失败：{loadErr}
              <div>
                <button className="btn sm" onClick={() => void load()} style={{ marginTop: 6 }}>
                  重试
                </button>
              </div>
            </div>
          </div>
        )}
        {(!editing || detail) && (
          <div className="form-grid">
            <label htmlFor="ae-name">名字</label>
            <div>
              <input
                id="ae-name"
                className={`input mono ${touched && nameError ? 'invalid' : ''}`}
                style={{ width: '100%', maxWidth: 360 }}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="如 explorer"
                spellCheck={false}
                aria-invalid={!!(touched && nameError)}
                aria-describedby="ae-name-help"
              />
              <div id="ae-name-help">
                {touched && nameError ? (
                  <div className="field-err">{nameError}</div>
                ) : (
                  <div className="field-hint">
                    {editing && detail && name !== detail.name
                      ? `改名：文件会从 ${detail.name}.md 改为 ${name}.md，旧文件进备份`
                      : '文件名和 frontmatter 的 name 保持一致'}
                  </div>
                )}
              </div>
            </div>

            <label htmlFor="ae-scope">范围</label>
            <div className="row wrap" style={{ gap: 8 }}>
              <select
                id="ae-scope"
                className="select"
                value={form.scope === 'user' ? '__user' : form.projectCwd}
                disabled={editing}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__user') set('scope', 'user');
                  else {
                    setForm((f) => ({ ...f, scope: 'project', projectCwd: v }));
                    setTouched(true);
                  }
                }}
                style={{ maxWidth: '100%' }}
              >
                <option value="__user">用户级（~/.claude/agents，所有项目可用）</option>
                {projects.length === 0 && (
                  <option value="__none" disabled>
                    （没有可选的项目：项目级 agent 只能建在索引里出现过的会话目录下）
                  </option>
                )}
                {projects.map((p) => (
                  <option key={p} value={p}>
                    项目：{p}
                  </option>
                ))}
              </select>
              {editing && <span className="small muted">范围不能修改；要换位置请新建后删除旧的</span>}
              {scopeError && <div className="field-err">{scopeError}</div>}
            </div>

            <label htmlFor="ae-desc" className="top">
              描述
            </label>
            <div>
              <textarea
                id="ae-desc"
                className="textarea"
                rows={2}
                style={{ minHeight: 52 }}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="这个 agent 负责什么、什么时候该派发它"
              />
              {touched && descError && <div className="field-err">{descError}</div>}
            </div>

            <label htmlFor="ae-model">模型</label>
            <ModelInput id="ae-model" value={form.model} onChange={(v) => set('model', v)} emptyLabel="不设置（用默认）" placeholder="如 claude-opus-5-5 或 inherit" />

            <label htmlFor="ae-effort">effort</label>
            <div>
              <EffortSelect id="ae-effort" value={form.effort} onChange={(v) => set('effort', v)} emptyLabel="不设置（用会话的）" />
            </div>

            <label htmlFor="ae-tools">工具</label>
            <div>
              <input
                id="ae-tools"
                className="input mono"
                style={{ width: '100%' }}
                value={form.tools}
                onChange={(e) => set('tools', e.target.value)}
                placeholder="Read, Grep, Glob（留空表示不限制，继承全部工具）"
                spellCheck={false}
              />
            </div>

            {detail && detail.otherFields.length > 0 && (
              <>
                <label className="top">其他字段</label>
                <div>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {detail.otherFields.map((f) => (
                      <span key={f} className="chip">
                        {f}
                      </span>
                    ))}
                  </div>
                  <div className="field-hint">agentree 不管理这些 frontmatter 字段，保存时会原样保留（包括顺序和注释）。要修改请直接编辑文件。</div>
                </div>
              </>
            )}

            <label htmlFor="ae-body" className="top">
              正文
            </label>
            <div>
              <textarea
                id="ae-body"
                className="textarea mono"
                rows={14}
                value={form.body}
                onChange={(e) => set('body', e.target.value)}
                placeholder={editing ? '' : '系统提示词。留空则使用内置模板正文（explorer、worker、researcher 有专门的模板）'}
                spellCheck={false}
              />
              <div className="field-hint">
                {editing
                  ? form.body !== detail?.body
                    ? '正文已修改，会写入文件'
                    : '正文没有修改，保存时保持原样'
                  : form.body.trim()
                    ? '使用你填写的正文'
                    : '留空：使用内置模板正文'}
              </div>
            </div>
            {detail && (
              <div className="span-all small dim mono" style={{ overflowWrap: 'anywhere' }}>
                {detail.filePath}
              </div>
            )}
          </div>
        )}
      </Modal>
      {plan && (
        <PlanDialog
          title={editing ? `保存 agent：${name}` : `新建 agent：${name}`}
          initialPlan={plan.plan}
          load={() => api.plan([plan.action])}
          onApplied={(r) => {
            if (r.applied.length > 0) appliedRef.current = true;
          }}
          onClose={() => {
            setPlan(null);
            if (appliedRef.current) onDone();
          }}
        />
      )}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentTemplateInfo, ClaudeMdRuleState, EffectItem, EffectReport, PlanNote } from '../../types';
import { relativeTime as formatRelative } from '../../lib/format';
import { CompactSelect, EffortSelect, ModelInput } from '../inputs';
import Modal from '../Modal';
import {
  canSpawn,
  extraTools,
  isBuiltin,
  itemState,
  itemsOf,
  needsWrite,
  KIND_LABEL,
  PROMPT_SKELETON,
  promptSummary,
  setSpawn,
  splitTools,
  STATE_LABEL,
  TOOL_GROUPS,
  TOOL_PRESETS,
  toolPresetOf,
  withTools,
  type BNode,
  type NodeIssue,
  type NodeState,
} from './model';

export type Section = 'basic' | 'when' | 'tools' | 'prompt' | 'effect';

interface Props {
  node: BNode;
  color: string;
  isLinked: boolean;
  issues: NodeIssue[];
  state: NodeState;
  report: EffectReport | null;
  /** 磁盘上是否已有同名的定义文件 */
  onDisk: boolean;
  templates: AgentTemplateInfo[];
  rule: ClaudeMdRuleState | null;
  ruleText: string | null;
  /** 打开时滚动到哪一节 */
  focus: Section | null;
  onPatch: (p: Partial<BNode>) => void;
  onRuleText: (t: string | null) => void;
  /** 用磁盘上的定义覆盖画布上的内容 */
  onPull: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** 搭建页右侧的编辑面板：选中节点后浮出来，完整地编辑这个节点 */
export default function Inspector(p: Props) {
  const { node: n, issues } = p;
  const boxRef = useRef<HTMLElement>(null);
  const [bigPrompt, setBigPrompt] = useState(false);

  // 从节点上的某一行点进来时，滚动到对应的那一节
  useEffect(() => {
    if (!p.focus) return;
    const el = boxRef.current?.querySelector<HTMLElement>(`[data-sec="${p.focus}"]`);
    if (!el) return;
    // 面板自己是滚动容器；标题栏固定在顶部，要把它的高度让出来。
    // 先聚焦再滚动：聚焦会打断正在进行的平滑滚动
    const box = boxRef.current!;
    el.querySelector<HTMLElement>('textarea, input, select')?.focus({ preventScroll: true });
    const id = requestAnimationFrame(() => {
      const head = box.querySelector<HTMLElement>('.insp-head')?.offsetHeight ?? 0;
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - head;
      box.scrollTo({ top: Math.max(0, top) });
    });
    return () => cancelAnimationFrame(id);
  }, [p.focus, n.id]);

  const issueOf = (f: NodeIssue['field']) => issues.find((i) => i.field === f) ?? null;
  const builtin = n.kind === 'agent' && isBuiltin(n.name);
  const title = n.kind === 'agent' ? n.name.trim() || '未命名的子 agent' : KIND_LABEL[n.kind];

  return (
    <aside className="inspector builder-insp" data-nopan ref={boxRef} style={{ ['--nc' as string]: p.color }} aria-label={`编辑 ${title}`}>
      <div className="insp-head">
        <div className="row" style={{ gap: 10 }}>
          <span className="kind-dot" />
          <h2 className="ellipsis" style={{ minWidth: 0 }}>
            {title}
          </h2>
          {p.state !== 'none' && <span className={`state-chip ${p.state}`}>{STATE_LABEL[p.state]}</span>}
          <span className="spacer" />
          <button className="btn icon sm ghost" onClick={p.onClose} title="关闭（Esc）" aria-label="关闭编辑面板">
            ✕
          </button>
        </div>
        {n.kind === 'agent' && (
          <div className="small muted" style={{ marginTop: 4 }}>
            {KIND_LABEL.agent}
            {builtin ? ' · 内置类型' : ''}
          </div>
        )}
      </div>

      <div className="insp-body" key={n.id}>
        {!p.isLinked && (
          <div className="insp-sec">
            <div className="alert warn" style={{ animation: 'none' }}>
              <div className="alert-body small">这个节点还没有连到主会话，只是草稿：保存和应用时都不会包含它。从节点左侧的接口拖一条线到主会话，就把它加进方案了。</div>
            </div>
          </div>
        )}

        {n.kind === 'agent' && (
          <>
            <div className="insp-sec" data-sec="basic">
              <h3>名字</h3>
              <input
                className={`input mono ${issueOf('name') ? 'invalid' : ''}`}
                style={{ width: '100%' }}
                value={n.name}
                placeholder="如 explorer"
                spellCheck={false}
                onChange={(e) => p.onPatch({ name: e.target.value })}
              />
              {issueOf('name') ? (
                <div className="field-err">{issueOf('name')!.text}</div>
              ) : builtin ? (
                <div className="field-hint">这是 Claude Code 内置的类型，没有定义文件。放在方案里只用来检查它实际用的模型，应用时会跳过。</div>
              ) : (
                <div className="field-hint">
                  主会话派发时用的就是这个名字。你也可以在对话里输入 <span className="mono">@agent-{n.name.trim() || '名字'}</span> 直接点名。
                </div>
              )}
            </div>

            {!builtin && (
              <div className="insp-sec" data-sec="when">
                <h3>什么时候用它</h3>
                <textarea
                  className={`textarea ${issueOf('description') ? 'invalid' : ''}`}
                  rows={4}
                  value={n.description}
                  placeholder="例如：只读地查找和阅读代码。需要弄清楚某段逻辑在哪里、是怎么实现的时候使用。"
                  onChange={(e) => p.onPatch({ description: e.target.value })}
                />
                {issueOf('description') ? (
                  <div className="field-err">{issueOf('description')!.text}</div>
                ) : (
                  <div className="field-hint">主会话只看这段话来决定要不要把任务交给它。写清楚它做什么、什么情况下该用。想让主会话更主动地用它，可以加一句“主动使用”。</div>
                )}
              </div>
            )}

            <div className="insp-sec" data-sec="model">
              <h3>模型</h3>
              <div className="field-grid">
                <label htmlFor="bi-model">模型</label>
                <ModelInput id="bi-model" value={n.model} onChange={(v) => p.onPatch({ model: v })} emptyLabel="不指定（跟主会话一样）" placeholder="如 claude-opus-5-5" />
                <label htmlFor="bi-effort">effort</label>
                <EffortSelect id="bi-effort" value={n.effort} onChange={(v) => p.onPatch({ effort: v })} emptyLabel="不指定（跟主会话一样）" />
              </div>
              <div className="field-hint" style={{ marginTop: 10 }}>
                主会话派发时如果另外指定了模型，以派发时指定的为准。会话页能看到每次派发实际用的是哪个。
              </div>
            </div>

            {!builtin && <ToolsSection node={n} onPatch={p.onPatch} />}

            {!builtin && (
              <div className="insp-sec" data-sec="prompt">
                <div className="row" style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>系统提示词</h3>
                  <span className="spacer" />
                  <span className="small dim">{promptSummary(n.prompt) ?? '还没写'}</span>
                </div>
                <textarea
                  className="textarea mono prompt-area"
                  rows={12}
                  value={n.prompt}
                  spellCheck={false}
                  placeholder="告诉它：它是谁、怎么干活、干完怎么汇报。"
                  onChange={(e) => p.onPatch({ prompt: e.target.value })}
                />
                {issueOf('prompt') && <div className="field-err warn">{issueOf('prompt')!.text}</div>}
                <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                  <button className="btn sm" onClick={() => setBigPrompt(true)}>
                    放大编辑
                  </button>
                  {!n.prompt.trim() && (
                    <button className="btn sm" onClick={() => p.onPatch({ prompt: PROMPT_SKELETON })}>
                      填入骨架
                    </button>
                  )}
                  {p.templates
                    .filter((t) => !n.prompt.trim() || t.name === n.name.trim())
                    .slice(0, 3)
                    .map((t) => (
                      <button
                        key={t.name}
                        className="btn sm"
                        title={`用“${t.label}”模板的内容替换描述、工具和提示词`}
                        onClick={() => {
                          if (n.prompt.trim() && !window.confirm(`用“${t.name}”模板替换现在的描述、工具和提示词？`)) return;
                          p.onPatch({
                            description: t.description,
                            tools: t.tools,
                            disallowedTools: t.disallowedTools,
                            prompt: t.prompt,
                          });
                        }}
                      >
                        用 {t.name} 模板
                      </button>
                    ))}
                </div>
                <div className="field-hint" style={{ marginTop: 10 }}>
                  子 agent 每次都从零开始：它看不到你和主会话之前聊了什么，只能看到这段提示词和主会话交给它的任务。干完后，主会话也只会收到它最后的汇报。
                </div>
              </div>
            )}
          </>
        )}

        {n.kind === 'main' && (
          <div className="insp-sec" data-sec="model">
            <h3>模型</h3>
            <div className="field-grid">
              <label htmlFor="bi-model">模型</label>
              <ModelInput id="bi-model" value={n.model} onChange={(v) => p.onPatch({ model: v })} emptyLabel="不指定" placeholder="如 claude-opus-5-5" />
              <label htmlFor="bi-effort">effort</label>
              <EffortSelect id="bi-effort" value={n.effort} onChange={(v) => p.onPatch({ effort: v })} emptyLabel="不指定" allowMax={false} />
            </div>
            <div className="field-hint" style={{ marginTop: 10 }}>
              “不指定”表示这一项你不管：agentree 不会写它，也不会检查它。
            </div>
            <MainHowTo report={p.report} />
          </div>
        )}

        {n.kind === 'main' && (
          <div className="insp-sec" data-sec="compact">
            <h3>自动压缩阈值</h3>
            <div className="field-grid">
              <label htmlFor="bi-compact">阈值</label>
              <CompactSelect id="bi-compact" value={n.autoCompactWindow} onChange={(v) => p.onPatch({ autoCompactWindow: v })} emptyLabel="不指定" />
            </div>
            {issueOf('compact') && <div className="field-err">{issueOf('compact')!.text}</div>}
            <div className="field-hint" style={{ marginTop: 10 }}>
              上下文累积到这么多 token 时，Claude Code 会自动把之前的对话压缩成摘要（写到 settings 的 <span className="mono">autoCompactWindow</span>）。
              不指定时用 Claude Code 的默认：1M 上下文的模型约 967K，200K 的模型 200K。设得再高也不会超过模型自己的上下文上限；设低一些可以让长会话更早瘦身，但会更早丢掉细节。
              环境变量 <span className="mono">CLAUDE_CODE_AUTO_COMPACT_WINDOW</span> 和 <span className="mono">DISABLE_AUTO_COMPACT</span> 会让这个设置失效，配置页的环境变量检查会列出来。
            </div>
          </div>
        )}

        {n.kind === 'advisor' && (
          <div className="insp-sec" data-sec="model">
            <h3>顾问模型</h3>
            <ModelInput value={n.model} onChange={(v) => p.onPatch({ model: v })} emptyLabel="还没选" placeholder="如 claude-fable-5-1" />
            {issueOf('model') && <div className="field-err">{issueOf('model')!.text}</div>}
            <div className="field-hint" style={{ marginTop: 10 }}>
              advisor 是一个更强的模型，主会话拿不准的时候向它请教。它不会自己动手，只给建议。要不要请教、什么时候请教，由主会话自己决定；加上“CLAUDE.md 规则”节点可以明确告诉主会话该在哪些时刻请教。
            </div>
          </div>
        )}

        {n.kind === 'rule' && <RuleSection rule={p.rule} text={p.ruleText} onText={p.onRuleText} />}

        {p.isLinked && (
          <div className="insp-sec" data-sec="effect">
            <h3>生效了吗</h3>
            <EffectList items={itemsOf(n, p.report)} loading={!p.report} invalid={issues.some((i) => i.level === 'error')} onPull={n.kind === 'agent' && p.onDisk ? p.onPull : undefined} />
          </div>
        )}

        {n.kind !== 'main' && (
          <div className="insp-sec">
            <button className="btn sm danger" onClick={p.onRemove}>
              从画布上删除这个节点
            </button>
            {n.kind === 'agent' && p.onDisk && (
              <div className="field-hint">
                只是从画布上拿掉。Claude Code 里已有的定义文件不会被删除，要删除请到 <Link to="/config">配置页</Link>。
              </div>
            )}
          </div>
        )}
      </div>

      {bigPrompt && (
        <Modal
          title={`${title} 的系统提示词`}
          onCancel={() => setBigPrompt(false)}
          width={980}
          initialFocus="#bi-prompt-big"
          footer={
            <>
              <span className="small muted">{promptSummary(n.prompt) ?? '还没写'} · 修改会直接反映到画布上，应用之后才写入 Claude Code</span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setBigPrompt(false)}>
                完成
              </button>
            </>
          }
        >
          <textarea
            id="bi-prompt-big"
            className="textarea mono"
            style={{ minHeight: '58vh', resize: 'none' }}
            value={n.prompt}
            spellCheck={false}
            onChange={(e) => p.onPatch({ prompt: e.target.value })}
          />
        </Modal>
      )}
    </aside>
  );
}

function ToolsSection({ node: n, onPatch }: { node: BNode; onPatch: (p: Partial<BNode>) => void }) {
  const preset = toolPresetOf(n.tools);
  // 选了"自己选"之后，即使勾选结果恰好等于某个预置，也保持展开
  const [custom, setCustom] = useState(preset === 'custom');
  useEffect(() => {
    if (preset === 'custom') setCustom(true);
  }, [preset]);
  const active = custom && n.tools !== null ? 'custom' : preset;
  const list = splitTools(n.tools);
  const extras = extraTools(n.tools);
  const spawn = canSpawn(n);

  const toggle = (name: string) => {
    const has = list.includes(name);
    const next = has ? list.filter((t) => t !== name) : [...list, name];
    onPatch(
      withTools(
        n,
        next.filter((t) => !/^(Agent|Task)(\(.*\))?$/.test(t)),
      ),
    );
  };

  return (
    <div className="insp-sec" data-sec="tools">
      <h3>它能用哪些工具</h3>
      <div className="tool-presets" role="radiogroup" aria-label="工具范围">
        {TOOL_PRESETS.map((tp) => (
          <button
            key={tp.id}
            role="radio"
            aria-checked={active === tp.id}
            className={active === tp.id ? 'on' : ''}
            title={tp.hint}
            onClick={() => {
              if (tp.id === 'custom') {
                setCustom(true);
                // 从"全部"切过来时，先勾上最常用的几个，避免一个都没有
                if (n.tools === null) onPatch(withTools(n, ['Read', 'Grep', 'Glob']));
              } else {
                setCustom(false);
                onPatch(withTools(n, tp.tools));
              }
            }}
          >
            {tp.label}
          </button>
        ))}
      </div>
      <div className="field-hint">{TOOL_PRESETS.find((t) => t.id === active)!.hint}</div>

      {active === 'custom' && (
        <div className="tool-grid">
          {TOOL_GROUPS.map((g) => (
            <div key={g.id} className="tool-group">
              <span className="tool-group-label">{g.label}</span>
              <div className="tool-items">
                {g.tools.map((t) => (
                  <label key={t.name} className={`tool-item ${list.includes(t.name) ? 'on' : ''}`} title={t.name}>
                    <input type="checkbox" checked={list.includes(t.name)} onChange={() => toggle(t.name)} />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="tool-group">
            <span className="tool-group-label">另外</span>
            <input
              className="input mono"
              style={{ width: '100%', height: 28, fontSize: 12 }}
              defaultValue={extras.join(', ')}
              key={extras.join(',')}
              placeholder="其他工具名，逗号分隔，如 mcp__github"
              spellCheck={false}
              onBlur={(e) => {
                const known = list.filter((t) => !extras.includes(t) && !/^(Agent|Task)(\(.*\))?$/.test(t));
                onPatch(withTools(n, [...known, ...splitTools(e.target.value)]));
              }}
            />
          </div>
        </div>
      )}

      <label className="switch" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={spawn} onChange={(e) => onPatch(setSpawn(n, e.target.checked))} />
        允许它再派发子 agent
      </label>
      <div className="field-hint">{spawn ? '它可以把任务再分给别的子 agent（最多往下三层）。它能派发哪些类型无法单独限制。' : '它只能自己干活，不能再往下分派。这样用量更容易控制。'}</div>
    </div>
  );
}

function RuleSection({ rule, text, onText }: { rule: ClaudeMdRuleState | null; text: string | null; onText: (t: string | null) => void }) {
  const current = text ?? rule?.text ?? rule?.defaultText ?? '';
  return (
    <div className="insp-sec" data-sec="prompt">
      <h3>规则内容</h3>
      {rule?.error && (
        <div className="alert error" style={{ animation: 'none', marginBottom: 10 }}>
          <div className="alert-body small">CLAUDE.md 里的规则标记有问题，agentree 不会修改它：{rule.error}</div>
        </div>
      )}
      <textarea className="textarea prompt-area" rows={9} value={current} onChange={(e) => onText(e.target.value)} disabled={!rule} />
      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
        {rule && current !== rule.defaultText && (
          <button className="btn sm" onClick={() => onText(rule.defaultText)}>
            恢复默认文案
          </button>
        )}
      </div>
      <div className="field-hint" style={{ marginTop: 10 }}>
        这段话会写进 CLAUDE.md。Claude Code 每次开始会话都会读 CLAUDE.md，所以主会话会照着它做。agentree 只管理自己加的这一段，文件里的其他内容不动。
      </div>
    </div>
  );
}

/** 主会话的模型在命令行和桌面版里的设置方式不一样，这里说清楚 */
function MainHowTo({ report }: { report: EffectReport | null }) {
  const desktop = report?.items.some((i) => (i.kind === 'main-model' || i.kind === 'main-effort') && i.writeEffective === false) ?? false;
  return (
    <div className={`howto ${desktop ? 'desktop' : ''}`}>
      <div className="howto-row">
        <b>桌面版</b>
        <span>
          不读配置文件里的模型和 effort。每个会话用的是发送框旁边选择器里选的值，你需要自己在那里选。
          {desktop && <em>你最近的会话都是从桌面版启动的。</em>}
        </span>
      </div>
      <div className="howto-row">
        <b>命令行</b>
        <span>
          新开的会话用配置文件里的值，应用之后就生效。启动参数和 <span className="mono">/model</span> 可以临时改。
        </span>
      </div>
      <div className="howto-row">
        <b>检查</b>
        <span>不管哪种方式，每个会话实际用的模型都有记录。下面会告诉你是不是和方案一致。</span>
      </div>
    </div>
  );
}

const W_LABEL: Record<EffectItem['written']['state'], string> = {
  yes: '已写入',
  no: '还没写入',
  differs: '和画布不一样',
  extra: '配置里多出来的',
  'n/a': '不需要写入',
};
const O_LABEL: Record<EffectItem['observed']['state'], string> = {
  match: '用上了，符合',
  mismatch: '用上了，但不符合',
  'not-seen': '还没出现过',
  'n/a': '无法判断',
};
/** 主模型和 effort 看的是最近的会话，说法和子 agent 不一样 */
const O_MAIN_LABEL: Record<EffectItem['observed']['state'], string> = { match: '最近的会话符合', mismatch: '最近的会话不符合', 'not-seen': '还没有新会话', 'n/a': '无法判断' };
/** 自动压缩阈值看的是会话在多少 token 时自动压缩 */
const O_COMPACT_LABEL: Record<EffectItem['observed']['state'], string> = { match: '有会话在阈值附近压缩过', mismatch: '有会话超过阈值才压缩', 'not-seen': '还没有会话达到阈值', 'n/a': '无法判断' };
const FIELD_LABEL: Record<string, string> = {
  model: '模型',
  effort: 'effort',
  description: '什么时候用',
  tools: '工具',
  disallowedTools: '禁用的工具',
  prompt: '系统提示词',
  name: '名字',
  text: '规则内容',
};
const ITEM_LABEL: Record<EffectItem['kind'], string> = {
  'main-model': '主模型',
  'main-effort': '主会话 effort',
  'main-compact': '自动压缩阈值',
  advisor: 'advisor',
  rule: 'CLAUDE.md 规则',
  agent: '定义文件',
};

const L_LABEL: Record<EffectItem['loaded']['state'], string> = {
  yes: '已加载',
  no: '之后的会话都没有加载它',
  unknown: '还没有新会话',
  'n/a': '',
};

function stepClass(kind: 'w' | 'l' | 'o', it: EffectItem): string {
  if (kind === 'w') {
    if (it.writeEffective === false) return 'na';
    const s = it.written.state;
    return s === 'yes' ? 'ok' : s === 'n/a' ? 'na' : 'todo';
  }
  if (kind === 'l') {
    const s = it.loaded?.state;
    return s === 'yes' ? 'ok' : s === 'no' ? 'bad' : 'wait';
  }
  const s = it.observed.state;
  return s === 'match' ? 'ok' : s === 'mismatch' ? 'bad' : s === 'n/a' ? 'na' : 'wait';
}

export function EffectList({ items, loading, invalid, onPull, showTitle = true }: { items: EffectItem[]; loading: boolean; invalid?: boolean; onPull?: () => void; showTitle?: boolean }) {
  if (invalid) return <div className="small muted">这个节点还没填完，填完后才能检查。</div>;
  if (loading) return <div className="small muted">正在检查…</div>;
  if (!items.length) return <div className="small muted">这一项没有需要检查的内容。</div>;
  return (
    <div className="effect-list">
      {items.map((it) => (
        <div key={it.key} className={`effect-item ${itemState(it)}`}>
          {showTitle && (
            <div className="effect-title">
              <b>{it.kind === 'agent' ? it.name : ITEM_LABEL[it.kind]}</b>
              {it.expected && <span className="mono dim">{it.expected}</span>}
            </div>
          )}
          <div className="effect-steps">
            <div className={`effect-step ${stepClass('w', it)}`}>
              <i />
              <div>
                <div className="k">写入配置</div>
                <div className="v">
                  {W_LABEL[it.written.state]}
                  {it.written.state !== 'yes' && it.written.actual && <span className="dim">（现在是 {it.written.actual}）</span>}
                </div>
                {it.writeEffective === false && <div className="d">对桌面版没有用，只对命令行启动的会话有效</div>}
                {it.written.diffs.length > 0 && (
                  <div className="d">
                    不一样的地方：
                    {it.written.diffs.map((f) => FIELD_LABEL[f] ?? f).join('、')}
                  </div>
                )}
              </div>
            </div>
            {it.loaded && it.loaded.state !== 'n/a' && (
              <div className={`effect-step ${stepClass('l', it)}`}>
                <i />
                <div>
                  <div className="k">新会话加载</div>
                  <div className="v">
                    {it.written.state === 'yes' || it.loaded.state === 'yes' ? L_LABEL[it.loaded.state] : '写入之后才会加载'}
                    {it.loaded.count > 0 && <span className="dim">（{it.loaded.count} 个会话）</span>}
                  </div>
                </div>
              </div>
            )}
            <div className={`effect-step ${stepClass('o', it)}`}>
              <i />
              <div>
                <div className="k">实际运行</div>
                <div className="v">
                  {(it.kind === 'main-model' || it.kind === 'main-effort' ? O_MAIN_LABEL : it.kind === 'main-compact' ? O_COMPACT_LABEL : O_LABEL)[it.observed.state]}
                  {it.observed.count > 0 && (
                    <span className="dim">
                      （
                      {it.kind === 'advisor'
                        ? `被调用 ${it.observed.count} 次`
                        : it.kind === 'agent'
                          ? `${it.observed.count} 次里 ${it.observed.matched} 次符合`
                          : it.kind === 'main-compact'
                            ? `${it.observed.count} 个会话自动压缩过，${it.observed.matched} 个在阈值附近`
                            : `${it.observed.count} 个会话里 ${it.observed.matched} 个符合`}
                      ）
                    </span>
                  )}
                </div>
                {it.observed.actual.length > 0 && it.observed.state !== 'match' && (
                  <div className="d">
                    {it.kind === 'main-compact' ? '压缩前的上下文：' : '实际用的是：'}
                    {it.observed.actual.join('、')}
                    {it.kind === 'main-compact' ? ' token' : ''}
                  </div>
                )}
                {it.observed.lastSessionId && (
                  <div className="d">
                    最近一次 {formatRelative(it.observed.lastSeenAt)} · <Link to={`/sessions/${encodeURIComponent(it.observed.lastSessionId)}`}>看那个会话</Link>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="effect-summary">{it.summary}</div>
          {it.nextStep && <div className="effect-next">下一步：{it.nextStep}</div>}
          {it.kind === 'agent' && it.written.state === 'differs' && onPull && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={onPull} title="放弃画布上对这个 agent 的修改，改用配置文件里现在的内容">
              改用配置文件里的内容
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** 整个方案的生效检查，没有选中节点时显示在右侧 */
export function EffectPanel({ report, blockers, onClose, onApply, canApply }: { report: EffectReport | null; blockers: PlanNote[]; onClose: () => void; onApply: () => void; canApply: boolean }) {
  const items = report?.items ?? [];
  const shown = items.filter((i) => i.written.state !== 'n/a' || i.observed.state === 'match' || i.observed.state === 'mismatch');
  const states = items.map(itemState);
  const pending = states.filter((s) => s === 'pending').length;
  const live = states.filter((s) => s === 'live').length;
  const off = states.filter((s) => s === 'off').length;
  const waiting = states.filter((s) => s === 'written' || s === 'loaded' || s === 'manual').length;
  const writable = items.filter(needsWrite).length;
  return (
    <aside className="inspector builder-insp" data-nopan aria-label="生效检查">
      <div className="insp-head">
        <div className="row" style={{ gap: 10 }}>
          <h2>生效检查</h2>
          <span className="spacer" />
          <button className="btn icon sm ghost" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {report?.since ? `统计 ${formatRelative(report.since)} 以来的运行 · 之后新开了 ${report.sessionsSince} 个会话` : '还没有应用过，统计的是全部历史'}
        </div>
      </div>
      <div className="insp-body">
        <div className="insp-sec">
          <div className="effect-flow">
            <div className={pending ? 'todo' : 'ok'}>
              <b>{pending ? pending : '✓'}</b>
              <span>{pending ? '项还没写入' : '全部已写入'}</span>
            </div>
            <div className={waiting ? 'wait' : 'ok'}>
              <b>{waiting}</b>
              <span>项等待验证</span>
            </div>
            <div className={off ? 'bad' : 'ok'}>
              <b>{off ? off : live}</b>
              <span>{off ? '项不符合' : '项已生效'}</span>
            </div>
          </div>
          {writable > 0 && (
            <button className={`btn ${pending > 0 ? 'primary' : ''}`} style={{ width: '100%', marginTop: 12 }} disabled={!canApply} onClick={onApply}>
              应用到 Claude Code…
            </button>
          )}
          {pending === 0 && waiting > 0 && (
            <div className="field-hint" style={{ marginTop: 12 }}>
              配置已经写好了。新开一个会话正常使用，agentree 会自动读取日志，这里的状态会跟着更新。
            </div>
          )}
        </div>
        {blockers.length > 0 && (
          <div className="insp-sec">
            <h3>会影响生效的外部因素</h3>
            {blockers.map((b, i) => (
              <div key={i} className={`alert ${b.level === 'fail' ? 'error' : b.level === 'warn' ? 'warn' : 'info'}`} style={{ animation: 'none', marginBottom: 8, fontSize: 12.5 }}>
                <div className="alert-body">{b.message}</div>
              </div>
            ))}
          </div>
        )}
        <div className="insp-sec">
          <h3>逐项</h3>
          <EffectList items={shown} loading={!report} />
        </div>
      </div>
    </aside>
  );
}

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentNode, AgentStatus } from '../../types';
import { Flash, Seg, StatusDot, Tok, VerdictMark, STATUS_LABEL } from '../ui';
import { fullNumber, shortDuration } from '../../lib/format';
import { modelColor, shortModel } from '../../lib/models';
import { useTheme } from '../../lib/theme';
import { prefersReducedMotion, useFirstPaint } from '../../lib/motion';
import { noodle, noodleV, useCanvasView, useNodeDrag, type Pt } from '../canvas/useCanvasView';
import { ancestors, hasWarn, nodeLabel, usageOf, type TreeIndex, type UsageMode } from './treeModel';

/** h：从左到右展开；v：从上到下展开 */
export type Orientation = 'h' | 'v';

export const NODE_W = 276;
export const NODE_H = 78;
/** 标题栏高度，接口画在标题栏的中线上 */
const HEAD_H = 28;
const ADV_H = 34;
const GAP = {
  h: { level: 92, sibling: 12 },
  v: { level: 60, sibling: 18 },
};

interface Layout {
  pos: Map<string, Pt>;
  order: string[];
  advisor: Pt | null;
}

/**
 * 整齐的树布局：叶子节点沿"兄弟方向"依次排开，父节点放在第一个和最后一个子节点的正中。
 * 两个方向共用一套算法，只是把"层级方向"和"兄弟方向"映射到不同的坐标轴。
 */
function layoutTree(index: TreeIndex, collapsed: Set<string>, orient: Orientation): Layout | null {
  const root = index.root;
  if (!root) return null;
  const size = orient === 'h' ? { level: NODE_W, sibling: NODE_H } : { level: NODE_H, sibling: NODE_W };
  const gap = GAP[orient];
  const raw = new Map<string, { level: number; sibling: number }>();
  const order: string[] = [];
  const guard = new Set<string>();

  function lay(id: string, depth: number, start: number): { span: number; center: number } {
    guard.add(id);
    order.push(id);
    const kids = collapsed.has(id) ? [] : (index.kids.get(id) ?? []).filter((k) => !guard.has(k));
    const level = depth * (size.level + gap.level);
    if (!kids.length) {
      raw.set(id, { level, sibling: start });
      return { span: size.sibling, center: start + size.sibling / 2 };
    }
    let cursor = start;
    let first = 0;
    let last = 0;
    kids.forEach((k, i) => {
      const r = lay(k, depth + 1, cursor);
      if (i === 0) first = r.center;
      last = r.center;
      cursor += r.span + gap.sibling;
    });
    const span = cursor - gap.sibling - start;
    const center = (first + last) / 2;
    raw.set(id, { level, sibling: center - size.sibling / 2 });
    return { span: Math.max(span, size.sibling), center };
  }
  lay(root.id, 0, 0);

  const pos = new Map<string, Pt>();
  for (const [id, r] of raw) pos.set(id, orient === 'h' ? { x: Math.round(r.level), y: Math.round(r.sibling) } : { x: Math.round(r.sibling), y: Math.round(r.level) });

  // advisor 标签：横向时放在主会话下方，纵向时放在主会话右侧，这两个位置都不会和子节点重叠
  const rp = pos.get(root.id)!;
  const advisor = root.advisorModel ? (orient === 'h' ? { x: rp.x, y: rp.y + NODE_H + 16 } : { x: rp.x + NODE_W + 24, y: rp.y + (NODE_H - ADV_H) / 2 }) : null;
  return { pos, order, advisor };
}

/**
 * 定位层：节点从父节点的位置"长"出来，之后布局变化时平滑移动到新位置。
 * 页面在后台时浏览器不触发动画帧，所以用定时器兜底，保证节点一定会显示出来。
 */
export function Positioned({
  at,
  from,
  w,
  h,
  delay,
  moving,
  onPointerDown,
  children,
}: {
  at: Pt;
  from: Pt;
  w: number;
  /** 不传表示高度由内容决定 */
  h?: number;
  delay: number;
  moving?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  children: React.ReactNode;
}) {
  const [entered, setEntered] = useState(() => prefersReducedMotion() || document.hidden);
  const [settled, setSettled] = useState(entered);

  useEffect(() => {
    if (entered) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    const guard = window.setTimeout(() => setEntered(true), 160);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(guard);
    };
  }, [entered]);

  useEffect(() => {
    if (!entered || settled) return;
    const id = window.setTimeout(() => setSettled(true), delay + 460);
    return () => window.clearTimeout(id);
  }, [entered, settled, delay]);

  const p = entered ? at : from;
  return (
    <div
      className={`tpos ${entered ? '' : 'entering'} ${moving ? 'moving' : ''}`}
      style={{ transform: `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`, width: w, height: h, ['--d' as string]: settled ? '0ms' : `${delay}ms` }}
      onPointerDown={onPointerDown}
      data-nopan
    >
      {children}
    </div>
  );
}

interface NodeCardProps {
  node: AgentNode;
  selected: boolean;
  usageMode: UsageMode;
  orientation: Orientation;
  descendants: number;
  runningBelow: number;
  folded: boolean;
  hasParent: boolean;
  title: string | null;
  /** token 占全树最大值的比例，0 到 1 */
  share: number;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

const STATUS_TEXT: Record<AgentStatus, string> = { running: '运行', completed: '', failed: '失败', stopped: '已中止', unknown: '' };

const NodeCard = memo(function NodeCard(p: NodeCardProps) {
  const { node } = p;
  const { theme } = useTheme();
  const u = usageOf(node, p.usageMode);
  const desc = node.kind === 'main' ? p.title ?? '（无标题）' : node.description ?? '（无任务描述）';
  const scope = p.usageMode === 'own' ? '自己的' : '含后代的';
  const efforts = node.efforts.join('→');
  return (
    <div
      className={`node ${node.kind} ${node.status} ${p.orientation} ${p.selected ? 'selected' : ''}`}
      style={{ ['--mc' as string]: modelColor(node.primaryModel, theme) }}
      onClick={() => p.onSelect(node.id)}
      onKeyDown={(e) => {
        // 只处理焦点在卡片本身时的按键，卡片里的折叠按钮自己处理
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          p.onSelect(node.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      data-node={node.id}
    >
      {p.hasParent && <span className="socket in" aria-hidden="true" />}
      {p.descendants > 0 && <span className={`socket out ${p.folded ? 'folded' : ''}`} aria-hidden="true" />}
      <div className="node-head">
        <StatusDot status={node.status} />
        <span className="node-type" title={node.agentType ?? '主会话'}>
          {nodeLabel(node)}
        </span>
        {node.background && (
          <span className="node-tag" title="后台运行">
            后台
          </span>
        )}
        <span className="spacer" />
        <VerdictMark verdict={node.conformance.verdict} hasWarn={hasWarn(node)} />
        {p.descendants > 0 && (
          <button
            className={`fold ${p.folded ? 'folded' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              p.onToggle(node.id);
            }}
            title={p.folded ? `展开 ${p.descendants} 个后代` : `折叠 ${p.descendants} 个后代`}
            aria-expanded={!p.folded}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" />
            </svg>
            {p.descendants}
            {p.folded && p.runningBelow > 0 && <span style={{ color: 'var(--running)' }}>●</span>}
          </button>
        )}
      </div>
      <div className="node-body">
        <span className="fill-bar" style={{ width: `${Math.max(p.share > 0 ? 3 : 0, p.share * 100)}%` }} aria-hidden="true" />
        <div className="node-desc" title={desc}>
          {desc}
        </div>
        <div className="node-meta">
          <span className="m" title={node.models.length > 1 ? node.models.map((m) => m.model).join('\n') : node.primaryModel ?? ''}>
            {shortModel(node.primaryModel)}
            {node.models.length > 1 && ` +${node.models.length - 1}`}
          </span>
          {efforts && <span title={`effort：${efforts}`}>{efforts}</span>}
          <span className="spacer" />
          <Flash value={u.requests}>
            <b title={`${scope}请求次数`}>{fullNumber(u.requests)}</b>次
          </Flash>
          <Flash value={u.tokens.total}>
            <b>
              <Tok n={u.tokens.total} />
            </b>
          </Flash>
          {STATUS_TEXT[node.status] ? (
            <span style={{ color: `var(--${node.status === 'failed' ? 'fail' : node.status})` }} title={STATUS_LABEL[node.status]}>
              {STATUS_TEXT[node.status]} {shortDuration(node.durationMs)}
            </span>
          ) : (
            node.status === 'completed' && <span title="耗时">{shortDuration(node.durationMs)}</span>
          )}
        </div>
      </div>
    </div>
  );
});

export interface TreeCanvasProps {
  sessionId: string;
  index: TreeIndex;
  collapsed: Set<string>;
  selectedId: string | null;
  usageMode: UsageMode;
  setUsageMode: (m: UsageMode) => void;
  orientation: Orientation;
  setOrientation: (o: Orientation) => void;
  sessionTitle: string | null;
  counts: Record<AgentStatus, number>;
  onSelect: (id: string) => void;
  /** 点了画布空白处：取消选中 */
  onDeselect: () => void;
  onToggle: (id: string) => void;
  onExpandAll: () => void;
  onFirstLevelOnly: () => void;
}

type Moved = Record<string, Pt>;

function loadMoved(key: string): Moved {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Moved;
  } catch {
    /* 忽略 */
  }
  return {};
}

export default function TreeCanvas(p: TreeCanvasProps) {
  const cv = useCanvasView();
  const firstPaint = useFirstPaint(900);
  const layout = useMemo(() => layoutTree(p.index, p.collapsed, p.orientation), [p.index, p.collapsed, p.orientation]);

  // 用户手动拖动过的节点位置，按会话和排列方向分别记住
  const movedKey = `agentree.pos.${p.sessionId}.${p.orientation}`;
  const [moved, setMoved] = useState<Moved>(() => loadMoved(movedKey));
  useEffect(() => setMoved(loadMoved(movedKey)), [movedKey]);
  useEffect(() => {
    try {
      if (Object.keys(moved).length) sessionStorage.setItem(movedKey, JSON.stringify(moved));
      else sessionStorage.removeItem(movedKey);
    } catch {
      /* 忽略 */
    }
  }, [moved, movedKey]);

  const posOf = useCallback((id: string): Pt | null => moved[id] ?? layout?.pos.get(id) ?? null, [moved, layout]);

  const drag = useNodeDrag({
    getScale: () => cv.viewRef.current.k,
    onMove: (id, pos) => setMoved((m) => ({ ...m, [id]: pos })),
    suppressClick: cv.suppressClick,
  });

  const bounds = useCallback(() => {
    if (!layout) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of layout.order) {
      const q = posOf(id);
      if (!q) continue;
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x + NODE_W);
      maxY = Math.max(maxY, q.y + NODE_H);
    }
    const adv = advisorPos();
    if (adv) {
      minX = Math.min(minX, adv.x);
      minY = Math.min(minY, adv.y);
      maxX = Math.max(maxX, adv.x + NODE_W);
      maxY = Math.max(maxY, adv.y + ADV_H);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, posOf]);

  /** advisor 标签跟着主会话节点走 */
  function advisorPos(): Pt | null {
    if (!layout?.advisor || !p.index.root) return null;
    const base = layout.pos.get(p.index.root.id);
    const cur = posOf(p.index.root.id);
    if (!base || !cur) return layout.advisor;
    return { x: layout.advisor.x + (cur.x - base.x), y: layout.advisor.y + (cur.y - base.y) };
  }

  /** 把整棵树缩放到窗口里 */
  const fit = useCallback(() => {
    const b = bounds();
    if (b) cv.fit(b);
  }, [bounds, cv]);

  /**
   * 打开时的视图：能在看得清的比例下放下整棵树就居中显示；
   * 放不下就保持看得清的比例，把主会话放在起始位置，其余靠拖动查看。
   * 缩得太小字看不清，不如只显示一部分。
   */
  const initialView = useCallback(() => {
    const READABLE = 0.72;
    const el = cv.boxRef.current;
    const b = bounds();
    const r = p.index.root ? posOf(p.index.root.id) : null;
    if (!el || !b || !r) return;
    const k = Math.min(1, (el.clientWidth - 96) / b.w, (el.clientHeight - 148) / b.h);
    if (k >= READABLE) {
      cv.fit(b);
      return;
    }
    cv.setView(
      p.orientation === 'h'
        ? { k: READABLE, x: Math.round(40 - r.x * READABLE), y: Math.round(el.clientHeight / 2 - (r.y + NODE_H / 2) * READABLE) }
        : { k: READABLE, x: Math.round(el.clientWidth / 2 - (r.x + NODE_W / 2) * READABLE), y: Math.round(76 - r.y * READABLE) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, cv.fit, cv.setView, p.orientation, p.index.root, posOf]);

  // 首次量出窗口大小、切换方向、点了"全部展开"等按钮后，自动适应一次。轮询刷新不会触发
  const [fitTick, setFitTick] = useState(0);
  const fitKey = `${p.orientation}|${cv.size ? 1 : 0}|${fitTick}`;
  const lastFit = useRef('');
  useLayoutEffect(() => {
    if (!cv.size || !layout || lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    initialView();
  }, [fitKey, cv.size, layout, initialView]);

  // 从别处选中节点（明细表、检查器里的链接）时，节点不在视野里就移过去
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    const el = cv.boxRef.current;
    if (!el || !p.selectedId || lastSel.current === p.selectedId) return;
    const first = lastSel.current === null;
    lastSel.current = p.selectedId;
    if (first) return;
    const q = posOf(p.selectedId);
    if (!q) return;
    const v = cv.viewRef.current;
    const left = q.x * v.k + v.x;
    const top = q.y * v.k + v.y;
    if (left < 16 || top < 64 || left + NODE_W * v.k > el.clientWidth - 16 || top + NODE_H * v.k > el.clientHeight - 64) {
      cv.centerOn({ x: q.x + NODE_W / 2, y: q.y + NODE_H / 2 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectedId]);

  const meta = useMemo(() => {
    const parentOf = new Map<string, string>();
    const order = new Map<string, number>();
    for (const [pid, list] of p.index.kids) {
      list.forEach((k, i) => {
        parentOf.set(k, pid);
        order.set(k, i);
      });
    }
    let max = 0;
    for (const n of p.index.byId.values()) max = Math.max(max, usageOf(n, p.usageMode).tokens.total);
    return { parentOf, order, max };
  }, [p.index, p.usageMode]);

  const onPath = useMemo(() => {
    const s = new Set<string>();
    if (p.selectedId) {
      s.add(p.selectedId);
      ancestors(p.index, p.selectedId).forEach((a) => s.add(a));
    }
    return s;
  }, [p.index, p.selectedId]);

  const { theme } = useTheme();
  const root = p.index.root;
  if (!layout || !root) return null;
  const rootPos = posOf(root.id)!;
  const adv = advisorPos();
  const hasMoved = Object.keys(moved).length > 0;

  const delayOf = (id: string): number => {
    const node = p.index.byId.get(id);
    if (!node || node.kind === 'main') return 0;
    const i = Math.min(meta.order.get(id) ?? 0, 10);
    return firstPaint ? node.depth * 90 + i * 26 : i * 26;
  };

  const visible = new Set(layout.order);
  const edges: Array<{ id: string; d: string }> = [];
  for (const id of layout.order) {
    if (p.collapsed.has(id)) continue;
    const a = posOf(id);
    if (!a) continue;
    for (const k of p.index.kids.get(id) ?? []) {
      const b = visible.has(k) ? posOf(k) : null;
      if (!b) continue;
      edges.push({
        id: k,
        d:
          p.orientation === 'h'
            ? noodle({ x: a.x + NODE_W, y: a.y + HEAD_H / 2 }, { x: b.x, y: b.y + HEAD_H / 2 })
            : noodleV({ x: a.x + NODE_W / 2, y: a.y + NODE_H }, { x: b.x + NODE_W / 2, y: b.y }),
      });
    }
  }
  const advisorLine = adv
    ? p.orientation === 'h'
      ? `M${rootPos.x + 30},${rootPos.y + NODE_H} V${adv.y}`
      : `M${rootPos.x + NODE_W},${rootPos.y + NODE_H / 2} H${adv.x}`
    : null;
  const zero = root.advisorCalls === 0;
  const busy = cv.panning || drag.movingId !== null;

  return (
    <div
      ref={cv.boxRef}
      className={`canvas ${cv.panning ? 'dragging' : ''} ${cv.wheeling ? 'wheeling' : ''} ${drag.movingId ? 'node-moving' : ''}`}
      {...cv.handlers}
      onClick={(e) => {
        // 点在空白处（不是节点，也不是工具条）：取消选中
        if (!(e.target as HTMLElement).closest('[data-nopan]')) p.onDeselect();
      }}
    >
      <div className="canvas-tools tl" data-nopan>
        <Seg
          label="排列方向"
          value={p.orientation}
          onChange={p.setOrientation}
          options={[
            { value: 'h', label: '横向', title: '从左到右展开，子节点多时更容易看全' },
            { value: 'v', label: '纵向', title: '从上到下展开' },
          ]}
        />
        <span className="sep" />
        <Seg
          label="用量口径"
          value={p.usageMode}
          onChange={p.setUsageMode}
          options={[
            { value: 'own', label: '自己', title: '每个节点只算它自己的请求' },
            { value: 'subtree', label: '含后代', title: '每个节点包含它所有后代的汇总' },
          ]}
        />
        <span className="sep" />
        <button
          className="btn sm"
          onClick={() => {
            p.onExpandAll();
            setFitTick((t) => t + 1);
          }}
        >
          全部展开
        </button>
        <button
          className="btn sm"
          onClick={() => {
            p.onFirstLevelOnly();
            setFitTick((t) => t + 1);
          }}
        >
          只看第一层
        </button>
        <button
          className="btn sm"
          disabled={!hasMoved}
          onClick={() => {
            setMoved({});
            setFitTick((t) => t + 1);
          }}
          title={hasMoved ? '把拖动过的节点放回自动排列的位置' : '节点都在自动排列的位置上'}
        >
          整理
        </button>
      </div>

      <div className="canvas-tools bl" data-nopan>
        <button className="btn icon sm" onClick={() => cv.zoomBy(1 / 1.2)} title="缩小" aria-label="缩小">
          −
        </button>
        <button className="btn sm zoom" onClick={cv.resetZoom} title="恢复到 100%">
          {Math.round(cv.view.k * 100)}%
        </button>
        <button className="btn icon sm" onClick={() => cv.zoomBy(1.2)} title="放大" aria-label="放大">
          +
        </button>
        <span className="sep" />
        <button className="btn sm" onClick={fit} title="缩放到能看到整棵树">
          适应窗口
        </button>
      </div>

      <div className="canvas-tools br" data-nopan>
        <div className="legend">
          {(['running', 'completed', 'failed', 'stopped', 'unknown'] as const)
            .filter((s) => p.counts[s] > 0)
            .map((s) => (
              <span key={s}>
                <span className={`dot ${s}`} />
                {STATUS_LABEL[s]} {p.counts[s]}
              </span>
            ))}
          <span className="dim">节点可拖动 · 空白处拖动平移 · 滚轮缩放</span>
        </div>
      </div>

      <div className="canvas-layer" style={{ transform: `translate(${cv.view.x}px, ${cv.view.y}px) scale(${cv.view.k})`, transition: busy ? 'none' : undefined }}>
        <svg className="canvas-lines" width="1" height="1">
          {edges.map((e) => {
            const child = p.index.byId.get(e.id);
            const live = child?.status === 'running';
            return (
              <path
                key={e.id}
                d={e.d}
                pathLength={1}
                className={`edge ${live ? 'live' : ''} ${onPath.has(e.id) ? 'on-path' : ''}`}
                style={{ animationDelay: `${delayOf(e.id)}ms`, ['--lc' as string]: modelColor(child?.primaryModel, theme) }}
              />
            );
          })}
          {edges
            .filter((e) => p.index.byId.get(e.id)?.status === 'running')
            .map((e) => (
              <path key={`packet-${e.id}`} d={e.d} pathLength={1} className="packet" />
            ))}
          {advisorLine && <path className="advisor" d={advisorLine} style={zero ? { stroke: 'var(--warn)' } : undefined} />}
        </svg>

        {layout.order.map((id) => {
          const node = p.index.byId.get(id);
          const at = posOf(id);
          if (!node || !at) return null;
          const parentId = meta.parentOf.get(id);
          const from = (parentId && posOf(parentId)) || at;
          const own = usageOf(node, p.usageMode).tokens.total;
          return (
            <Positioned key={id} at={at} from={from} w={NODE_W} h={NODE_H} delay={delayOf(id)} moving={drag.movingId === id} onPointerDown={(e) => drag.start(e, id, at)}>
              <NodeCard
                node={node}
                selected={p.selectedId === id}
                usageMode={p.usageMode}
                orientation={p.orientation}
                descendants={p.index.descendants.get(id) ?? 0}
                runningBelow={p.index.runningBelow.get(id) ?? 0}
                folded={p.collapsed.has(id)}
                hasParent={!!parentId}
                title={node.kind === 'main' ? p.sessionTitle : null}
                share={meta.max > 0 ? own / meta.max : 0}
                onSelect={p.onSelect}
                onToggle={p.onToggle}
              />
            </Positioned>
          );
        })}

        {adv && (
          <Positioned at={adv} from={rootPos} w={NODE_W} h={ADV_H} delay={firstPaint ? 180 : 0} moving={drag.movingId === root.id}>
            <div
              className={`advisor-chip ${zero ? 'zero' : ''}`}
              onClick={() => p.onSelect(root.id)}
              title={zero ? '配置了 advisor，但这次会话一次都没有调用过' : `advisor 被调用了 ${root.advisorCalls} 次`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  p.onSelect(root.id);
                }
              }}
            >
              <span>advisor</span>
              <b className="ellipsis" style={{ minWidth: 0 }}>
                {shortModel(root.advisorModel)}
              </b>
              <span className="spacer" />
              <span>{zero ? '从未调用' : `调用 ${fullNumber(root.advisorCalls)} 次`}</span>
            </div>
          </Positioned>
        )}
      </div>
    </div>
  );
}

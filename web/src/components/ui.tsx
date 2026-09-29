import type { CSSProperties, ReactNode } from 'react';
import type { AgentStatus, CheckLevel, ConformanceVerdict, IndexStatus } from '../types';
import { ApiFailure } from '../api/client';
import { formatCost, fullNumber, relativeTime, shortNumber } from '../lib/format';
import { modelColor, shortModel } from '../lib/models';
import { useTheme } from '../lib/theme';
import { useAnimatedNumber, useFlash, useThumb } from '../lib/motion';

/**
 * token 数：缩写显示，悬停看完整数字。
 * animate：数值变化时平滑过渡。悬停提示始终是真实值，不受动画影响。
 */
export function Tok({ n, className, animate }: { n: number | null | undefined; className?: string; animate?: boolean }) {
  const tween = useAnimatedNumber(animate ? n : null);
  const shown = animate && n != null ? tween : n;
  return (
    <span className={`num ${className ?? ''}`} title={n == null ? undefined : `${fullNumber(n)} token`}>
      {shortNumber(shown)}
    </span>
  );
}

export function Num({ n, className, animate }: { n: number | null | undefined; className?: string; animate?: boolean }) {
  const tween = useAnimatedNumber(animate ? n : null);
  const shown = animate && n != null && tween != null ? Math.round(tween) : n;
  return (
    <span className={`num ${className ?? ''}`} title={animate && n != null ? fullNumber(n) : undefined}>
      {fullNumber(shown)}
    </span>
  );
}

export function Cost({ usd, animate }: { usd: number | null | undefined; animate?: boolean }) {
  const tween = useAnimatedNumber(animate ? usd : null);
  const shown = animate && usd != null ? tween : usd;
  return (
    <span className="num" title={usd == null ? '价格表里查不到该模型，未计价' : `$${usd.toFixed(4)}`}>
      {formatCost(shown)}
    </span>
  );
}

/** 包住一个会实时变化的值：值变化时短暂高亮，提示"这里刚更新" */
export function Flash({ value, children, className }: { value: unknown; children: ReactNode; className?: string }) {
  const on = useFlash(value);
  return <span className={`flash ${on ? 'on' : ''} ${className ?? ''}`}>{children}</span>;
}

export interface SegOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** 分段选择：选中项下面有一块滑动的底色 */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  label: string;
}) {
  const [ref, thumb] = useThumb('button.on', value);
  return (
    <div className="seg" role="group" aria-label={label} ref={ref}>
      <span
        className="seg-thumb"
        aria-hidden="true"
        style={{ width: thumb.size, transform: `translateX(${thumb.offset}px)`, opacity: thumb.size ? 1 : 0, transition: thumb.ready ? undefined : 'none' }}
      />
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ w, h = 14, style }: { w?: number | string; h?: number | string; style?: CSSProperties }) {
  return <span className="sk" style={{ width: w ?? '100%', height: h, ...style }} aria-hidden="true" />;
}

export function SkeletonStats({ n = 6 }: { n?: number }) {
  return (
    <div className="stats" aria-busy="true" aria-label="加载中">
      {Array.from({ length: n }, (_, i) => (
        <div className="stat" key={i}>
          <Skeleton w="45%" h={11} />
          <Skeleton w="70%" h={24} style={{ marginTop: 8 }} />
          <Skeleton w="55%" h={10} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 8, label = '加载中' }: { rows?: number; label?: string }) {
  return (
    <div className="card sk-rows" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-row" key={i}>
          <Skeleton w={`${38 - (i % 3) * 6}%`} />
          <Skeleton w="12%" />
          <Skeleton w="10%" />
          <Skeleton w="8%" />
        </div>
      ))}
    </div>
  );
}

export function ModelTag({ model, full, style }: { model: string | null | undefined; full?: boolean; style?: CSSProperties }) {
  const { theme } = useTheme();
  if (!model) return <span className="dim">—</span>;
  return (
    <span className="mtag" style={{ ['--mc' as string]: modelColor(model, theme), ...style }} title={model}>
      {full ? model : shortModel(model)}
    </span>
  );
}

export function EffortTag({ efforts }: { efforts: string[] | string | null | undefined }) {
  const list = Array.isArray(efforts) ? efforts : efforts ? [efforts] : [];
  if (!list.length) return <span className="effort dim" title="日志里没有记录 effort">effort —</span>;
  return (
    <span className="effort" title={`effort：${list.join(' → ')}`}>
      {list.join('→')}
    </span>
  );
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已中止',
  unknown: '未知',
};

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`dot ${status}`} title={STATUS_LABEL[status]} />;
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  const cls =
    status === 'running'
      ? 'running'
      : status === 'failed'
        ? 'fail'
        : status === 'stopped'
          ? 'stopped'
          : status === 'completed'
            ? 'muted'
            : 'outline';
  return (
    <span className={`badge ${cls}`} title={status === 'stopped' ? '被用户或系统中止' : undefined}>
      {status === 'running' && <span className="dot running" style={{ width: 6, height: 6 }} />}
      {status === 'stopped' && <span className="dot stopped" style={{ width: 6, height: 6 }} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export const LEVEL_LABEL: Record<CheckLevel, string> = { ok: '符合', warn: '注意', fail: '不符', info: '提示' };
const LEVEL_ICON: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗', info: 'i' };

export function LevelBadge({ level }: { level: CheckLevel }) {
  return (
    <span className={`badge ${level}`}>
      <b className="mono">{LEVEL_ICON[level]}</b>
      {LEVEL_LABEL[level]}
    </span>
  );
}

export const VERDICT_LABEL: Record<ConformanceVerdict, string> = {
  match: '符合预设',
  mismatch: '不符合',
  unplanned: '预设外',
  'not-checked': '未检查',
};
const VERDICT_CLS: Record<ConformanceVerdict, string> = {
  match: 'ok',
  mismatch: 'fail',
  unplanned: 'unplanned',
  'not-checked': 'muted',
};
const VERDICT_ICON: Record<ConformanceVerdict, string> = { match: '✓', mismatch: '✗', unplanned: '?', 'not-checked': '·' };

export function VerdictBadge({ verdict, fail, warn }: { verdict: ConformanceVerdict; fail?: number; warn?: number }) {
  const showWarn = verdict === 'match' && !!warn;
  return (
    <span className="row" style={{ gap: 4, display: 'inline-flex' }}>
      <span className={`badge ${showWarn ? 'warn' : VERDICT_CLS[verdict]}`}>
        <b className="mono">{showWarn ? '!' : VERDICT_ICON[verdict]}</b>
        {showWarn ? '符合但有注意项' : VERDICT_LABEL[verdict]}
      </span>
      {!!fail && verdict !== 'match' && (
        <span className="badge fail num" title={`${fail} 项不符`}>
          ✗{fail}
        </span>
      )}
      {!!warn && (
        <span className="badge warn num" title={`${warn} 项需要注意`}>
          !{warn}
        </span>
      )}
    </span>
  );
}

/** 树节点上的小方块标记；match 但有 warn 时显示黄色 ! */
export function VerdictMark({ verdict, hasWarn }: { verdict: ConformanceVerdict; hasWarn?: boolean }) {
  const warn = verdict === 'match' && hasWarn;
  const title = warn ? '符合预设，但有需要注意的项' : VERDICT_LABEL[verdict];
  return (
    <span className={`vmark ${warn ? 'warn' : verdict}`} title={title}>
      {warn ? '!' : VERDICT_ICON[verdict]}
    </span>
  );
}

export function Loading({ text = '加载中' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function Empty({ icon = '∅', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/** 接口错误提示。stale=true 表示有旧数据仍在显示 */
export function ErrorBox({ error, onRetry, stale }: { error: ApiFailure; onRetry?: () => void; stale?: boolean }) {
  const offline = error.kind === 'offline';
  return (
    <div className={`alert ${stale ? 'warn' : 'error'}`} role="alert">
      <span className="mono" style={{ fontWeight: 700, color: stale ? 'var(--warn)' : 'var(--fail)' }}>
        {stale ? '!' : '✗'}
      </span>
      <div className="alert-body">
        <div className="title">
          {stale ? '刷新失败，当前显示的是上一次获取的数据。' : offline ? '后端未启动' : '请求失败'}
        </div>
        <div>{error.message}</div>
        {offline && !stale && (
          <pre>{`在项目的 server 目录下启动后端：\n  cd server\n  npm run dev\n\n后端启动后，本页每 5 秒自动重试，不用手动刷新。\n\n或者用模拟数据预览界面：\n  cd web\n  npm run dev:mock`}</pre>
        )}
        {error.detail && <div className="small dim mono">{error.detail}</div>}
      </div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function IndexBanner({ index, onReindex, busy }: { index: IndexStatus; onReindex?: () => void; busy?: boolean }) {
  const pctDone = index.filesTotal ? Math.min(100, (index.filesIndexed / index.filesTotal) * 100) : 0;
  const indexing = index.state === 'indexing';
  return (
    <div className="card" style={{ padding: '8px 14px' }}>
      <div className="row wrap" style={{ gap: 12 }}>
        <span className={`dot ${indexing ? 'running' : 'completed'}`} />
        <span>
          {indexing ? '正在索引日志' : '索引已是最新'}
          <span className="muted num" style={{ marginLeft: 8 }}>
            {fullNumber(index.filesIndexed)} / {fullNumber(index.filesTotal)} 个文件
          </span>
        </span>
        {indexing && (
          <div className="progress striped" style={{ flex: '1 1 160px', maxWidth: 360 }}>
            <span style={{ width: `${pctDone}%` }} />
          </div>
        )}
        {indexing && <span className="num muted">{pctDone.toFixed(0)}%</span>}
        <span className="spacer" />
        <span className="small muted">
          上次完成：{relativeTime(index.lastIndexedAt)}
          {index.skippedLines > 0 && (
            <span title="日志里无法解析的行，已跳过" style={{ marginLeft: 10 }}>
              跳过坏行 <span className="num">{fullNumber(index.skippedLines)}</span>
            </span>
          )}
        </span>
        {onReindex && (
          <button className="btn sm" onClick={onReindex} disabled={busy || indexing} title="触发一次增量扫描">
            {busy ? '扫描中…' : '重新扫描'}
          </button>
        )}
      </div>
      {indexing && <div className="small muted" style={{ marginTop: 4 }}>索引进行中，以下数字可能还不完整，会自动刷新。</div>}
    </div>
  );
}

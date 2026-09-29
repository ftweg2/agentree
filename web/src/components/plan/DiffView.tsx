import { useMemo, useState } from 'react';
import { diffLines, splitText, toChunks, type DiffLine } from '../../lib/diff';

/** 逐行差异：删除红色、增加绿色；未改动的长段折叠，点击可展开 */
export default function DiffView({ before, after }: { before: string | null; after: string | null }) {
  const { lines, notices } = useMemo(() => {
    const a = splitText(before);
    const b = splitText(after);
    const notices: string[] = [];
    if (before != null && after != null) {
      // 行尾符（CRLF / LF）按行拆分时已经忽略，不单独显示
      if (a.bom !== b.bom) notices.push(b.bom ? '新增了 UTF-8 BOM' : '去掉了 UTF-8 BOM');
      if (a.finalNewline !== b.finalNewline) notices.push(b.finalNewline ? '文件末尾新增换行' : '文件末尾的换行被去掉');
    }
    return { lines: diffLines(a.lines, b.lines), notices };
  }, [before, after]);
  const chunks = useMemo(() => toChunks(lines, 3), [lines]);
  const [open, setOpen] = useState<Set<number>>(new Set());

  if (lines.length === 0) {
    return <div className="diff-empty small muted">{before == null && after === '' ? '新建一个空文件' : '文件内容为空'}</div>;
  }
  const changed = lines.some((l) => l.type !== 'same');

  return (
    <div className="diff">
      {notices.map((n) => (
        <div key={n} className="diff-notice">
          {n}
        </div>
      ))}
      {!changed && notices.length === 0 && <div className="diff-notice">内容没有变化</div>}
      {chunks.map((c, ci) =>
        c.kind === 'fold' && !open.has(ci) ? (
          <button
            key={ci}
            type="button"
            className="diff-fold"
            onClick={() => setOpen((s) => new Set(s).add(ci))}
            title="展开未改动的内容"
          >
            ⋯ 未改动 {c.lines.length} 行（第 {c.lines[0].oldNo}–{c.lines[c.lines.length - 1].oldNo} 行），点击展开
          </button>
        ) : (
          <div key={ci}>
            {c.lines.map((l, li) => (
              <Line key={li} l={l} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function Line({ l }: { l: DiffLine }) {
  return (
    <div className={`dl ${l.type}`}>
      <span className="dl-no">{l.oldNo ?? ''}</span>
      <span className="dl-no">{l.newNo ?? ''}</span>
      <span className="dl-sign" aria-hidden="true">
        {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
      </span>
      <span className="dl-text">
        <span className="sr-only">{l.type === 'add' ? '新增：' : l.type === 'del' ? '删除：' : ''}</span>
        {l.text || ' '}
      </span>
    </div>
  );
}

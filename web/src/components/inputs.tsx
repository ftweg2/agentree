import { useEffect, useRef, useState } from 'react';
import { shortNumber } from '../lib/format';
import { EFFORT_LEVELS, MODEL_ALIASES } from '../lib/models';
import { FAMILY_NAME, useModelOptions } from '../lib/modelOptions';

const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'other'] as const;

const isAliasValue = (v: string | null) => v != null && (MODEL_ALIASES as readonly string[]).includes(v);

/**
 * 模型选择。下拉框里有三类：
 *   跟着最新版本走  opus、sonnet 这类别名，Claude Code 升级后自动指向新版本
 *   具体的型号      按系列分组，如 Opus 5.5。清单来自价格表和本机用过的模型
 *   手动输入        清单里没有的写法，如带 [1m] 后缀的
 * 选第一项（emptyLabel）表示 null。
 */
export function ModelInput({
  value,
  onChange,
  emptyLabel = '不检查',
  placeholder = '如 claude-opus-5-5，留空表示不检查',
  id,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  emptyLabel?: string;
  placeholder?: string;
  id?: string;
}) {
  const models = useModelOptions();
  const listed = (v: string | null) => v != null && (isAliasValue(v) || models.some((m) => m.id === v));
  const [custom, setCustom] = useState(value != null && value !== '' && !listed(value));
  // 用户自己选了"手动输入"之后，输入过程中即使恰好打出了清单里的名字，也不要把输入框收起来
  const chosen = useRef(false);
  useEffect(() => {
    // 清单是异步拿到的：拿到之后，原来当作"手动输入"的值如果在清单里，就回到下拉框里显示
    if (!chosen.current && value != null && value !== '') setCustom(!listed(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, models]);

  const selectValue = custom ? '__custom' : (value ?? '');
  return (
    <div className="model-input">
      <select
        id={id}
        className="select"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          chosen.current = v === '__custom';
          if (v === '__custom') {
            setCustom(true);
            onChange(value && !isAliasValue(value) ? value : '');
          } else {
            setCustom(false);
            onChange(v || null);
          }
        }}
      >
        <option value="">{emptyLabel}</option>
        {FAMILY_ORDER.filter((f) => models.some((m) => m.family === f)).map((f) => (
          <optgroup key={f} label={FAMILY_NAME[f]}>
            {models
              .filter((m) => m.family === f)
              .map((m) => (
                <option key={m.id} value={m.id} title={m.id}>
                  {m.label === m.id ? m.id : `${m.label} · ${m.id}`}
                </option>
              ))}
          </optgroup>
        ))}
        <optgroup label="跟着最新版本走">
          {MODEL_ALIASES.map((a) => (
            <option key={a} value={a}>
              {a} · 最新的 {FAMILY_NAME[a]}
            </option>
          ))}
        </optgroup>
        <option value="__custom">手动输入…</option>
      </select>
      {custom && (
        <input
          className="input mono"
          value={value ?? ''}
          placeholder={placeholder}
          aria-label="模型 ID"
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoFocus={!value}
        />
      )}
    </div>
  );
}

/** effort 下拉。allowMax=false 时不提供 max（settings.json 不接受 max） */
export function EffortSelect({
  value,
  onChange,
  emptyLabel = '不检查',
  allowMax = true,
  id,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  emptyLabel?: string;
  allowMax?: boolean;
  id?: string;
}) {
  const levels = allowMax ? EFFORT_LEVELS : EFFORT_LEVELS.filter((e) => e !== 'max');
  const known = value == null || (levels as readonly string[]).includes(value);
  return (
    <select id={id} className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={{ minWidth: 100 }}>
      <option value="">{emptyLabel}</option>
      {levels.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
      {!known && (
        <option value={value!}>
          {value}（{value === 'max' ? '此处不支持' : '未知级别'}）
        </option>
      )}
    </select>
  );
}

/** 自动压缩阈值的常用档位（token 数）。Claude Code 接受 100000 到 1000000 */
export const COMPACT_PRESETS = [200_000, 500_000, 800_000, 1_000_000];

/**
 * 自动压缩阈值：几个常用档位加"自定义"。自定义时按千 token（K）输入，存的是 token 数。
 * 选第一项（emptyLabel）表示 null：不指定，跟 Claude Code 默认
 */
export function CompactSelect({
  value,
  onChange,
  emptyLabel = '不指定（跟 Claude Code 默认）',
  id,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  emptyLabel?: string;
  id?: string;
}) {
  const [custom, setCustom] = useState(value !== null && !COMPACT_PRESETS.includes(value));
  useEffect(() => {
    if (value !== null && !COMPACT_PRESETS.includes(value)) setCustom(true);
  }, [value]);
  const selectValue = custom ? '__custom' : value === null ? '' : String(value);
  return (
    <div className="model-input">
      <select
        id={id}
        className="select"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom') {
            setCustom(true);
            if (value === null) onChange(300_000);
          } else {
            setCustom(false);
            onChange(v ? Number(v) : null);
          }
        }}
      >
        <option value="">{emptyLabel}</option>
        {COMPACT_PRESETS.map((v) => (
          <option key={v} value={String(v)}>
            {shortNumber(v)} token
          </option>
        ))}
        <option value="__custom">自定义…</option>
      </select>
      {custom && (
        <span className="row" style={{ gap: 6 }}>
          <input
            className="input mono"
            type="number"
            min={100}
            max={1000}
            step={10}
            style={{ width: 96, minWidth: 0, flex: 'none' }}
            value={value === null ? '' : Math.round(value / 1000)}
            aria-label="自动压缩阈值，单位千 token"
            onChange={(e) => onChange(e.target.value === '' ? null : Math.round(Number(e.target.value)) * 1000)}
          />
          <span className="small muted">K token（100 到 1000）</span>
        </span>
      )}
    </div>
  );
}

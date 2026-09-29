import type { EnvCheck } from '../types';
import { LevelBadge } from './ui';

/** 环境变量检查结果（只读）。agentree 只报告，不修改环境变量 */
export default function EnvTable({ env }: { env: EnvCheck[] }) {
  if (!env.length) return <div className="empty small">没有环境变量检查结果。</div>;
  return (
    <div className="table-wrap">
      <table className="data compact">
        <thead>
          <tr>
            <th>变量</th>
            <th>值</th>
            <th>位置</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {env.map((e, i) => (
            <tr key={`${e.name}-${e.scope}-${i}`}>
              <td>
                <div className="mono small">{e.name}</div>
                <div className="small muted">{e.impact}</div>
              </td>
              <td className="mono small nowrap">{e.value ?? <span className="dim">未设置</span>}</td>
              <td className="small nowrap">{e.scope === 'user' ? '用户' : e.scope === 'machine' ? '系统' : 'settings'}</td>
              <td>
                <LevelBadge level={e.level} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

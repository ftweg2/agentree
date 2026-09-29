// "只用一次"：生成一条只对那一次会话生效的命令行启动命令（PowerShell 写法）。
// 纯函数，前端的搭建页和后端的测试都用它。不写任何文件。
import type { Preset } from './types.js';

/**
 * 命令带上画布上的子 agent（--agents）、主模型（--model）、effort（--effort）和自动压缩阈值（--autocompact）。
 * isBuiltin 判断名字是不是内置类型：内置类型没有定义文件，不放进 --agents
 */
export function launchCommand(p: Preset, cwd: string | null, isBuiltin: (name: string) => boolean): string {
  const list = (v: string | null | undefined) =>
    (v ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  const agents: Record<string, Record<string, unknown>> = {};
  for (const a of p.agents) {
    if (isBuiltin(a.name)) continue;
    const def: Record<string, unknown> = { description: a.description ?? a.note ?? a.name, prompt: a.prompt ?? '' };
    if (a.tools) def.tools = list(a.tools);
    if (a.disallowedTools) def.disallowedTools = list(a.disallowedTools);
    if (a.model) def.model = a.model;
    if (a.effort) def.effort = a.effort;
    agents[a.name] = def;
  }
  const args = ['claude'];
  if (p.main.model) args.push('--model', p.main.model);
  if (p.main.effort) args.push('--effort', p.main.effort);
  // --autocompact 接受纯数字的 token 数（也接受 500k 这类写法，这里统一用数字）
  if (p.main.autoCompactWindow) args.push('--autocompact', String(p.main.autoCompactWindow));
  const lines: string[] = [];
  if (cwd) lines.push(`Set-Location "${cwd}"`);
  if (Object.keys(agents).length) lines.push(`${args.join(' ')} --agents @'`, JSON.stringify(agents, null, 2), "'@");
  else lines.push(args.join(' '));
  return lines.join('\n');
}

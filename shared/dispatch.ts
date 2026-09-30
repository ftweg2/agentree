// 子 agent "往下派发时指定的模型"：Claude Code 没有对应的 frontmatter 字段，唯一能左右下一层模型的是派发时传给
// Agent 工具的 model 参数（官方文档的解析顺序里排第一）。所以 agentree 把这个要求写进子 agent 的系统提示词，
// 放在正文末尾一段受管的块里，用注释标记包起来，读回时再拆出来。这是给模型的提示，不是硬性限制；
// 它每次派发实际传了什么，会话页和生效检查按日志核对。
//
// 块的格式（模型写在起始标记里，方便解析；中间的文字给模型看）：
//   <!-- agentree:dispatch-model:start model=haiku -->
//   ## 往下派发子 agent 时
//   用 Agent 工具派发子 agent 时，把 model 参数设为 `haiku`。用户在任务里明确要求别的模型时以用户的为准。
//   <!-- agentree:dispatch-model:end -->
// 纯函数，前端和后端共用，不读写文件。换行统一用 \n，后端写文件时按文件原有的换行风格转换。

export const DISPATCH_END = '<!-- agentree:dispatch-model:end -->';

/** 起始标记里的模型：别名（opus、sonnet、haiku、fable）或完整模型 ID，不能有空白和 > */
export const DISPATCH_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]*$/;

export function dispatchStart(model: string): string {
  return `<!-- agentree:dispatch-model:start model=${model} -->`;
}

/** 整个块，不含结尾换行 */
export function dispatchBlock(model: string): string {
  return [
    dispatchStart(model),
    '## 往下派发子 agent 时',
    `用 Agent 工具派发子 agent 时，把 model 参数设为 \`${model}\`。用户在任务里明确要求别的模型时以用户的为准。`,
    DISPATCH_END,
  ].join('\n');
}

const BLOCK_RE = /(?:\r?\n)*<!-- agentree:dispatch-model:start model=([^\s>]+) -->[\s\S]*?<!-- agentree:dispatch-model:end -->[ \t]*(?:\r?\n)*/;

/**
 * 从定义文件正文里拆出 agentree 的派发块：prompt 是去掉块（以及块前后的空行）之后的提示词，model 是块里写的模型。
 * 没有块时 model 为 null、prompt 原样返回。块只认第一个
 */
export function parseDispatch(body: string): { prompt: string; model: string | null } {
  const m = BLOCK_RE.exec(body);
  if (!m) return { prompt: body, model: null };
  const model = DISPATCH_MODEL_RE.test(m[1]) ? m[1] : null;
  const before = body.slice(0, m.index).replace(/(\r?\n)+$/, '');
  const after = body.slice(m.index + m[0].length);
  const prompt = before && after ? `${before}\n\n${after}` : before || after;
  return { prompt, model };
}

/** 把派发块接到提示词末尾（model 为 null 时只返回去掉块的提示词）。提示词里已有的旧块先去掉，保证只有一个 */
export function withDispatch(prompt: string, model: string | null): string {
  const base = parseDispatch(prompt).prompt.replace(/(\r?\n)+$/, '');
  if (model === null) return base;
  return base ? `${base}\n\n${dispatchBlock(model)}` : dispatchBlock(model);
}

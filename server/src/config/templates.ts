// 新建 agent 定义时的模板，以及方案模板。
import type { AgentTemplateInfo, PresetAgent, PresetTemplate } from '../../../shared/types.ts';

export interface AgentTemplate {
  /** 菜单上的短说明；兜底模板为 null */
  label: string | null;
  description: string;
  tools: string | null;
  disallowedTools: string | null;
  /** 正文，即系统提示词 */
  prompt: string;
  /** 为 true 表示名字不认识、用的是占位文字（主会话看不出什么时候该派发它） */
  placeholder: boolean;
}

/** 专用模板，按"添加节点"菜单里的顺序排列 */
const AGENT_TEMPLATES: Array<{ name: string } & Omit<AgentTemplate, 'placeholder'>> = [
  {
    name: 'explorer',
    label: '读代码',
    description:
      '只读地查找和阅读代码。需要弄清楚"某段逻辑在哪里""某个功能是怎么实现的""改这里会影响哪些地方"时使用。涉及多个文件的查找都应该交给它，主动使用。',
    tools: 'Read, Grep, Glob',
    disallowedTools: null,
    prompt: [
      '你是代码探索员，负责在代码库里查找和阅读代码，回答"在哪里""怎么实现的""会影响什么"这类问题。',
      '',
      '## 工作方式',
      '- 先用 Glob 和 Grep 缩小范围，再用 Read 读关键部分，不要把整个文件从头读到尾',
      '- 同一个问题从多个角度查：定义在哪、谁调用了它、有没有测试、有没有同名的东西',
      '- 只读不改：不修改、不创建、不删除任何文件',
      '',
      '## 汇报',
      '你看不到主会话之前的对话，主会话也看不到你的查找过程，它只会收到你最后的汇报。所以汇报要能独立看懂：',
      '- 先用一两句话直接回答问题',
      '- 列出关键位置，写成 `文件路径:行号`，并说明每处是什么',
      '- 分清楚哪些是你读过代码确认的，哪些是推测',
      '- 没找到就说没找到，并说明查过哪些地方',
      '',
    ].join('\n'),
  },
  {
    name: 'worker',
    label: '改代码、跑测试',
    description: '按明确的要求修改代码并运行测试。任务的范围和做法已经确定、需要动手改文件时使用。',
    tools: null,
    disallowedTools: null,
    prompt: [
      '你是代码修改员，负责按主会话给出的明确要求修改代码，并用测试确认改对了。',
      '',
      '## 工作方式',
      '- 动手前先读相关代码，弄清楚现有的写法和约定，改动要和周围的代码风格一致',
      '- 只改任务要求的范围，不顺手重构无关的代码，不改无关的格式',
      '- 要求不清楚，或者发现要求和代码现状对不上时，不要猜，在汇报里写明问题',
      '- 改完运行相关的测试；没有现成测试时，用能做到的最直接的方式验证',
      '',
      '## 汇报',
      '主会话只会收到你最后的汇报：',
      '- 改了哪些文件，每个文件改了什么',
      '- 运行了什么验证，结果如何。测试失败就如实写失败并附上关键输出，不要掩盖',
      '- 没做完或者没验证的部分',
      '',
    ].join('\n'),
  },
  {
    name: 'researcher',
    label: '查文档',
    description: '查阅官方文档和网上资料，回答技术问题。需要确认某个库、接口、工具的用法或版本差异时使用。',
    tools: 'Read, Grep, Glob, WebFetch, WebSearch',
    disallowedTools: null,
    prompt: [
      '你是资料调研员，负责查阅文档和资料，回答技术问题。',
      '',
      '## 工作方式',
      '- 优先查官方文档和源码，其次才是博客和问答',
      '- 注意版本：确认资料说的版本和项目实际用的版本是否一致',
      '- 只读不改：不修改项目里的任何文件',
      '',
      '## 汇报',
      '主会话只会收到你最后的汇报：',
      '- 先直接给出结论',
      '- 每条结论标明出处（链接或文件路径）',
      '- 分清楚哪些是资料里明确写的，哪些是你的推断',
      '- 查不到就说查不到，不要编造',
      '',
    ].join('\n'),
  },
];

export function agentTemplate(name: string): AgentTemplate {
  const t = AGENT_TEMPLATES.find((x) => x.name === name);
  if (t) {
    const { name: _n, ...rest } = t;
    return { ...rest, placeholder: false };
  }
  return {
    label: null,
    description: `${name}（请填写：什么时候应该把任务交给这个 agent）`,
    tools: null,
    disallowedTools: null,
    prompt: [
      `这是 agentree 生成的 ${name} 子 agent 的占位说明。`,
      '',
      '请编辑这段正文，写清楚这个 agent 的职责、工作方式和需要遵守的约束。正文会作为它的系统提示词。',
      '',
    ].join('\n'),
    placeholder: true,
  };
}

/** GET /api/config/agent-templates：专用模板（explorer、worker、researcher） */
export function agentTemplateInfos(): AgentTemplateInfo[] {
  return AGENT_TEMPLATES.map((t) => ({
    name: t.name,
    label: t.label ?? t.name,
    description: t.description,
    tools: t.tools,
    disallowedTools: t.disallowedTools,
    prompt: t.prompt,
  }));
}

/** 方案模板里的 agent：带上专用模板的完整内容，前端拿到就能直接显示 */
function templateAgent(name: string, model: string | null, effort: string | null): PresetAgent {
  const t = agentTemplate(name);
  return { name, model, effort, description: t.description, tools: t.tools, disallowedTools: t.disallowedTools, prompt: t.prompt };
}

export const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    id: 'opus-main-fable-advisor',
    name: 'Opus 5.5 主力 + Fable 5.1 顾问',
    description:
      '主会话用 Opus 5.5 高强度运行，三个子 agent 分别负责读代码、改代码、查文档，用 Opus 5.5 中等强度；Fable 5.1 作为顾问，在关键节点给建议',
    preset: {
      version: 1,
      main: { model: 'claude-opus-5-5', effort: 'high', autoCompactWindow: null },
      advisor: { model: 'fable' },
      agents: [templateAgent('explorer', 'opus', 'medium'), templateAgent('worker', 'opus', 'medium'), templateAgent('researcher', 'opus', 'medium')],
      allowBuiltins: true,
      updatedAt: null,
    },
    includeRule: true,
  },
];

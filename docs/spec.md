# agentree 第一阶段规格

## 目标

本地网页应用，读取 Claude Code 的本地日志，展示：

1. 每个模型请求了多少次、用了多少 token
2. 一次对话分出了多少子 agent，它们的层级关系（agent 树）
3. 按 agent 分组的统计
4. 现在正在跑的是哪个 agent
5. 实际运行是否按照用户预设的 agent 走

第一阶段**只读**：不修改 `~/.claude` 下的任何文件。预设存在 agentree 自己的目录里。

## 目录结构

```
agentree/
  shared/types.ts   接口契约，前后端都从这里导入类型（只读，不要改）
  server/           Node 后端，独立的 package.json
  web/              React 前端，独立的 package.json
  docs/             文档
```

`server/` 和 `web/` 各自有 `node_modules`，互不依赖。两边都用相对路径 `../shared/types` 导入类型（仅类型导入）。

## 运行环境

- Windows 11，Node 24，npm 11
- 后端监听 `127.0.0.1:4777`，**只绑定本机回环地址**
- 前端开发服务器 `127.0.0.1:5173`，把 `/api` 代理到 4777
- 生产模式：后端直接托管 `web/dist` 的静态文件

## 安全与隐私

- 日志里有用户的对话内容。接口**不返回任何消息正文**，只返回统计数字、模型名、agent 类型、任务描述（`description`）和会话标题
- 后端只绑定 127.0.0.1
- 环境变量的值超过 12 个字符时只返回前 4 位加省略号
- 第一阶段不写 `~/.claude` 和 `%APPDATA%\Claude` 下的任何文件

## 数据位置（已在本机验证）

| 数据 | 位置 |
|---|---|
| 主会话日志 | `<configDir>/projects/<项目目录>/<sessionId>.jsonl` |
| 子 agent 日志 | `<configDir>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl` |
| 子 agent 元数据 | 同目录 `agent-<agentId>.meta.json` |
| Workflow 子 agent | `<sessionId>/subagents/workflows/wf_<id>/agent-*.jsonl` |
| 桌面版会话元数据 | `%APPDATA%\Claude\claude-code-sessions\**\local_*.json` |
| 桌面版额度历史 | `%APPDATA%\Claude\plan-usage-history.json` |
| 用户级 agent 定义 | `<configDir>/agents/*.md` |
| 项目级 agent 定义 | `<cwd>/.claude/agents/*.md` |

`configDir` 取值：环境变量 `CLAUDE_CONFIG_DIR`（可逗号分隔多个），否则 `os.homedir()/.claude`。取用户目录用 `os.homedir()`，不要读 `HOME` 环境变量。

本机数据量：85 个 jsonl 文件，共 454MB，最大单文件 84MB。

要跳过的文件：`subagents/**/journal.jsonl`。

## 日志记录的结构（已在本机验证）

每行一个 JSON。需要的记录类型：

### assistant 记录

顶层字段：`type: "assistant"`、`uuid`、`parentUuid`、`sessionId`、`agentId`（仅子 agent 文件有）、`isSidechain`、`requestId`、`timestamp`、`effort`、`advisorModel`、`version`、`cwd`、`gitBranch`、`entrypoint`、`attributionAgent`

`message` 字段：`id`、`model`、`content`（块数组）、`stop_reason`、`usage`

`message.usage` 字段：
- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- `cache_creation.ephemeral_5m_input_tokens`
- `cache_creation.ephemeral_1h_input_tokens`
- `iterations[]`：每项有 `type`。`type` 为 `advisor_message` 的是 advisor 调用，有自己的 `model` 和 token，**不计入顶层 usage**

`message.content` 里 `type: "tool_use"` 的块：`id`、`name`、`input`。`name` 为 `Agent`（旧版为 `Task`）时是派发子 agent，`input` 有 `subagent_type`、`description`、`model`、`run_in_background`。

### user 记录里的工具结果

顶层 `toolUseResult` 对象，配合 `message.content[]` 里 `type: "tool_result"` 块的 `tool_use_id`。

前台子 agent 完成时：`status`、`agentId`、`agentType`、`resolvedModel`、`totalDurationMs`、`totalTokens`、`totalToolUseCount`、`usage`

后台子 agent 启动时：`isAsync: true`、`status`、`agentId`、`description`、`resolvedModel`、`outputFile`

### meta.json

`{ "agentType", "description", "toolUseId", "spawnDepth" }`

### 桌面版会话元数据

`cliSessionId` 对应 jsonl 的文件名。其他有用字段：`title`、`model`、`effort`、`createdAt`、`lastActivityAt`、`isArchived`

### 额度历史

`{ version, samples: [{ t, org, u: { fh, sd } }] }`。`fh` 是 5 小时窗口已用百分比，`sd` 是 7 天窗口已用百分比。

## 必须遵守的解析规则

这些规则都经过本机验证或来自其他项目踩过的坑，**不能省略**。

### 1. 请求去重

同一次 API 请求会拆成多行写入。本机实测不去重会虚高 2.6 到 5 倍。

- 去重键：`message.id`。缺失时用 `requestId`，都缺失时用 `uuid`
- 同一个键出现多次时，**逐字段取最大值**
- 不要用"保留第一条"：本机 1268 个多行请求里有 73 个第一条不是最大值
- 不要用"优先保留有 stop_reason 的"：本机最后一条带 stop_reason 的只有 161/1268
- 去重范围是整个会话（主文件加所有子 agent 文件）。同一个 `message.id` 同时出现在主文件和子 agent 文件里时，算给主文件，丢弃子 agent 文件里的副本

### 2. 计入条件

四项 token 任一大于 0 就计入。模型名为 `<synthetic>` 的不计入。

### 3. 子 agent 的 token 必须自己累加

工具结果里的 `totalTokens` 只是最后一次请求的值。本机实测比真实累计低 3.5 到 32 倍。**不要使用它**。每个 agent 的统计必须从它自己的 jsonl 文件累加。

### 4. 建树

用 `meta.json` 的 `toolUseId` 匹配 `tool_use` 块的 `id`：
- 在主文件里找到：父节点是 `main`
- 在另一个子 agent 文件里找到：父节点是那个子 agent

本机 31 个子 agent 全部能精确匹配（24 个挂在主会话下，7 个嵌套）。

兜底顺序：
1. `meta.json` 的 `toolUseId`
2. 任一文件里 `toolUseResult.agentId` 对应的 `tool_use_id`
3. 都找不到时挂到 `main` 下，`depth` 用 `meta.json` 的 `spawnDepth`

没有 `meta.json` 的子 agent 文件也要处理，`agentType` 从父级 `tool_use` 的 `input.subagent_type` 取。

### 5. 工具调用次数

数该 agent 文件里 `type: "tool_use"` 的块，按块的 `id` 去重。

### 6. 状态判断

| 状态 | 条件 |
|---|---|
| completed | 父级有对应的工具结果且不是 `isAsync`；或后台子 agent 在父级文件里出现了包含其 agentId 的任务通知 |
| failed | 工具结果的 `status` 是 error 或 failed |
| running | 未完成，且该 agent 文件最近 120 秒内有写入 |
| unknown | 以上都不是 |

### 7. 宽松解析

- 某一行 JSON 解析失败：跳过这一行，计数加一，继续
- 字段缺失或为 null：该字段按空值处理，不要丢弃整行
- 遇到不认识的记录类型或字段：忽略

### 8. 增量与持久化

- 解析结果存进 SQLite（用 Node 内置的 `node:sqlite`，不要装原生模块），数据库文件放在 `os.homedir()/.agentree/agentree.db`
- 每个文件记录已读到的字节偏移量。只处理到最后一个完整换行符，半行留到下次
- 判断文件是否变化要**同时看修改时间和文件大小**
- 文件变小了（被截断或重写）：从头重新解析该文件，靠去重键保证不重复
- 数据只增不删。日志文件被 Claude Code 清理后，已入库的数据要保留
- 启动时后台扫描，不阻塞接口响应；扫描期间接口返回已有数据，并在 `IndexStatus` 里报告进度
- 运行期间每 2 秒检查最近活跃的文件，每 30 秒全量检查一次

### 9. 大文件

用流式读取，不要把整个文件读进内存。最大的文件有 84MB。

## 一致性检查

把实际运行和预设（`Preset`）对比。

### 会话级检查（`sessionChecks`）

| 检查 | 规则 |
|---|---|
| 主模型 | 预设的 `main.model` 对比主会话的 `primaryModel` |
| 主 effort | 预设的 `main.effort` 对比主会话出现过的 effort |
| advisor 配置 | 预设的 `advisor.model` 对比记录上的 `advisorModel` |
| advisor 调用 | 配置了 advisor 但 `advisorCalls` 为 0 时，给 `warn`：配置了但这次会话没有触发过 |

### 每个子 agent 的检查

| 检查 | 规则 |
|---|---|
| agent 类型 | `agentType` 在预设的 `agents` 里：ok。是内置类型且 `allowBuiltins` 为 true：info。否则：整体判定 `unplanned` |
| 模型 | 预设的模型对比实际的 `primaryModel` |
| effort | 预设的 effort 对比实际出现过的 effort |

预设里某一项为 null 表示不检查这一项。

### 模型匹配规则

比较前先归一化：去掉 `[1m]` 这类方括号后缀，去掉末尾的日期（`-20250929`）。

- 预设是别名（`opus`、`sonnet`、`haiku`、`fable`）：实际模型名包含 `-<别名>-` 或以 `-<别名>` 结尾即为 ok
- 预设是完整 ID：归一化后完全相等为 ok
- 实际模型和预设同一系列但版本不同（如预设 `claude-opus-5-5`，实际 `claude-opus-5`）：warn，说明版本不同
- 其余：fail
- 一个 agent 用了多个模型：warn，列出所有模型

### effort 匹配规则

- 相等：ok
- 实际比预设低：warn，说明可能是模型不支持该级别被自动降级，或被环境变量 `CLAUDE_CODE_EFFORT_LEVEL` 覆盖
- 实际比预设高：fail
- 日志里没有 effort：info

级别顺序：low < medium < high < xhigh < max

### 内置 agent 类型

`general-purpose`、`Explore`、`Plan`、`claude-code-guide`、`statusline-setup`、`claude`、`output-style-setup`

### 默认预设

没有保存过预设时，用这个：

```json
{
  "version": 1,
  "main": { "model": null, "effort": null },
  "advisor": { "model": null },
  "agents": [],
  "allowBuiltins": true,
  "updatedAt": null
}
```

预设文件位置：`os.homedir()/.agentree/preset.json`

### 根据配置生成预设

`POST /api/preset/from-config`：读取用户级和项目级的 agent 定义文件，把每个定义的 `name`、`model`、`effort` 填进 `agents`；`main` 和 `advisor` 从 `settings.json` 取。只返回，不保存。

## 环境变量检查

Windows 上读注册表的用户级（`HKCU\Environment`）和系统级（`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`），用 `reg query` 命令。另外读 `settings.json` 的 `env` 字段。

要检查的变量：

| 变量 | 影响 |
|---|---|
| `CLAUDE_CODE_EFFORT_LEVEL` | 覆盖所有 effort 设置，包括子 agent 配置文件里的 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 agent 没有指定模型时的默认模型 |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | 强制所有子 agent 用同一个模型 |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` | 禁用 advisor |
| `DISABLE_TELEMETRY` | 会导致功能开关无法拉取，advisor 可能不可用 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 同上 |
| `CLAUDE_CONFIG_DIR` | 改变了配置目录的位置 |
| `ANTHROPIC_BASE_URL` | 请求走了代理或第三方，advisor 可能不可用 |

cc-switch 检测：`os.homedir()/.cc-switch/live-state.json` 存在，或 `ANTHROPIC_BASE_URL` 指向 `127.0.0.1:15721`。

## 价格

价格是次要功能，用户用的是订阅。

- 启动时尝试下载 `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`，缓存到 `os.homedir()/.agentree/pricing.json`，24 小时内不重复下载
- 下载失败且没有缓存：所有 `costUsd` 为 null
- 模型名匹配前先归一化，规则同上
- 1 小时缓存写入的价格：有单独字段用单独字段，没有则按输入价的 2 倍
- 5 分钟缓存写入：有字段用字段，没有则按输入价的 1.25 倍
- 缓存读取：有字段用字段，没有则按输入价的 0.1 倍
- 查不到的模型 `costUsd` 为 null，不要猜

## 界面

中文界面。风格参考终端配色的深色主题，同时支持浅色。

### 页面

| 页面 | 内容 |
|---|---|
| 总览 | 各模型请求次数和 token、各 agent 类型的派发次数和用量、每日趋势、额度曲线（5 小时和 7 天） |
| 实时 | 当前活跃的会话，正在运行的 agent 高亮显示，每 2 秒刷新 |
| 会话列表 | 标题、项目、时间、主模型、子 agent 数量、请求数、token、一致性结果 |
| 会话详情 | agent 树、选中节点的详情、按 agent 的统计表、一致性检查结果 |
| 预设 | 编辑期望的 agent 树；查看检测到的 agent 定义文件；环境变量检查结果 |

### agent 树

- 主会话在最上面，子 agent 按层级向下展开，有连线
- 每个节点显示：类型、任务描述、模型、请求数、token、状态、一致性标记
- 可以切换显示"自己的用量"或"含后代的用量"
- 正在运行的节点有明显的动态标记
- 节点可折叠
- 点击节点在侧边显示详情：按模型拆分、各项 token、effort、耗时、工具调用数、一致性检查的每一项和说明

### 数字显示

token 数用 K / M 缩写，鼠标悬停显示完整数字。费用为 null 时显示 "—"。

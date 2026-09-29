# agentree 前期调研结论

调研日期：2026-09-29
调研方式：Opus 5.5 子 agent 读源码和官方文档，Fable 5.1 汇总并在本机日志上交叉验证。

标注约定：
- **【本机实测】** 在本机 `~/.claude` 日志上跑过脚本验证
- **【源码】** 调研员读过对应项目源码
- **【官方文档】** 调研员核对过 code.claude.com/docs 原文，汇总者未逐条复核
- **【推断】** 根据材料推理，未验证

---

## 1. 结论

项目值得做，但主打点要从"agent 树可视化"改为**"检查 agent 配置是否真的生效"**。

原因：agent 树和按 agent 统计 token 已经有项目做了，一致性检查在读过的 14 个项目里没有任何一个做。

### 差异点

| 差异点 | 说明 | 竞争情况 |
|---|---|---|
| 一致性检查 | 预设的模型和 effort 对比实际运行值，并解释不一致的原因 | 14 个项目全都没有 |
| advisor 可观测 | 配置了但从未触发、被静默停用 | 只有 ccusage 计入 token，没有调用级视图 |
| 零配置 | 不装 hook，不改 `settings.json`，能看历史会话 | Agent-Monitor、agents-observe 都依赖 hook |
| 精确的树 | 用 `toolUseId` 确定性关联，不靠猜 | Agent-Monitor 靠启发式；claude-code-log 数据层做到了但没有独立树视图 |
| 树与统计合一 | 树节点上直接显示统计，支持子树汇总 | agents-observe 两者分离，统计表是扁平的 |
| 原生子 agent 配置管理 | 图形化编辑 `~/.claude/agents/*.md` | 没有项目做。cc-switch 留了"Coming Soon"占位页 |
| 桌面形态 | 无需 Docker、无需命令行 | agents-observe 默认要 Docker |

### 已不是独有的

| 功能 | 已实现的项目 |
|---|---|
| agent 树 | Claude-Code-Agent-Monitor、agents-observe（径向图）、claude-code-log（内联在对话流） |
| 按 agent 全程累计 token | Claude-Code-Agent-Monitor、agents-observe、tokscale（平铺分组） |
| 用量看板、托盘、额度页 | TokenTracker、cc-switch |

---

## 2. 本机实测结果

### 2.1 数据位置

| 数据 | 位置 |
|---|---|
| 主会话日志 | `~/.claude/projects/<项目>/<sessionId>.jsonl` |
| 子 agent 日志 | `~/.claude/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl` |
| 子 agent 元数据 | 同目录 `agent-<agentId>.meta.json`，字段 `agentType`、`description`、`toolUseId`、`spawnDepth` |
| Workflow 子 agent | `subagents/workflows/wf_<id>/`（本机暂无） |
| 桌面版会话元数据 | `%APPDATA%\Claude\claude-code-sessions\`，含 `title`、`model`、`effort`、`cliSessionId` |
| 桌面版额度历史 | `%APPDATA%\Claude\plan-usage-history.json` |

### 2.2 桌面版与命令行

本机 54 个会话的 `entrypoint` 全部是 `claude-desktop`。桌面版 Code 标签页和命令行是同一引擎，日志位置和格式相同。

未验证：本机没有纯命令行会话，"命令行格式相同"未做逐字段比对。

### 2.3 agent 树可以离线精确还原

对本机全部 31 个子 agent 测试，用 `meta.json` 的 `toolUseId` 去匹配工具调用：

| 结果 | 数量 |
|---|---|
| 父调用在主会话里找到 | 24 |
| 父调用在另一个子 agent 里找到（嵌套） | 7 |
| 找不到父调用 | 0 |
| `spawnDepth` 与实际位置不符 | 0 |

**31 个全部确定性关联成功，不需要 hook，不需要猜。**

### 2.4 子 agent 返回结果里的 token 数不是累计值

| 子 agent | 请求次数 | 返回结果里的 `totalTokens` | 全程实际累计 | 相差 |
|---|---|---|---|---|
| Explore | 48 | 148,959 | 4,792,371 | 32 倍 |
| Plan | 11 | 96,435 | 628,151 | 6.5 倍 |
| Explore | 4 | 41,057 | 145,263 | 3.5 倍 |

`totalTokens` 精确等于最后一次请求的用量。另外该会话 11 个子 agent 中 8 个是后台运行，返回结果里没有任何用量字段。

**按 agent 统计必须逐个读子 agent 日志累加。**

### 2.5 去重

| 验证项 | 结果 |
|---|---|
| `message.id` 与 `requestId` | 一一对应，用哪个做键都行 |
| 不去重的虚高程度 | 主会话 2.6 倍，子 agent 最高 5 倍 |
| 多行记录中数值不同的比例 | 1268 个多行请求中 73 个 |
| 哪一条是最大值 | 最后一条 100%，第一条 94% |
| 最后一条带结束标记的比例 | 161/1268 |

**规则：同一请求取各字段最大值。不要用"优先保留有结束标记的"，该信号不可靠。**

### 2.6 缓存写入分两档

主会话全部是 1 小时缓存，子 agent 全部是 5 分钟缓存。两档单价不同，必须分开计价。

### 2.7 advisor

- `advisorModel` 字段出现在每条 assistant 记录上（39 个文件 8998 处），表示"配置的是谁"，不代表发生了调用
- 实际调用记录在 `message.usage.iterations[]` 中 `type` 为 `advisor_message` 的条目
- 本机全部日志中 `iterations` 的类型只有 `message`，**advisor 从未被真正调用过**

### 2.8 桌面版配置不走 settings.json

本机 `settings.json` 的 `effortLevel`、`model`、`advisorModel` 都是空的，但日志里每条记录都有明确的值。52 个会话的元数据与日志全部能对上，50 个完全一致，2 个中途换过模型或 effort（元数据只保留最后一次）。

**一致性检查必须以日志为准。**

### 2.9 额度历史文件

| 项目 | 实测 |
|---|---|
| 采样间隔 | 15 分钟 |
| 保留时长 | 7 天 |
| `u.fh` | 0~88，周期性归零 |
| `u.sd` | 0~35，缓慢上升 |

【推断】`fh` 是 5 小时窗口已用百分比，`sd` 是 7 天窗口已用百分比。无官方文档佐证。

### 2.10 其他字段

- 归属字段：`attributionAgent`、`attributionMcpServer`、`attributionMcpTool`
- 每条记录带 `effort`、`version`、`cwd`、`gitBranch`、`entrypoint`
- 后台子 agent 的返回结果带 `agentId`、`resolvedModel`、`outputFile`，不带用量

---

## 3. 官方机制【官方文档】

### 3.1 子 agent 模型的决定顺序

1. 调用时传入的 `model` 参数
2. 配置文件 frontmatter 的 `model`
3. 环境变量 `CLAUDE_CODE_SUBAGENT_MODEL`
4. 主会话的模型

特殊情况：
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 强制所有子 agent 用同一模型
- v2.1.251 之前，环境变量排第一位

### 3.2 effort 的决定顺序

1. 环境变量 `CLAUDE_CODE_EFFORT_LEVEL`（最高，frontmatter 盖不过它）
2. frontmatter 的 `effort`
3. 会话级 effort

另外受 `maxEffortLevel` 上限约束；模型不支持该级别时自动降级。

### 3.3 effortLevel 的写入位置

Opus 5.5 及之后的模型会忽略 `settings.json` 顶层的 `effortLevel`，改看 `modelSettings.<模型>.effortLevel`。

### 3.4 合法的不一致

以下情况实际值和配置值不同是正常的，不能误报：
- 模型别名解析成精确模型名
- `[1m]` 后缀
- `availableModels` 拦截后替换
- effort 自动降级

### 3.5 frontmatter 字段

`name`、`description`、`tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`memory`、`background`、`omitClaudeMd`、`effort`、`isolation`、`color`、`initialPrompt`、`experimental.cacheTtl`

`model` 可取：`sonnet`、`opus`、`haiku`、`fable`、完整模型 ID、`inherit`

定义文件优先级：Managed > `--agents` > 项目 `.claude/agents/` > `~/.claude/agents/` > 插件

### 3.6 advisor 不可用的情况

- 不走 Anthropic API
- 模型组合被拒
- `availableModels` 排除了 advisor 模型
- 关闭了 feature flag 拉取（如设了 `DISABLE_TELEMETRY`）
- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`
- API 拒绝某组合后，该会话剩余部分**静默**停用，直到 `/clear` 或 `/compact`

### 3.7 其他

- 日志默认 30 天后自动删除（`cleanupPeriodDays`）
- 子 agent 默认后台运行（v2.1.198 起）
- 默认最多嵌套 3 层、20 个并发
- 日志格式是内部格式，官方声明可能随版本变化
- hooks 有 `SubagentStart`、`SubagentStop` 事件，带 `agent_id`、`agent_type`，但不带 token 和父 id

---

## 4. 竞品对照【源码】

| 项目 | Star | 形态 | agent 树 | 按 agent 累计 | 一致性检查 | 采集方式 |
|---|---|---|---|---|---|---|
| opcode | 22412 | Tauri 桌面 | 无 | 无 | 无 | 自己启动 CLI + 读日志 |
| ccusage | 18776 | 命令行 | 无 | 无 | 无 | 读日志 |
| Claude-Code-Usage-Monitor | 8728 | 终端界面 | 无 | 无 | 无 | 读日志 |
| agentsview | 6010 | Tauri 桌面 | 无 | 无 | 无 | 读日志 |
| tokscale | 5567 | 终端 + 网页 | 无 | 有，平铺 | 无 | 读日志 |
| claude-code-history-viewer | 2207 | Tauri 桌面 | 无 | 无 | 无 | 读日志 |
| TokenTracker | 1782 | 网页 + 托盘 | 无 | 无 | 无 | 读日志，hook 触发同步 |
| disler 的 observability | 1544 | 本地网页 | 无 | 无 | 无 | hooks |
| claude-code-viewer | 1289 | 本地网页 | 无 | 无 | 无 | 读日志 + SDK |
| claude-code-log | 1232 | 命令行出静态页 | 部分，内联 | 部分，用非累计值 | 无 | 读日志 |
| Claude-Code-Agent-Monitor | 1017 | Electron 桌面 | **有** | **有** | 无 | hooks + 读日志 |
| agents-observe | 684 | 插件 + 网页 | **有**，径向图 | **有** | 无 | hooks + 读日志 |
| claude-code-otel | 506 | Docker | 无 | 无 | 无 | OpenTelemetry |
| claude-view | 110 | 本地网页 | 无 | 无 | 无 | 读日志 + hooks |
| cc-switch | — | Tauri 桌面 | 无 | 无 | 无 | 代理 + 读日志 |

### 最接近的三个竞品及其弱点

**Claude-Code-Agent-Monitor**
- 必须安装 8 个 hook
- 父子关系靠启发式：挂到"当前最深的正在运行的 agent"下，并行同类型时会挂错
- 子 agent 结束匹配是模糊的
- 不使用 `meta.json` 的 `toolUseId` 和 `spawnDepth`
- 没有请求次数、advisor、effort

**agents-observe**
- 父子关系靠 hook 推导，插件安装前的历史会话建不了树
- 树节点上没有统计数字，统计表是扁平的
- 每个子 agent 只记第一个模型
- 拿不到日志时退回使用非累计值
- 默认需要 Docker

**claude-code-log**
- 数据层最完整：读 `meta.json`、支持任意深度嵌套、后台、并行
- 但没有独立的 agent 树视图，只是内联在对话流里
- 直接显示 Claude Code 给的 `total_tokens`，即 2.4 节证实偏低的那个值
- 只是命令行工具，输出静态页面

### 关于 opcode 和 cc-switch

- opcode 的"CC Agents"是它自己数据库里的另一套概念，以顶层会话方式运行，与原生 `~/.claude/agents/*.md` 无关。代码自 2025-10 起停更
- cc-switch 不读 `~/.claude/agents/`，不管 `effortLevel`。前端有 `AgentsPanel.tsx` 占位页

---

## 5. 可借鉴的实现

### 5.1 日志解析

| 做法 | 来源 |
|---|---|
| 字节偏移量增量读取，只处理到最后一个完整换行 | cc-switch |
| 判断文件是否变化要同时看修改时间和大小（Windows 上持续追加时修改时间可能不更新） | cc-switch |
| 尾部指纹检测文件被重写 | cc-switch |
| 固定深度扫描三层：主会话、`subagents/`、`subagents/workflows/wf_*/` | cc-switch |
| 跳过 `subagents/**/journal.jsonl` | tokscale |
| 任一计费项大于 0 就计入（过严会少算约 4%，92% 集中在子 agent） | cc-switch |
| 去重时逐字段取最大值 | tokscale |
| 无 `requestId` 时键改为 `message.id + sessionId + timestamp` | ccusage |
| 子 agent 文件里重放的父会话记录要丢弃 | ccusage |
| 解析要宽松：未知字段忽略，空值不丢整行 | ccusage 的反面教训 |
| `<synthetic>` 模型的记录不计入 | ccusage |
| 后台子 agent 的完成信号是主会话里的任务通知消息 | claude-view、claude-code-log |
| 会话列表只读头 10 行和尾 30 行 | cc-switch |

性能参考：12MB 文件全量解析 6 秒，增量读 9 毫秒。

### 5.2 价格计算

| 做法 | 来源 |
|---|---|
| 分层兜底：内嵌快照 → 磁盘缓存 → 在线 LiteLLM → 用户覆盖 | ccusage |
| 1 小时缓存写入 = 输入价 × 2，5 分钟 = 输入价 × 1.25，缓存读 = 输入价 × 0.1 | ccusage |
| 模型名先归一化再匹配：去日期后缀、`[1m]`、effort 后缀、云厂商前缀 | cc-switch |
| 未知模型记 0 并明确标记，不猜价 | ccusage |
| 金额用十进制存储，不用浮点 | cc-switch |

### 5.3 5 小时窗口

ccusage 的算法：首条记录时间向下取整到整点作为起点；距起点超过 5 小时或距上一条超过 5 小时则开新窗口。

额度数据优先用桌面版的 `plan-usage-history.json`，不要像 TokenTracker 那样读用户凭据调非公开接口。

### 5.4 配置文件写入

cc-switch 踩过的坑和最终方案：

| 规则 | 原因 |
|---|---|
| 只声明自己管哪几个字段，其余一个字节不动 | 整文件覆盖会抹掉用户的 hooks、插件、权限设置 |
| 解析失败就拒写，并提示行列号 | cc-switch 曾在解析失败后从空文档开始写，清空了用户配置 |
| 保留缩进、换行符、BOM、字段顺序 | 重新序列化会打乱用户文件 |
| 首次写入前备份原件 | 兜底 |
| 临时文件 + 原子替换 | 防止写到一半崩溃 |
| 写入前重读比对哈希 | Claude Code 自己也会写这些文件 |
| Windows 原子替换失败时回退到重命名 | WSL 路径不支持原子替换接口 |
| 取用户目录不要读 `HOME` 环境变量 | Git Bash 会注入错误的值 |
| 支持 `CLAUDE_CONFIG_DIR` | cc-switch 缺这项 |

claude-view 的反面例子：`settings.json` 解析失败时直接重置为空。

### 5.5 与 cc-switch 共存

cc-switch 切换供应商时会覆盖 `model`、`advisorModel`、`CLAUDE_CODE_SUBAGENT_MODEL`。检测方法：`~/.cc-switch/live-state.json` 是否存在，`ANTHROPIC_BASE_URL` 是否指向 `127.0.0.1:15721`。

`effortLevel` 它不管，不会冲突。

### 5.6 技术栈参考

cc-switch：Tauri 2 + React 18 + TypeScript + Tailwind + shadcn + SQLite + recharts，状态管理用 TanStack Query，后端事件防抖后通知前端刷新。

---

## 6. 建议的开发顺序

1. **只读看板**：会话列表 → agent 树 → 按 agent 统计 → 一致性检查。不改任何文件
2. **实时状态**：轮询当前会话文件，间隔 1~2 秒
3. **配置写入**：子 agent 的模型和 effort、CLAUDE.md 规则、环境变量检查。写入前显示差异并备份

技术栈：先用 Node + React 做本地网页版验证解析逻辑，再用 Tauri 套壳。

数据层：SQLite 保存全部解析结果，只增不删。核心只依赖 `~/.claude/projects/`，检测到桌面版目录时叠加会话标题和额度历史。

---

## 7. 尚未验证

| 事项 | 影响 |
|---|---|
| 纯命令行产生的日志与桌面版是否逐字段相同 | 解析器兼容性 |
| 桌面版会话级设置与 `settings.json` 的优先级 | 配置功能怎么设计 |
| advisor 真实调用在日志里的完整结构 | 本机无样本，需要触发一次 |
| 会话恢复或压缩时是否原地改写日志 | 来自 tokscale 的 issue，未证实 |
| `plan-usage-history.json` 的字段含义 | 目前是根据数值规律推断 |
| 桌面版 Cowork 模式的日志格式 | `local-agent-mode-sessions\` 未查看 |
| 官方文档各条规则 | 汇总者未逐条复核原文 |


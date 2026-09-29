# agentree 第二阶段规格：配置管理

## 目标

让用户在界面上完成原本要手动改文件的事：

1. 管理子 agent 定义文件（新建、编辑、改名、删除）
2. 设置主模型、advisor 模型、effort
3. 往 CLAUDE.md 里加一条"什么时候咨询 advisor"的规则
4. 把预设（期望的 agent 树）一键应用到 Claude Code 配置
5. 提供现成的方案模板，一键填好预设

第一阶段是只读的。这一阶段开始写用户的 Claude Code 配置，**安全是第一位的**。cc-switch、claude-view 都出过清空用户配置的事故，下面的规则都是针对这些事故定的，不能省略。

## 核心原则

### 1. 两步提交，没有直接写入

所有修改都是：生成计划 → 用户看差异 → 确认后应用。

- `POST /api/config/plan` 只计算，不写任何文件
- 返回每个文件修改前后的完整内容，前端显示差异
- `POST /api/config/apply` 才真正写入
- 计划保存在内存里，10 分钟过期，应用一次后作废

### 2. 只改自己管的部分

| 文件 | agentree 管什么 | 其余部分 |
|---|---|---|
| `settings.json` | `model`、`advisorModel`、`effortLevel`、`modelSettings.<模型>.effortLevel` | 一个字节都不动 |
| agent 定义 `.md` | frontmatter 的 `name`、`description`、`model`、`effort`、`tools`；正文（仅当用户编辑了正文） | 其他 frontmatter 字段原样保留，包括顺序和注释 |
| `CLAUDE.md` | 两个标记之间的规则块 | 标记之外的内容一个字节都不动 |

### 3. 解析失败就拒绝

文件解析不了时，计划标记为 `blocked`，给出行列号，**绝不从空文档开始写**。

- `settings.json` 不是合法 JSON
- `settings.json` 的根不是对象
- 要修改的位置类型不对（如 `modelSettings` 是字符串）
- agent 定义文件的 frontmatter 格式异常
- 文件不是 UTF-8

### 4. 保留原有格式

- JSON：保留缩进风格、键的顺序、行尾符（CRLF 或 LF）、末尾是否有换行、UTF-8 BOM。用基于文本位置的修改方式（如 `jsonc-parser` 的 `modify` 加 `applyEdits`），不要 `JSON.parse` 后再 `JSON.stringify`
- frontmatter：按行修改，只替换或增删对应的行。不要用 YAML 库重新序列化整个 frontmatter
- 新增的键追加在所在对象的末尾

### 5. 写入流程

每个文件按这个顺序：

1. 读取文件，计算 sha256
2. 和计划里的 `baseHash` 比对。不一致说明文件在生成计划之后被别人改过，这个文件失败，提示用户重新生成计划
3. 如果是 agentree 第一次修改这个文件，做首写备份
4. 做本次修改前的备份
5. 写到同目录的临时文件，刷盘
6. 再次读取原文件比对 hash（防止第 2 步之后又被改）
7. 重命名临时文件覆盖原文件。Windows 上重命名失败时重试 3 次，每次间隔 100 毫秒

一个计划里有多个文件时逐个处理，某个失败不影响已成功的，但后面的不再继续。结果里如实列出哪些成功、哪些失败。

### 6. 备份

备份目录：`os.homedir()/.agentree/backups/`

| 类型 | 时机 | 保留 |
|---|---|---|
| 首写备份 | agentree 第一次修改某个文件之前 | 永久 |
| 变更前备份 | 每次修改之前 | 每个文件最近 20 份 |

每份备份旁边有一个元数据文件，记录原路径、时间、原文件当时是否存在。

恢复备份也要走计划和应用两步，恢复前会对当前状态再做一次备份。

### 7. 删除不是真删除

删除 agent 定义文件时，把文件移到备份目录，可以恢复。不做永久删除。

### 8. 写入范围白名单

后端只允许写这些路径，其他一律拒绝：

- `<configDir>/settings.json`
- `<configDir>/CLAUDE.md`
- `<configDir>/agents/<name>.md`
- `<projectCwd>/.claude/agents/<name>.md`，其中 `projectCwd` 必须是索引里出现过的会话工作目录

路径处理：
- 解析成绝对路径后再判断，防止 `..` 穿越
- 如果目标或其父目录是符号链接，解析真实路径后必须仍在白名单内
- agent 名字只允许 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
- Windows 保留名（`CON`、`NUL`、`COM1` 等）拒绝

### 9. 防止其他网页调用写接口

后端监听本机端口，用户浏览器里的任何网页都能向它发请求。如果不防护，恶意网页可以往用户的 agent 定义里写入任意系统提示词。

- 后端启动时生成一个随机令牌
- `GET /api/token` 返回令牌。这个接口不设置任何跨域允许的响应头，所以其他来源的网页读不到
- 所有非 GET 的接口必须带请求头 `X-Agentree-Token`，值不对返回 403
- 所有非 GET 的接口要求 `Content-Type: application/json`，其他类型返回 415
- 请求带了 `Origin` 头且不是本机来源的，返回 403
- 不设置任何 `Access-Control-Allow-*` 响应头

## 各项功能的细节

### agent 定义文件

格式：

```markdown
---
name: explorer
description: 只读地查找和阅读代码
model: opus
effort: medium
tools: Read, Grep, Glob
---

正文是系统提示词
```

- `name` 和文件名保持一致。改名时文件也改名，旧文件进备份
- 新建时目录不存在就创建
- 同名文件已存在时，新建操作失败，提示用户改为编辑
- `model`、`effort`、`tools` 传 null 时删除这一行
- frontmatter 里的值含有冒号、井号等特殊字符时要加引号
- `description` 可能是多行，读取时要能处理 YAML 的多行写法；写入时统一写成单行加引号
- 内置类型（`general-purpose`、`Explore`、`Plan` 等）的名字不能用来新建，给出提示：内置类型无法通过定义文件修改

### settings.json

文件不存在时新建，内容只有要写的键。

**effort 写在哪里**（已核对官方文档原文）：

- 用户级 `settings.json` 顶层的 `effortLevel`，对 Opus 5、Fable 5.1 及更早的模型有效
- **Opus 5.5 及之后的模型会忽略顶层的 `effortLevel`**，要写在 `modelSettings.<模型 ID>.effortLevel`
- `modelSettings` 的准确结构请查官方文档副本，不要猜
- `effortLevel` 和 `modelSettings` 里的 effort 只接受 `low`、`medium`、`high`、`xhigh`，不接受 `max`。用户选了 `max` 时计划里给出错误

`settings.effort` 动作的处理：

| `model` 参数 | 写到哪里 |
|---|---|
| null | 顶层 `effortLevel` |
| 某个模型 ID | `modelSettings.<模型 ID>.effortLevel` |

写顶层 `effortLevel` 时，在计划的 `notes` 里提示：这个设置对 Opus 5.5 及之后的模型不生效。

**依据的官方文档**（https://code.claude.com/docs ）： `settings-reference.md`、`settings.md`、`model-config.md`、`sub-agents.md`、`advisor.md`、`env-vars.md`。

### 必须给用户的提示

以下情况要在计划的 `notes` 里说明：

| 情况 | 级别 | 说明 |
|---|---|---|
| 修改了 `settings.json` 里的模型、effort 或 advisor | warn | 本机的会话都是从桌面版启动的，桌面版在界面上按会话选择模型和 effort。这些设置对命令行启动的会话有效，对桌面版是否生效尚未验证 |
| 检测到 cc-switch | warn | cc-switch 切换供应商时会覆盖 `model` 和 `advisorModel` |
| 设置了 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量 | warn | 它会覆盖所有 effort 设置，包括 agent 定义文件里的 |
| 设置了 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | warn | 所有子 agent 会被强制使用同一个模型，定义文件里的 model 不生效 |
| 设置了 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` | warn | advisor 被禁用，`advisorModel` 设置不生效 |
| 修改了 agent 定义文件 | info | 已经在运行的会话不会受影响，新开的会话才会用新的定义 |

**环境变量只报告，不修改。**

### CLAUDE.md 规则

规则块用标记包起来：

```markdown
<!-- agentree:advisor-rule:start -->
## 何时咨询 advisor

- 动手做一个大的计划之前，先问 advisor 这个方向对不对
- 同一个错误第二次出现时，问 advisor 是不是走错了路
- 宣布一个耗时长的任务完成之前，问 advisor 有没有遗漏
<!-- agentree:advisor-rule:end -->
```

- 启用：文件里没有规则块就追加到末尾（和原内容之间空一行）；已有就替换两个标记之间的内容
- 停用：删除两个标记和之间的内容，以及因此多出来的空行
- 文件不存在时，启用会新建文件
- 只有开始标记没有结束标记，或者标记出现多次：计划标记为 `blocked`，请用户手动处理
- 默认文案就是上面这段

### 应用预设

`preset.apply` 动作把预设展开成具体的修改：

| 预设内容 | 展开成 |
|---|---|
| `main.model` 不为 null | 写 `settings.json` 的 `model` |
| `main.effort` 不为 null | `main.model` 是 Opus 5.5 及之后的完整 ID 时写 `modelSettings`；是别名或其他模型时写顶层 `effortLevel` 并给出提示 |
| `advisor.model` 不为 null | 写 `settings.json` 的 `advisorModel` |
| `agents` 里的每一项 | 用户级定义文件已存在：只改 `model` 和 `effort`。不存在：用模板新建 |
| `includeRule` 为 true | 启用 CLAUDE.md 规则 |

- 预设里为 null 的项不修改，保持现状
- `agents` 里的名字是内置类型的：跳过，在 `notes` 里说明
- 预设里没有列出的现有定义文件：不删除、不修改
- 对同一个文件的多项修改合并成一个 `FileChange`

**新建 agent 时的模板**：

| 名字 | 描述 | 工具 | 正文要点 |
|---|---|---|---|
| `explorer` | 只读地查找和阅读代码，回答"某某在哪里""某某是怎么实现的" | Read, Grep, Glob | 只读不改；回答要给出文件路径和行号；说清楚哪些是确认过的、哪些是推测 |
| `worker` | 按明确的要求修改代码并运行测试 | 不限制 | 只改任务要求的范围；改完运行相关测试；如实报告测试结果 |
| `researcher` | 查阅文档和资料，回答技术问题 | Read, Grep, Glob, WebFetch, WebSearch | 以官方文档为准；标明出处；查不到就说查不到 |
| 其他名字 | 由用户填写 | 不限制 | 一段通用的说明，提醒用户去编辑 |

### 方案模板

`GET /api/config/templates` 返回内置模板。第一版只有一个：

| 字段 | 值 |
|---|---|
| id | `opus-main-fable-advisor` |
| 名称 | Opus 5.5 主力 + Fable 5.1 顾问 |
| 说明 | 主会话用 Opus 5.5 高强度运行，三个子 agent 分别负责读代码、改代码、查文档，用 Opus 5.5 中等强度；Fable 5.1 作为顾问，在关键节点给建议 |
| main | model `claude-opus-5-5`，effort `high` |
| advisor | model `fable` |
| agents | `explorer`、`worker`、`researcher`，都是 model `opus`、effort `medium` |
| allowBuiltins | true |
| includeRule | true |

模板只用来填表单。用户选了模板后仍然要自己点保存和应用。

## 界面

### 新增"配置"页

| 区域 | 内容 |
|---|---|
| 子 agent | 列表显示所有定义文件，分用户级和项目级。可以新建、编辑、改名、删除。编辑界面有描述、模型、effort、工具、正文 |
| 主会话与 advisor | 当前的主模型、effort、advisor 模型，可以修改 |
| CLAUDE.md 规则 | 开关，可以编辑规则文案 |
| 环境变量 | 检查结果，只读 |
| 备份 | 备份列表，可以恢复 |

### 预设页的改动

- 顶部加"从模板开始"，选模板后填进表单
- 加"应用到 Claude Code"按钮，旁边有"同时写入 CLAUDE.md 规则"的勾选
- 原来的说明文字要改：保存预设仍然只存在 agentree 自己的目录；点"应用到 Claude Code"才会修改 Claude Code 的配置

### 差异确认对话框

所有修改在应用之前都要经过这个对话框：

- 列出每个要改的文件：路径、操作类型（新建、修改、删除）、一句话说明
- 每个文件可以展开看逐行差异，增加的行和删除的行用不同颜色
- 新建的文件显示完整内容
- 所有 `notes` 按级别显示在顶部
- `blocked` 时显示错误原因，"应用"按钮不可用
- 按钮文字是"应用这 N 项修改"，不要用含糊的"确定"
- 应用后显示结果：哪些成功、哪些失败、备份在哪里
- 部分失败时要明确显示，不能只显示成功

### 编辑冲突

编辑 agent 定义时，如果文件在打开之后被别的程序改过（hash 不一致），提示用户，提供"重新加载"选项，不要直接覆盖。

## 测试要求

**所有会写文件的测试都必须用环境变量 `CLAUDE_CONFIG_DIR` 指向临时目录，用 `AGENTREE_HOME` 指向临时的 agentree 数据目录。绝对不能对真实的 `~/.claude` 做任何写入。**

必须覆盖的情况：

| 场景 | 期望 |
|---|---|
| `settings.json` 有用户自己的 `hooks`、`permissions`、`env` | 修改后这些内容逐字节不变 |
| `settings.json` 用 Tab 缩进 | 修改后仍然是 Tab |
| `settings.json` 用 CRLF 换行 | 修改后仍然是 CRLF |
| `settings.json` 有 BOM | 修改后仍然有 BOM |
| `settings.json` 末尾没有换行 | 修改后仍然没有 |
| `settings.json` 是非法 JSON | 计划 blocked，文件没有被改动 |
| `settings.json` 不存在 | 新建，只含要写的键 |
| 生成计划后文件被外部修改 | 应用失败，文件保持外部修改后的内容 |
| agent 定义有 agentree 不认识的 frontmatter 字段 | 保留，顺序不变 |
| agent 定义的正文含有 `---` | 不会被误认为 frontmatter 的边界 |
| agent 改名 | 新文件存在，旧文件进了备份 |
| 删除 agent | 文件进了备份，可以恢复 |
| CLAUDE.md 已有用户内容 | 追加规则后原内容逐字节不变 |
| CLAUDE.md 规则启用后再停用 | 文件恢复成和启用前逐字节相同 |
| CLAUDE.md 只有开始标记 | 计划 blocked |
| 路径穿越（名字含 `..`、斜杠） | 拒绝 |
| 写入白名单外的路径 | 拒绝 |
| 没带令牌调用写接口 | 403 |
| 用 `text/plain` 调用写接口 | 415 |
| 带了外部 `Origin` 调用写接口 | 403 |
| 同一个计划应用两次 | 第二次失败 |
| 过期的计划 | 失败 |
| 首写备份 | 第一次修改前生成，之后的修改不会覆盖它 |
| 恢复备份 | 文件内容和备份逐字节相同 |

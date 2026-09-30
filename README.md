# agentree

给 Claude Code 搭自己的 agent 方案，并且看清它到底有没有按方案跑。

A local desktop tool for Claude Code: build your own agent setup on a node canvas, write it to Claude Code's config, then verify from the logs whether real sessions actually followed it.

- **搭**：在节点画布上搭出主会话、advisor 和子 agent，写清楚每个子 agent 什么时候用、能用哪些工具、怎么干活
- **写**：一键写入 Claude Code 的配置。写之前显示逐行差异，写之前自动备份
- **验**：读 Claude Code 的本地日志，告诉你每个子 agent 有没有被加载、有没有被派发、用的模型对不对
- **看**：每个会话分出了多少子 agent、各用了什么模型、花了多少 token

只读本地日志，不装 hook，不改网络配置，不上传任何数据。命令行和桌面版的会话都支持。

## 运行要求

| 要求 | 说明 |
|---|---|
| Node.js 24 或更高 | 用到了 Node 自带的 SQLite。只用构建好的便携版时不需要 |
| Claude Code | 命令行或桌面版，用过之后才有日志可读 |
| Windows 10 / 11 | 在 Windows 上开发和测试。macOS 和 Linux 的路径已经做了处理，但没有实际测试过 |
| Rust | 只有构建桌面应用时需要，用浏览器打开不需要 |

## 启动

```bash
git clone https://github.com/ftweg2/agentree.git
cd agentree
npm start
```

第一次运行会自动安装依赖并构建界面，然后在浏览器里打开 `http://127.0.0.1:4777`。

### 桌面应用（可选）

想要独立窗口和托盘图标，可以构建桌面应用：

```bash
npm --prefix desktop install
npm run desktop:build
```

构建出的程序在 `desktop/src-tauri/target/release/agentree.exe`，双击运行。点窗口的关闭按钮会隐藏到托盘，从托盘菜单选"退出"才真正退出。

桌面应用有两种构建，界面和功能完全一样，区别在于运行时依赖什么：

| | `npm run desktop:build` | `npm run portable`（便携版） |
|---|---|---|
| 成品 | `desktop/src-tauri/target/release/agentree.exe`，约 7 MB | `release/agentree-portable.exe`，约 33 MB |
| 运行时需要 | 项目文件夹里的 `server` 和 `web`，以及机器上的 Node.js 24 | 只需要系统自带的 WebView2 |
| 能不能拷到别处 | 不能。它只是外壳，移动了项目文件夹之后要重新构建，或者设置环境变量 `AGENTREE_ROOT` 指向新位置 | 能，拷到任何一台 Windows 10/11 x64 电脑上双击即用 |
| 适合 | 开发。改了代码退出再打开就生效 | 给别人用，或者自己在没有项目代码的电脑上用 |

更新代码之后要退出再重新打开，新的后端才会生效。忘了重启时界面顶部会有提示。便携版里的后端是构建时打包进去的，改了代码要重新执行 `npm run portable`。

### 便携版

```bash
npm run setup
npm --prefix desktop install
npm run portable
```

构建需要 Node.js 24 和 Rust，而且要在 Windows x64 上执行：exe 里带的 node.exe 就是执行构建的那个 Node。脚本会构建前端、把后端打成单个文件、和 node.exe 一起压缩后嵌进 exe，最后打印成品的大小和 SHA256。编译用的是独立的 `desktop/src-tauri/target-portable` 目录，不会覆盖 `desktop:build` 的成品。第一次构建会下载 Node.js 对应版本的许可证文本，一起放进 exe。

使用：

- 把 `agentree-portable.exe` 拷到任意位置，双击运行，不用安装。
- 需要 Microsoft Edge WebView2 运行时。Windows 11 自带，Windows 10 绝大多数也已经装了；没有的话启动时会弹出英文提示"Could not find the WebView2 Runtime"，到微软官网下载"常青版"安装即可。
- 第一次启动会把内置的运行环境（node.exe、后端、前端，约 95 MB）解压到 `%LOCALAPPDATA%\agentree\runtime\<版本哈希>\`，加载页上显示"正在准备运行环境"，之后启动直接复用。换了新版本的 exe 会解压到新目录，旧目录在启动后自动清理。环境变量 `AGENTREE_RUNTIME_DIR` 可以改解压位置。
- 数据和命令行、普通桌面版一样：agentree 自己的数据在 `~/.agentree`，读取和写入的是 Claude Code 的配置目录（默认 `~/.claude`）。便携版和普通桌面版不能同时开着（同一个端口）。
- 彻底删除：从托盘菜单退出，然后删掉 exe、`%LOCALAPPDATA%\agentree` 和 `~/.agentree`。窗口位置记在 `%APPDATA%\com.agentree.desktop`，浏览器缓存在 `%LOCALAPPDATA%\com.agentree.desktop`，也可以一起删掉（普通桌面版也用这两个目录）。

有的杀毒软件会对"从 exe 里解压出另一个 exe 并运行"的程序报警或拦截，这时要把解压目录加进白名单。

## 功能

| 页面 | 内容 |
|---|---|
| 总览 | 各模型的请求次数和 token、各 agent 类型的用量、每日趋势、订阅额度 |
| 实时 | 当前活跃的会话，正在运行的 agent 和它在用的工具 |
| 会话 | 会话列表；点进去是一张节点画布，显示这次对话实际派生出的 agent 树 |
| 搭建 | 节点编辑器：搭出自己的 agent 方案，写入 Claude Code，再看它有没有生效 |
| 配置 | 按文件管理子 agent 定义、主模型和 advisor、CLAUDE.md 规则、备份 |

### 画布的操作

| 操作 | 效果 |
|---|---|
| 拖动节点 | 移动节点，位置会记住 |
| 拖动空白处 | 平移画布 |
| 滚轮 | 以鼠标位置为中心缩放 |
| 点节点 | 会话页里打开详情；搭建页里打开右侧的编辑面板 |
| 从接口拖出连线 | 搭建页：把节点接到主会话。拖到空白处可以直接新建子 agent |
| 双击或右键空白处 | 搭建页：添加节点 |
| 点连线 | 搭建页：选中连线，点中间的 × 或按 Delete 断开 |
| Delete | 搭建页：删除选中的节点或连线 |

搭建页里只有连到主会话的节点才属于方案，没连上的节点是草稿，画成虚线。

### 搭建一个子 agent

一个子 agent 由四样东西决定，都在节点的编辑面板里填：

| 内容 | 作用 |
|---|---|
| 什么时候用它 | 主会话只看这段话来决定要不要把任务交给它 |
| 能用哪些工具 | 全部、只读、只读加联网，或者逐个勾选。还可以设置它能不能再往下派发子 agent |
| 系统提示词 | 它是谁、怎么干活、干完怎么汇报。子 agent 看不到主会话之前的对话，只能看到这段提示词和交给它的任务 |
| 模型和 effort | 不指定就跟主会话一样 |

子 agent 之间不能指定"谁派发谁"，所以所有连线都连着主会话。

允许再往下派发的子 agent 可以指定"往下派发的模型"。Claude Code 没有这样的设置，下一层的模型只能由派发时传的 model 参数决定（否则内置的 Explore 等用主会话的模型），所以 agentree 把这个要求写在它的系统提示词末尾。这是提示，不是硬性限制：搭建页的生效检查和会话页会按日志核对它每次派发实际传了什么。

自动压缩阈值是主会话和全部子 agent 共用的，不能给单个子 agent 单独设，生效检查也把子 agent 里的自动压缩算在内。

### 主会话

主会话节点上有三项设置，都是"不指定"就不写、不检查：

| 内容 | 作用 |
|---|---|
| 模型和 effort | 主会话用什么模型、多大强度 |
| 自动压缩阈值 | 上下文累积到多少 token 时 Claude Code 自动把之前的对话压缩成摘要。可选 200K、500K、800K、1M 或自定义（100K 到 1M）。不指定时用 Claude Code 的默认：1M 上下文的模型约 967K，200K 的模型 200K。设得再高也不会超过模型自己的上下文上限 |

会话页会显示每个会话被压缩了几次（自动 / 手动）以及自动压缩前的上下文大小，搭建页据此判断阈值有没有生效。

### 全局方案和项目方案

搭建页标题旁边的下拉框用来切换正在编辑的是哪份方案。

| 范围 | 对谁生效 | 写到哪里 |
|---|---|---|
| 全局方案 | 所有项目 | `~/.claude/agents`、`~/.claude/settings.json`、`~/.claude/CLAUDE.md` |
| 项目方案 | 只对在这个项目目录下开始的会话 | `<项目>/.claude/agents`、`<项目>/.claude/settings.local.json`、`<项目>/CLAUDE.md` |
| 只用一次 | 只对那一次会话 | 不写文件。"方案 → 只用一次"生成一条命令行启动命令，只能在终端里用 |

项目里实际生效的是全局方案和项目方案叠加的结果：

- 全局的子 agent 在项目里同样可用；项目里有同名的，用项目的
- 主模型、effort、advisor、自动压缩阈值：项目方案指定了就用项目的，没指定就用全局的

项目方案的画布上有一个"全局方案"节点，列出从全局继承来的内容。点某个子 agent 旁边的"改写"，会复制一份到项目里，之后的修改只影响这个项目。

没有项目方案的项目直接用全局方案。会话详情页的"对照"一栏会显示这个会话是按哪份方案检查的。

桌面版启动会话时没有"只用一次"的入口。想在桌面版里让某些会话用不同的方案，把它们放在不同的项目目录下，用项目方案。

### 让方案生效

1. 点"应用到 Claude Code"，看过每个文件的差异后确认写入。应用的方案同时成为检查标准。
2. 新开一个会话，正常使用。
3. 回到搭建页。节点上的标记会依次变成"已写入"、"已加载"、"已生效"；实际运行和方案不一样时显示"不符合"。

| 标记 | 含义 |
|---|---|
| 未写入 | 画布上的内容和 Claude Code 的配置不一样，需要应用 |
| 需手动选 | 这一项写进配置文件没有用，要自己在桌面版里选（见下） |
| 已写入 | 配置文件里已经是这个内容，之后还没有会话加载它 |
| 已加载 | 新会话的可用 agent 清单里有它了，但还没被派发过 |
| 已生效 | 被派发过，实际用的模型和 effort 符合方案。自动压缩阈值是有会话在阈值附近（50% 到 105%）自动压缩过 |
| 不符合 | 实际运行用的模型或 effort 和方案不一样。自动压缩阈值是有会话超过阈值才自动压缩，说明设置没有生效 |

自动压缩阈值要等某个会话的上下文真的达到阈值才能验证，在那之前一直显示"已写入"。

子 agent 被加载了，不等于主会话会用它：Claude Code 默认由主会话自己判断要不要派发，不告诉它分工的话，它常常从头到尾自己干。所以画布上有子 agent 时，要把"CLAUDE.md 规则"节点连到主会话。规则的默认文字按画布自动生成：列出每个子 agent 和它的描述，要求主会话把写代码、读代码、查资料这类活交给对应的子 agent，自己负责拆任务、验收和汇报；指定了 advisor 时再加上何时咨询 advisor。项目方案的规则写在项目的 CLAUDE.md 里，列的是项目里实际能用的子 agent（包括从全局方案继承的）。自己改过规则文字之后，画布上增删子 agent 就不会再自动更新这段。

画布上没应用的修改会留在本机，刷新或重启后接着改。

## 关于修改配置

agentree 修改 Claude Code 配置时遵守这些规则：

- 先生成计划，显示每个文件的逐行差异，你确认后才写入
- 只改自己管理的字段，文件里的其他内容一个字节都不动
- 文件解析失败就拒绝写入
- 每次修改前自动备份，可以在"配置 → 备份"里恢复
- 删除的文件会移到备份目录，不是永久删除

- 移除时只移除 agentree 自己写进去的内容。别的程序或你自己写的值，即使方案里没有，也不会动
- 不会自动删除任何子 agent 定义文件

"方案 → 只保存，不写入"只把方案存成检查标准，不修改 Claude Code 的配置。

### 桌面版和命令行的区别

| 配置 | 命令行 | 桌面版 |
|---|---|---|
| 子 agent 定义 | 有效 | 有效 |
| CLAUDE.md 规则 | 有效 | 有效 |
| 主模型、主会话 effort | 有效，新会话开始时读取 | **无效**。桌面版启动会话时自己指定这两项，要在发送框旁边的选择器里选 |
| advisor | 有效 | 没有验证。没生效的话可以在对话里输入 `/advisor <模型>` |
| 自动压缩阈值 | 有效，新会话开始时读取。"只用一次"的命令会带上 `--autocompact` | 没有验证。写入之后看搭建页的生效检查：有会话超过阈值才压缩就是没生效 |

不管用哪种方式，每个会话实际用的模型、effort 和压缩时机都有记录，搭建页会告诉你是不是和方案一致。

环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`DISABLE_AUTO_COMPACT`、`DISABLE_COMPACT` 和 settings 里的 `autoCompactEnabled: false` 都会让写入的自动压缩阈值失效，配置页的环境变量检查和应用时的提示会指出来。

第一次写入子 agent 定义时，`agents` 目录是新建的，已经开着的会话要重新打开才能加载。之后再修改定义文件，几秒内就会被正在运行的会话加载。

## 数据位置

| 内容 | 位置 |
|---|---|
| 索引数据库 | `~/.agentree/agentree.db` |
| 方案（检查标准） | `~/.agentree/preset.json` |
| 上次应用的记录 | `~/.agentree/applied.json` |
| 配置备份 | `~/.agentree/backups/` |
| 价格表缓存 | `~/.agentree/pricing.json` |

Claude Code 默认 30 天后清理旧日志。agentree 的索引只增不删，已经入库的统计会保留。

## 开发

```bash
npm run setup          # 安装 server 和 web 的依赖
npm run dev            # 开发模式，前后端都带热重载
npm run build          # 构建前端
npm test               # 后端单元测试
npm run desktop:build  # 构建桌面应用
npm run portable       # 构建便携版（单个 exe）
```

| 目录 | 内容 |
|---|---|
| `shared/types.ts` | 前后端共用的接口契约 |
| `server/` | Node 后端：日志解析、SQLite 存储、接口、配置写入 |
| `web/` | React 前端 |
| `desktop/` | Tauri 桌面壳 |
| `docs/research.md` | 前期调研结论 |
| `docs/spec.md` | 第一阶段规格（只读看板） |
| `docs/spec-phase2.md` | 第二阶段规格（配置管理） |

环境变量：

| 变量 | 作用 |
|---|---|
| `AGENTREE_PORT` | 端口，默认 4777 |
| `AGENTREE_HOME` | agentree 数据目录，默认 `~/.agentree` |
| `AGENTREE_ROOT` | 项目根目录。桌面应用默认记住编译时的位置，项目移动后需要设置这个变量或重新构建 |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置目录，默认 `~/.claude` |
| `AGENTREE_RUNTIME_DIR` | 便携版解压运行环境的位置，默认 `%LOCALAPPDATA%\agentree\runtime` |
| `AGENTREE_WEB_DIST` | 后端托管的前端目录，默认项目里的 `web/dist`。便携版会自动设置 |
| `AGENTREE_ALLOW_MULTI` | 设为 `1` 时桌面应用不做单实例检查，只用于开发测试（在已有实例开着时起一个测试实例，要配合不同的 `AGENTREE_PORT`） |

测试配置写入功能时，务必把 `CLAUDE_CONFIG_DIR` 和 `AGENTREE_HOME` 指向临时目录。

后端只监听 `127.0.0.1`。

## 免责说明

agentree 是个人项目，和 Anthropic 没有关系。它读取的日志格式和写入的配置格式来自 Claude Code 的公开文档和实际观察，Claude Code 升级后可能变化。

写入配置前请看清差异。每次写入前都有备份，可以在"配置 → 备份"里恢复。

## 许可证

[MIT](LICENSE)

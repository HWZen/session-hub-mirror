# AGENTS.md — 给在本仓库工作的 AI Agent

## 项目是什么

Session Hub：跨端跨 Agent 的个人会话档案库 + 检索层。只做"存得全、找得到"，零加工。
**先读 `plan.md`**——它是唯一事实源：需求、决策记录、侦察事实、风险全在里面。
`plan.md` §3 的决策已定稿，不要重新讨论；要改决策先改 plan.md。

## 开发 SOP（需求 → 计划 → 开发 → 提交）

版本号唯一事实源：**各子系统的 `package.json` 的 `version`**（当前只有服务端子系统：`server/package.json`；
子包与根编排 package.json 的 version 不维护；`/health` 与前端展示服务端版本）。
每个新需求占一个版本号，档案落在**所属子系统**的 `develop-doc/<版本号>/`
（并行开发时规划、开发、提交均在对应 worktree 内执行，见"并行开发（worktree 工作流）"）：

1. **规划阶段**（用户提需求，当次会话完成）
   - 递增所属子系统 `package.json` 的 version：新功能 +0.1（MINOR），破坏性/大重构升首位（MAJOR），小修补丁（PATCH；在所属 MINOR 线的现有 worktree 内递增，不新建分支，见下）
   - 理解需求、侦察现状，写 `<子系统>/develop-doc/<新版本号>/plan.md`：需求描述、方案、涉及文件、任务清单、验收标准
   - 全局决策仍以根 `plan.md` 为准；若需求要推翻全局决策，先改 `plan.md` 再写本版 plan
   - 此阶段**不写业务代码**
2. **开发阶段**（用户新起会话，指令形如"按 develop-doc/<版本号>/plan.md 开发"）
   - 严格按该版 plan.md 落地；完成标准：根目录 `npm test` + `npm run build` 全绿
   - 完成后写 `<子系统>/develop-doc/<版本号>/summary.md`：实际改动、与计划的偏差及原因、测试/验收结果、遗留事项
   - 提交 commit（中文，`模块: 摘要`，可拆多个），只含本版本相关文件

## 并行开发（worktree 工作流）

用户提新需求后**新建分支 + worktree，之后该需求的所有工作（规划、开发、测试、提交）都在 worktree 内进行**；
master 主工作区只保留已合并内容，不再直接开发。分支/worktree 按 MINOR 版本线建立，同一条线内的后续改动不新建（见下）。

1. 建分支与 worktree：分支名 `<版本号>-<模块名>-dev`，**版本号最后一位填 `x`**（模块名标明改动所属子系统，如 `server`、`opencode-plugin`、`collector`），worktree 放仓库内 `.worktrees/<分支名>/`（已 gitignore）：
   `git worktree add .worktrees/<分支名> -b <分支名>`（如下个服务端需求建 `.worktrees/0.19.x-server-dev`）
   一个分支/worktree 覆盖整条 MINOR 版本线：该线内的后续补充、修改、修补（PATCH，如 0.19.1、0.19.2）继续在同一分支/worktree 内进行，不新建；只有新 MINOR/MAJOR 需求（如 0.20）才新建分支/worktree。
2. worktree 初始化（gitignore 的文件不会随 worktree 出现，需从主工作区拷贝）：
   - `server/.env` → 拷贝后**必改两处**：`PORT`（避开 7428，用如 7429+）、`SH_DB_PATH`（指向本 worktree 自己的 `server/data/`）
   - `server/config/providers.local.json`（embedding 真实配置，含密钥）
   - 数据库：把主工作区 `server/data/session-hub.db` 拷到 worktree 自己的 `server/data/`；**拷贝前停掉主工作区服务端**，否则快照可能不一致；模型缓存 `server/data/models/` 不拷，会自动重建
   - **红线：两个工作区绝不能指向同一个 db 文件**（尤其 NAS 路径），各自用本地拷贝
3. 测试与运行（全在 worktree 内）：
   - `npm test` / `npm run build`（完成标准不变）
   - `npm run dev` 用 worktree 自己的 `.env` 端口；前端联调 `SH_API_PORT=<端口> npm run dev:web`（Vite 代理目标跟随该变量，默认 7428）

## 技术栈（硬约束）

- **全仓库只用 TypeScript**（服务端、采集器、opencode 插件同一种语言）
- 服务端：Node.js + Hono；SQLite（better-sqlite3 + sqlite-vec 扩展）
- 校验：zod；测试：vitest；运行：tsx（dev）/ tsc（build）
- 包管理：npm（不引入 pnpm/yarn）
- **不用 Docker**；Windows 服务化用 NSSM
- 向量模型**按提供商配置**（provider 级 `model` 字段，默认 bge-m3）；活跃模型 = weight 最高的已启用提供商的模型；索引与检索只用活跃模型的向量空间，failover 候选仅限同模型提供商；向量表按模型分表，切换模型需对活跃模型重新索引；不引入"最大上下文"配置

## 存储红线（SQLite on NAS/SMB）

数据库文件在 NAS 的 SMB 挂载上，**禁止启用 WAL**。所有连接必须经共享 DB 模块统一配置：
`journal_mode=TRUNCATE`、`synchronous=FULL`、`busy_timeout` 合理值。
新建连接点只允许出现在该共享模块里。

## 仓库结构（规划）

根目录只放**跨子系统**的全局资产（AGENTS.md / plan.md / README.md / .gitignore / npm 编排）；
每个子系统自成一个子文件夹，自带 `package.json`（版本号事实源）、`develop-doc/`、运行时数据。

```
packages/shared/      # 跨子系统契约：会话数据模型、类型、配置 schema（服务端/插件/采集器共用）
server/               # 服务端子系统
  apps/server/        #   Hono API 服务端
  apps/web/           #   Web 前端（React + Vite，服务端可静态托管其构建产物）
  config/             #   providers.json 等配置样例（真实配置 server/config/*.local.json 不入库）
  develop-doc/<版本号>/#   服务端每个需求一档：plan.md（规划）+ summary.md（完成记录）
  data/               #   运行时数据（db、模型缓存、日志，gitignore）
skills/session-hub/   # Agent Skill（SKILL.md：教外部 Agent 直调 HTTP API；接口动态发现不固化）
plugins/hermes/      # Hermes Shell hooks 插件（0.1.0：post_api_request+会话终结实时上报 + state.db 回填）
plugins/opencode/     # opencode 官方插件（TS，事件钩子上传；未建）
apps/collector/       # 采集器子系统（WorkBuddy hook 适配器已建；豆包适配器待建）
docs/                 # 运行手册（后期）
```

## 关键外部事实（速查）

| 源 | 本地存储路径 | 采集方式 |
|---|---|---|
| opencode | `~/.local/share/opencode/opencode.db`（SQLite） | 插件钩子实时；直读 DB 兜底/回填 |
| WorkBuddy | `~/.workbuddy/projects/*/*.jsonl` | **hook 实时推送为主**（Stop/SessionEnd → `apps/collector` 适配器）；文件直读兜底/回填；用户输入在 `<user_query>` 标签内，过滤 `<system-reminder`；title 首选行内 `aiTitle` |
| 豆包 | `%LOCALAPPDATA%\Doubao\User Data\Default\IndexedDB\chrome_doubao-chat_0.indexeddb.leveldb` | **实验性**；文件被锁，必须先复制再解析；独立模块可整体停用 |
| Hermes | `<profile>/state.db`（SQLite，多 profile：default / dev / qa / operations；CLI/Gateway/Desktop 全端写入） | **Shell hooks 实时**（`plugins/hermes`：`post_api_request` + 3 个会话终结事件，60s 节流 + detached worker）；state.db 只读直读兜底/回填 |

采集器对源文件**只读**；所有源会话带 `agent`/`machine`/`source_id` 三元组做幂等 upsert；
时间戳取源数据时间（创建 + 最后修改），不用上传时间。

## 新 Agent 接入契约（raw 归一化）

**以后为新 Agent 做 hook/插件时，必须注意上传的 `raw` 格式**——服务端按统一契约从 `raw` 抽取
`text` 与 `reasoning` 做切片索引，格式不对该 Agent 的思考就索引不到：

- 思考（reasoning）一律以 part `{type:"reasoning", text}` 放入所属消息的 `raw`，与 `text` parts 分离；
  固定字段名 `text`，**不新造字段**（如 `thinking`；服务端虽兼容 `thinking`，但新增适配器统一用 `text`）。
- `raw` 顶层形态可以是 数组（多 part）/ 单对象（单 part）/ 字符串 / null，但 reasoning part 的结构与字段名
  必须符合上述契约。
- 各源原始格式不同，**由适配器/插件负责归一化后再上传**：opencode / zcode 是 parts 数组
  （`type ∈ {text, reasoning, tool, step-start, step-finish, file, patch}`，reasoning 取 `.text`）；
  WorkBuddy 是 OpenAI Responses 风格（`input_text` / `output_text` + 独立 `reasoning` 行，无 role，
  需采集器自行挂到消息 raw 并归一成 `{type:"reasoning", text}`）。
- 思考仅提供加密/摘要而无明文时，适配器需评估其索引价值并记录（无明文则跳过）。
- Hermes 无逐消息 reasoning 持久化（仅 tokens 统计）→ 不产出 reasoning part，属合法"无明文跳过"场景。
- 现有实现参考：`server/apps/server/src/indexing/raw-extract.ts`（归一化）、
  `plugins/opencode`、`plugins/zcode`、`plugins/hermes`、`apps/collector`。

## Embedding 提供商链

优先级（配置文件驱动）：`5070Ti(frpc) → 4070Ti(frpc) → 云端(待填)`；**无内置本地兜底**，本地推理服务（Ollama 等）按普通 OpenAI 兼容 provider 配置。
要求：健康检查 + 自动降级 + 恢复回升；全部 OpenAI 兼容 `/v1/embeddings` 接口；failover 仅限同模型提供商（活跃模型 = 最高优先级已启用提供商的模型）；未配置任何可用提供商时 health 返回 warnings，不静默兜底。

## 安全

- 密钥/token 一律走环境变量或 `config/*.local.json`（gitignore），**绝不入库**
- 会话原文含用户密钥/内网信息：日志里不得打印会话正文，日志只记元数据与统计

## 命令（根目录执行，npm 编排脚本已带 server/ 路径）

```
npm run dev        # 服务端开发（tsx watch，自动加载 server/.env）
npm run dev:web    # 前端开发（Vite，代理 /v1 /health 到 SH_API_PORT，默认 7428）
npm run build      # tsc -b + 前端构建
npm test
npm run reindex    # 未索引会话补向量（也可在 Web 设置页触发）
```

服务端所有相对路径（.env 里的 SH_* 与 .env 文件本身）以 `server/` 为根解析，与启动 cwd 无关。

## 代码风格

- 不写注释，除非逻辑确实自解释不了；公共 API/配置结构用类型与命名表达
- 提交信息中文，格式 `模块: 摘要`

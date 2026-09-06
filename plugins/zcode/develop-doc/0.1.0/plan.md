# 0.1.0 — ZCode 采集插件：实时 hook 上报 + 历史回填

> 全局决策见根 `plan.md`；本档不推翻任何全局决策，只新增 ZCode 信息源（根 plan.md §3/§4 已同步补充）。
> 同构参照：`plugins/opencode/`（transformSession/uploadSession/backfill 模式直接沿用，agent 用 `"zcode"`）。

## 需求描述

把本机 ZCode（`~/.zcode/cli/`）的会话上报到 session-hub 服务端：

1. **实时**：会话每轮结束（Stop hook）自动 upsert 一次，服务端准实时可见
2. **回填**：CLI 脚本把 db.sqlite 里的历史会话全量补传
3. 服务端**零改动**：只调 `PUT /v1/sessions`（幂等键 agent+machine+source_id）

## 侦察事实（2026-09-06，本机实测，探针采样 + 直读 DB 验证）

### ZCode 侧

- 插件是**声明式**的（无编程式 SDK）：插件目录含 `.zcode-plugin/plugin.json`（manifest，只需 `name`，匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`）+ 组件字段 `commands/skills/hooks/mcpServers/agents`（目录名/数组/内联均可）；通过 Settings → Plugin Management 的 Discover 加 **本地目录 marketplace** 注册；插件 hook 自动启用 hook runner（无需 `hooks.enabled`）
- hook 事件共 7 个：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop，**无 SessionEnd**
- hook 触发时 stdin 收单行 JSON payload；`session_id` 与 `cwd`、`timestamp` 均有；payload 同时带 camelCase 与 snake_case 双份字段（`sessionId`/`session_id` 等）
- hook 是**同步内联执行**：hook 进程不退出，ZCode 就停着等 → 上报逻辑必须 spawn detached 子进程后立即 `exit 0`
- **实测（探针采样 7 事件 ×110 次）**：`transcript_path` 临时文件不可靠——只有 UserPromptSubmit（1 行 = 刚提交的 user 消息）和 Stop（1 行 = 本轮最后一条 assistant 消息）有内容，其余全 0 字节，临时目录用后即清。**transcript 不采用**
- 但 **hook payload 本身信息量足**：UserPromptSubmit 带 `prompt` 全文，PostToolUse/PostToolUseFailure 带 `toolName`/`toolInput`/`toolResponse` 全文，Stop 带 `responseText`/`last_assistant_message`/`cwd`/`timestamp`/`toolCallCount`；缺中间 assistant 文本与 reasoning
- **payload 的 `session_id` 与 db.sqlite 的 `session.id` 是同一 ID 体系**（实测以探针抓到的 id 精确命中 db 会话行）→ payload 作触发器与身份来源，db 作内容来源，二者无缝对应
- **真正的实时数据源是 db.sqlite**：`~/.zcode/cli/db/db.sqlite`（WAL 模式），ZCode 运行中即实时写入（本会话进行中实测：session 行 time_updated 实时前进、message/part 逐条落库）。readonly 连接读 WAL 库无冲突
- db.sqlite 关键表：
  - `session(id, project_id, parent_id, directory, title, time_created, time_updated, ...)`，时间戳均为 ms epoch
  - `message(id, session_id, time_created, time_updated, data JSON, sequence)`：`data.role`（user/assistant）、`data.agent`（zcode-agent/zcode-Explore/...）、`data.time.created/completed`、`data.semantics.{kind,uiVisibility}`
  - `part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)`：`type` ∈ text（`text` + `time.start`）/ tool（`callID`、`tool`、`state.{status,input,output,time}`）/ reasoning / step-start / step-finish / timeline
- `semantics.kind` 分布：`user_prompt` / `assistant_response`（对话主体）、`todo_reminder` / `background_notification`（uiVisibility=hidden，注入物）、`timeline_event`（模型切换等分隔事件）——后三类必须过滤
- **子会话**：subagent（Explore/general-purpose 等）是独立 session 行，`parent_id` 非空、id 形如 `sess_subagent_agent_*`

### 服务端侧（零改动确认）

- `PUT /v1/sessions` upsert = 整体替换：更新 session 行 + `DELETE FROM messages` 全量重插 + 清空索引（`server/apps/server/src/db/sessions.ts` upsert）→ **每次全量刷新语义天然成立**
- `sessionUpsertSchema`（`packages/shared/src/session.ts`）：role 自由字符串（≤64）、text ≤1MB、messages ≤5000、created_at/updated_at 为 ms

## 方案

### 数据流（定稿：payload 定身份与时机，db 补内容）

```
UserPromptSubmit / Stop hook（ZCode 内联等待）
  └─ dist/hook.js：stdin 读 payload → 取 session_id
       → spawn detached `node dist/worker.js <payload文件>` → 立即 exit 0
            └─ worker：
                 身份/元数据 ← payload（source_id = session_id、cwd、触发时间戳）
                 会话内容    ← readonly 读 db.sqlite（按 session_id 取
                               session + messages + parts，见映射表）
                 → transform → PUT /v1/sessions（Bearer token）
```

订阅 UserPromptSubmit + Stop 两个事件：前者让会话在用户输入后即建档（尽早可见），后者在每轮内容落库后全量刷新。不订阅其余 5 个事件（工具等正文数据由 db 统一提供，避免多事件拼装的复杂度）。回填 CLI 与 worker 共用 db 读取 + transform 代码。

### db.sqlite → sessionUpsertSchema 映射定稿

| 目标字段 | 来源 | 规则 |
|---|---|---|
| agent | 常量 | `"zcode"` |
| machine | `os.hostname()` | 与 opencode 插件一致 |
| source_id | `session.id` | 原样 |
| title | `session.title` | 截断 2000（ZCode 标题可能是整段任务文本） |
| cwd | `session.directory` | |
| created_at / updated_at | `session.time_created / time_updated` | ms epoch，直接用 |
| messages | `message` 表 WHERE session_id | 按 `time.created` + sequence 排序 |
| ├ 过滤 | `data.semantics` | 仅保留 `kind ∈ {user_prompt, assistant_response}`；丢弃 todo_reminder / background_notification / timeline_event |
| ├ role | `data.role` | user / assistant，原样 |
| ├ ts | `data.time.created` | |
| ├ text | 该 message 的 `part`（type='text'） | 多段 `\n\n` 拼接；reasoning / tool part 不进 text |
| └ raw | 该 message 的全部 parts | 按序数组（tool 产出在 raw 里，与服务端"原文全量"口径一致，同 opencode） |
| 上限 | | messages >5000 取最后 5000；text 截断 1MB + 标记 |

**范围取舍（0.1.0）**：`parent_id` 非空的 subagent 子会话**不采集**（实时 Stop 不确定是否对其触发，回填先跳过），记遗留。

### 实时增量刷新语义

- 订阅 **UserPromptSubmit + Stop**（payload 定触发时机与身份；正文统一走 db，含 reasoning 与中间 assistant 文本，与回填口径一致）
- 每次触发 → worker 读**该会话全量** → `PUT /v1/sessions` 幂等 upsert（服务端整体替换）。无本地状态、无去重、无拼装，重复上传安全
- 代价：每轮全量重传 + 服务端重灌索引。单人使用、轮次粒度，可接受；与 opencode 插件 session.idle 全量刷新同构。若后期量级上来，再加"updated_at 未变则跳过"的本地状态文件优化

### 配置

复用 opencode 插件约定（同构 `loadConfig`）：

- 优先环境变量 `SESSION_HUB_URL` / `SESSION_HUB_TOKEN`
- 否则读 `~/.config/session-hub/config.json`（`baseUrl`/`token`/`timeoutMs`）
- 都没有 → 插件静默不启用（hook 直接 exit 0），服务端零压力

### 打包与安装（吸取 opencode 0.1.1 教训）

- esbuild 打包为**纯 JS**（`--bundle --format=esm --platform=node`，`better-sqlite3` external），杜绝 TS 语法进产物——ZCode hook 由系统 Node 执行，无转译步骤
- 产物：`dist/hook.js`（hook 入口）、`dist/worker.js`（采集 worker）；`scripts/build.mjs` 打包，`scripts/install.mjs` 打包并输出安装说明
- 插件以**本地目录 marketplace** 注册 `plugins/zcode/`；`.zcode-plugin/plugin.json` name=`session-hub`；`hooks/hooks.json` 订阅 Stop → `{type:"process", command:"node", args:["<dist/hook.js>"]}`。hooks.json 中相对路径的解析基准未验证——开发阶段先试相对路径，不行则由 install.mjs 生成绝对路径版本（install 时机器特定，产物 gitignore）

## 涉及文件

```
plugins/zcode/
  package.json                 # @session-hub/zcode-plugin 0.1.0（已建）
  .zcode-plugin/plugin.json    # manifest
  hooks/hooks.json             # UserPromptSubmit + Stop → dist/hook.js
  src/hook.ts                  # stdin → detached spawn → exit 0
  src/worker.ts                # db 读取 + transform + upload
  src/transform.ts             # 纯函数映射（单测对象）
  src/config.ts                # loadConfig（同构 opencode）
  src/backfill.ts              # 回填 CLI（--url --token --db --since --dry-run）
  scripts/build.mjs / install.mjs
  test/                        # transform / backfill / config 单测
  tsconfig.json
  develop-doc/0.1.0/           # 本档
根 package.json                # build 加 typecheck -w @session-hub/zcode-plugin
根 plan.md                     # §3 信息源 + §4 侦察事实补 zcode
```

## 任务清单

- [x] 验证探针采样：7 事件 payload 字段、transcript 不可靠、payload session_id ↔ db session.id 同源（本档侦察事实）
- [ ] 开发期实测：Stop 触发瞬间 db 是否已含本轮最后一条 assistant 消息（决定 worker 是否需要短重试）
- [ ] src/transform.ts + 单测（用真实 db 行结构 fixture）
- [ ] src/config.ts / worker.ts / hook.ts + 单测
- [ ] src/backfill.ts + dry-run 验证
- [ ] .zcode-plugin/plugin.json + hooks/hooks.json + build/install 脚本
- [ ] 根 package.json build 接线；根 `npm test` + `npm run build` 全绿
- [ ] 端到端：注册插件 → 新开 ZCode 会话跑两轮 → `GET /v1/sessions?agent=zcode` 可见且第二轮 updated_at/messages 前进
- [ ] backfill 实跑（本机 12 会话），重复执行幂等
- [ ] summary.md；探针清理（`~/.zcode/cli/config.json` hooks 禁用，需用户确认；`.scratch/` 永不提交）

## 验收标准

1. 单测 + 根 `npm test` + `npm run build` 全绿；安装产物为纯 JS（无 TS 语法）
2. 端到端实时：新会话首轮结束后服务端可见，第二轮结束 updated_at 前进、messages 增长
3. 回填：本机历史会话全量入库，重复执行不产生重复会话
4. 采集内容符合映射表：无 todo_reminder/timeline 注入物，工具产出在 raw，时间戳为源数据时间
5. 日志只记元数据与统计，不打印会话正文（安全红线）

## 风险与对策

| 风险 | 对策 |
|---|---|
| Stop 触发时 db 尚未刷入最后一条 assistant 消息 | 开发期首任务实测；若存在延迟，worker 内短重试（≤2s）后再读 |
| hooks.json 相对路径不解析 / node 不在 hook 环境 PATH | install.mjs 生成绝对路径 hooks 配置兜底 |
| better-sqlite3 为 native 模块，esbuild 需 external | 产物依赖仓库 node_modules；单人本机部署可接受，worker 启动时 fail-fast 报缺失 |
| db.sqlite 读取与 ZCode 写入冲突（WAL） | readonly 连接已实测可行；worker 内 busy_timeout + 单次重试 |
| 会话超 5000 消息被截断 | 服务端 schema 硬上限；与 opencode 插件同一策略（取最后 5000），截断标记注明 |
| subagent 子会话漏采 | 0.1.0 明确不做，遗留到下版本评估 |

# 0.1.0 — Claude Code 采集插件：插件 hook 实时上报 + 历史回填

> 全局决策见根 `plan.md`；本档不推翻任何全局决策，只新增 Claude Code 信息源（根 `plan.md` §3/§4 已同步补充）。
> 同构参照：`plugins/zcode/`（hook 收 payload → detached worker → transform → PUT /v1/sessions）。
> **关键差异（本档最大简化）**：Claude Code 的 hook payload 带**真实可用的 `transcript_path`**（实测），
> 正文直接读该 JSONL 即可——不像 zcode 需要绕道 db.sqlite。故本插件无 db 层、无节流层。

## 需求描述

把本机 Claude Code 的会话上报到 session-hub 服务端：

1. **实时**：每轮结束（Stop）自动 upsert，服务端准实时可见；用户提交输入（UserPromptSubmit）即建档；会话终结（SessionEnd）补一次
2. **回填**：CLI 脚本把 `~/.claude/projects/` 下的历史转写全量补传
3. 服务端**零改动**：只调 `PUT /v1/sessions`（幂等键 agent+machine+source_id）

自举性质：插件启用后，**Claude Code 自身的会话（包括用它开发本插件的会话）都会被采集**。

## 侦察事实（2026-10-09，本机实测；Claude Code 2.1.295 / Windows 11 / WORKSTATION-A）

### 转写存储（权威内容源）

- 路径：`~/.claude/projects/<cwd 转义>/<sessionId>.jsonl`（`C:\Users\example-user\.claude\projects\D--Github-session-hub\` 形式；
  转义规则：`: \ /` → `-`）。**运行时实时追加**（本会话实测：同一文件从 35 行涨到 800+ 行，边跑边写）
- **subagent 不写主转写**：落在 `<project>/<主会话 id>/subagents/agent-<agentId>.jsonl`（条目 `isSidechain:true`，
  另有同名 `.meta.json`）。主转写文件中 `isSidechain` 条目数为 0（实测）
- entry `type` 全集（本机 3 文件扫描）：`user` / `assistant` / `attachment` / `ai-title` / `last-prompt` / `system` /
  `queue-operation` / `mode` / `permission-mode` / `atis-latch` / `file-history-snapshot` / `cost-state`
- content 块类型：`text` / `thinking` / `tool_use` / `tool_result`，另有 user 消息的**字符串 content**
- **真人输入判定**：`type:"user"` 且 `message.content` 是**字符串**；`tool_result` 载体同为 `type:"user"`，但其
  `content` 是**块数组** → 必须按类型区分，不可一律当对话
- `assistant` entry：`message.content` 块数组 `{type:"thinking",thinking,signature}` / `{type:"text",text}` /
  `{type:"tool_use",id,name,input}`；**同一次 API 调用拆成多条 entry**（`apiBlockIndex` 递增，`message.id` 相同）→ 需按 id 聚合
- `attachment` 条目是注入的系统上下文（environment / model / 等），非对话内容 → 跳过
- `ai-title` 条目：`{type:"ai-title", aiTitle, sessionId}` → **title 首选**（与 WorkBuddy 的 `aiTitle` 同思路）
- 每条 entry 带 ISO `timestamp`（如 `2026-10-09T06:56:44.139Z`）与 `uuid`/`parentUuid`/`sessionId`/`cwd`/`version`

### hook 体系（实测：无头 `claude -p` + settings.json 直挂探针，四事件全部命中）

- 事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStop` / `SessionEnd` /
  `PreCompact` / `Notification`
- stdin payload 公共字段（四事件实测均有）：`session_id`、**`transcript_path`（真实绝对路径）**、`cwd`、`hook_event_name`
- 事件独有：`UserPromptSubmit` → `prompt`（全文）+ `prompt_id`；`Stop` → `stop_hook_active` / `last_assistant_message`；
  `SessionEnd` → `reason`（实测 `"other"`）；`SessionStart` → `source`（实测 `"startup"`）
- **`transcript_path` 可靠**——与 zcode 的教训（临时文件 0 字节、用后即清）完全相反：它指向的就是上面那份实时转写
- hook 执行形态：`{"type":"command","command":"..."}`；Windows 下命令串用 `node` + 正斜杠路径**实测可用**
- **Stop 时刻转写已含最终 assistant 消息**（实测：Stop payload 的 `last_assistant_message` 与转写末尾一致）→ 无需重试等待
- hooks **在会话启动时加载**：改配置/装插件后必须重启 Claude Code 才生效
- 插件形态：`.claude-plugin/plugin.json`（manifest）+ `hooks/hooks.json`（**包装格式** `{"hooks":{"<Event>":[{matcher,hooks:[...]}]}}`），
  路径用 `${CLAUDE_PLUGIN_ROOT}` 保可移植；本地目录 marketplace 用 `.claude-plugin/marketplace.json` 注册
  （`{"name":..., "plugins":[{"name":..., "source":"<相对目录>"}]}`，样例见官方 `claude-plugins-official`）

### 服务端契约（零改动确认）

- `PUT /v1/sessions`（`packages/shared/src/session.ts::sessionUpsertSchema`）：`agent ≤64`（用 `"claude-code"`）、
  `machine ≤128`（`os.hostname()`）、`source_id ≤256`（= Claude Code `session_id`）、`title ≤2000`、`cwd ≤2000`、
  `created_at/updated_at`（ms）、`messages[]`：`role ≤64` 自由、`text ≤1MB` optional、`ts` optional、`raw` 任意
- upsert = 整体替换（DELETE messages + 重插 + 清索引）→ 全量刷新语义天然成立（同 zcode）
- raw 归一化契约：`server/apps/server/src/indexing/raw-extract.ts` 抽 `reasoning` 时兼容 `thinking` 字段，但
  **新增适配器统一产出 `{type:"reasoning", text}`**（AGENTS.md 硬要求）

## 方案

### 数据流（hook 定身份与时机，transcript_path 供正文）

```
UserPromptSubmit / Stop / SessionEnd（hook，同步内联等待）
  └─ dist/hook.js：stdin 读 payload → 取 session_id + transcript_path
       → spawn detached `node dist/worker.js <payload文件>` → 立即 exit 0
            └─ worker：
                 读 transcript_path 全量 JSONL
                 → transform 归一化（真人输入 + assistant 聚合，见映射表）
                 → PUT /v1/sessions（Bearer token）
```

- 订阅 3 个事件的理由：`UserPromptSubmit` 让会话在用户输入后即建档（尽早可见）；`Stop` 每轮内容落定后全量刷新；
  `SessionEnd` 在会话收尾时必补一次（应对 Stop 后进程被直接关闭）
- **不节流**：单人使用、轮次粒度，每轮全量重传 + 服务端重灌索引的代价与 zcode 同量级，可接受（hermes 需 60s 节流是
  因 Bot 会话数百条消息，Claude Code 不属此列）
- 失败静默：网络/服务端故障时 worker 记日志退出，不重试（下轮 hook 自然重传，upsert 幂等）

### JSONL → sessionUpsertSchema 映射（定稿）

| 目标字段 | 来源 | 规则 |
|---|---|---|
| agent | 常量 | `"claude-code"` |
| machine | `os.hostname()` | 与其他插件一致 |
| source_id | payload `session_id` | 原样 |
| title | 最新 `ai-title` 条目的 `aiTitle` | 截断 2000；缺失则回退首条真人输入前 200 字 |
| cwd | payload `cwd`（回填时取转写内 `cwd`） | |
| created_at / updated_at | 转写首 / 末条目 `timestamp` | ISO → ms epoch |
| messages | 按文件顺序遍历 entry | 见下 |

消息规则：

- **保留**：`type:"user"` 且 content 为字符串（真人输入，role `user`）；`type:"assistant"`（role `assistant`）
- **跳过**：`attachment` / `ai-title` / `last-prompt` / `system` / `queue-operation` / `mode` / `permission-mode` /
  `atis-latch` / `file-history-snapshot` / `cost-state`；以及 `type:"user"` 且 content 为块数组（tool_result 载体，
  归并进对应 assistant 消息，见下）
- **assistant 聚合**：同一 `message.id` 的多条 entry 合并为一条消息（按 `apiBlockIndex` 排序），`raw` 为归一化 parts 数组：
  - `{type:"thinking",thinking}` → **`{type:"reasoning", text}`**（契约字段名 `text`）
  - `{type:"text",text}` → `{type:"text", text}`
  - `{type:"tool_use",id,name,input}` → `{type:"tool", callID:id, tool:name, state:{status:"completed", input}}`
  - 紧随的 `tool_result` 载体 entry：按 `tool_use_id` 归并进对应 tool part 的 `state.output`（role 不变）
  - `text` 字段 = 该消息所有 text part 按 `\n\n` 拼接（≤1MB 截断）
- **注入过滤**：真人输入若整条以 `<system-reminder` 开头则跳过（同 WorkBuddy 教训；Claude Code 多数注入走 attachment，
  此条为兜底）
- 上限：messages >5000 取最后 5000；单条 text ≤1_000_000；单个 tool output 截断 100_000（防截图/base64 撑爆 payload）；
  title ≤2000；截断标记 `\n\n[session-hub: truncated]`（同 zcode 常量）
- `ts`：该 entry 的 `timestamp` → ms

### 目录结构（对齐 zcode/hermes）

```
plugins/claude-code/
  package.json            # version 0.1.0（版本事实源）
  .claude-plugin/plugin.json   # Claude Code 插件 manifest
  hooks/hooks.json             # 包装格式 + ${CLAUDE_PLUGIN_ROOT}/dist/hook.js
  src/
    hook.ts               # stdin → temp file → spawn detached worker → exit 0
    worker.ts             # 读 transcript_path → transform → 上传
    transcript.ts         # JSONL → 原始会话结构（读 + 分组聚合，纯函数可测）
    transform.ts          # → sessionUpsertSchema 归一化（纯函数，可测）
    config.ts             # baseUrl/token 解析（与 zcode/dsh 共享 ~/.config/session-hub/config.json）
    backfill.ts           # 历史回填 CLI：扫 ~/.claude/projects/*/*.jsonl
  test/                   # vitest：transcript / transform / config / hook
  scripts/
    build.mjs             # esbuild 打包 dist/{hook,worker,backfill}.js（零运行时依赖）
    install.mjs           # 构建 + 打印 marketplace 注册/安装指引
  develop-doc/0.1.0/      # 本档 + summary.md
plugins/.claude-plugin/marketplace.json   # 本地 marketplace（与 zcode 的 plugins/marketplace.json 共存）
```

- 配置解析顺序：`SESSION_HUB_URL`/`SESSION_HUB_TOKEN` 环境变量 → `~/.config/session-hub/config.json`（`baseUrl`/`token`/`timeoutMs`，
  与 zcode/dsh 完全共用）；未配置时**静默不启用**（hook 直接退出 0）
- 安装形态：`/plugin marketplace add D:/Github/session-hub/plugins` → `/plugin install <name>@<marketplace>`；
  开发期可用 `claude --plugin-dir D:/Github/session-hub/plugins/claude-code` 试跑
- **安装后必须重启 Claude Code**（hooks 启动时加载）

### backfill CLI

`node dist/backfill.js [--since <ms>] [--dry-run]`：遍历 `~/.claude/projects/*/*.jsonl`（**跳过 `subagents/` 子目录与
`*.txt`**），逐个 transform 后 upsert（幂等，可重复跑）。

## 涉及文件

- 新增 `plugins/claude-code/**`（package.json、.claude-plugin、hooks、src、test、scripts、develop-doc）
- 新增 `plugins/.claude-plugin/marketplace.json`（本地 marketplace 注册）
- 根 `package.json`：build 链补 `npm run typecheck -w @session-hub/claude-code-plugin`；scripts 补
  `"install:claude-code-plugin": "node plugins/claude-code/scripts/install.mjs"`
- 根 `plan.md`：§3 v1 信息源行 + §4 新增「Claude Code ✅」（本次规划已同步）
- 根 `AGENTS.md`：仓库结构 plugins 行补 claude-code；关键外部事实表补 Claude Code 行（开发阶段完成时补）
- 不改：`server/**`、`packages/shared/**`、其他插件

## 任务清单

- [ ] 脚手架：package.json + tsconfig + build.mjs（esbuild，零运行时依赖产物）
- [ ] transcript.ts + 单测（entry 过滤、assistant 按 message.id 聚合、tool_result 归并、attachment 跳过）
- [ ] transform.ts + 单测（reasoning 归一为 `{type:"reasoning", text}`、截断、注入过滤、title/cwd/时间戳映射）
- [ ] config.ts + hook.ts + worker.ts + 单测（config 优先级、stdin/spawn detached、上传失败静默）
- [ ] backfill.ts（目录扫描 + `--since`/`--dry-run`）
- [ ] `.claude-plugin/plugin.json` + `hooks/hooks.json` + `plugins/.claude-plugin/marketplace.json`
- [ ] 根 package.json build 链与 install 脚本
- [ ] 实测：真实会话一轮 → 服务端 `GET /v1/sessions?agent=claude-code` 可见；reasoning 可被语义搜索命中；回填历史
- [ ] summary.md；AGENTS.md 补条目

## 验收标准

1. `npm test` + `npm run build` 全绿（根目录）
2. Claude Code 正常对话一轮后 ≤30s，服务端出现 `agent="claude-code"` 会话，消息与转写一致（抽查首尾）
3. 连续对话 5 轮，服务端该会话 `updated_at` 单调前进、消息数与转写一致（无重复消息）
4. 对某条思考内容做语义搜索能命中该会话（验证 reasoning 已按契约索引）
5. 回填后 `GET /v1/stats` 的 agent=claude-code 会话数 ≥ 实际转写文件数（排除 subagents）
6. 未配置 token 时 hook 静默退出（fail-open）；卸载插件后 Claude Code 各端无异常

## 风险与开放问题

- **hooks 启动加载**：安装/改动需重启 Claude Code；文档与 install 输出必须写明
- **全量重传代价**：长会话每轮重读整个 JSONL + 服务端重建索引；已按 text 1MB / messages 5000 / 单 tool output 100KB 截断
- **assistant 聚合假设**：`message.id` + `apiBlockIndex` 的聚合规则需开发期用真实多块会话再验证（探针已见拆分现象）
- **compact（上下文压缩）后的转写结构**：本机暂未遇到 `summary`/压缩条目，遇到再兼容，不阻塞 0.1.0
- **subagent 不采集**：0.1.0 只采主会话（同 zcode 取舍）；`SubagentStop` 事件的 `transcript_path` 指向 subagent 文件的
  可能性未验证，留待后续版本
- **SessionEnd reason 取值**：仅实测到 `"other"`；各取值语义不影响本插件（一律触发收尾上传）
- Windows 路径含空格：hook 命令串中 `${CLAUDE_PLUGIN_ROOT}` 展开后需引号包裹（开发期实测）

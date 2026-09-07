# 0.1.0 采集器：WorkBuddy Hook 推送式采集

## 需求描述

WorkBuddy 有官方 hook 系统（CodeBuddy Code 内核，Hooks Beta v1.16.0+；本机内核 v2.137.1）。
将 WorkBuddy 采集从"轮询 JSONL 文件"升级为"hook 实时推送"：在 WorkBuddy 生命周期事件上挂
hook，hook 命令调起本子系统的适配脚本，脚本把会话增量上传到 session-hub 服务端。

本期是采集器（collector）子系统的第一个版本：新建 `apps/collector` 包，落地 WorkBuddy
hook 适配器 + 采样探测脚本 + hook 配置样例。**服务端零改动**（复用既有 `PUT /v1/sessions`）。

## 调研事实（2026-09-07 实证）

### Hook 系统（官方文档 workbuddy.cn/docs/cli/hooks + hooks-guide，两页均已抓取核实）

- 事件家族 27+ 种；本期关注：`Stop`（主代理每轮响应结束）、`SessionEnd`（会话结束，
  reason: clear/logout/prompt_input_exit/other）
- hook 命令通过 **stdin 收到 JSON**，公共字段：
  `session_id` / `transcript_path` / `cwd` / `permission_mode` / `hook_event_name`
  （Stop 另有 `stop_hook_active`；SessionEnd 另有 `reason`）
- `transcript_path` 指向当前会话完整记录 JSONL（文档示例
  `~/.codebuddy/projects/<项目>/<uuid>.jsonl`；WorkBuddy 产品名下应为 `~/.workbuddy/projects/…`，
  **Windows 实际路径待实测**）
- 配置位置：`~/.workbuddy/settings.json`（用户级，本机已存在，当前无 hooks 配置，零冲突）；
  **外部改文件不直接生效，必须经 `/hooks` 面板审查确认一次**
- **Windows 强制 Git Bash 执行**（不支持 cmd/PowerShell），命令需 bash 语法；hook 默认 60s
  超时；以 CodeBuddy 进程环境运行，cwd 为会话工作目录
- **exit 0 = 放行**；exit 2 = 阻塞（对 Stop 是"阻止停止让 Agent 继续"——**绝对不能用**）
- **UserPromptSubmit / SessionStart 的 stdout 会被注入对话上下文**——适配脚本必须静默
  （stdout 不打印任何内容；诊断信息写 stderr 或日志文件）
- 输出协议里 `decision: "block"` 已废弃；`type: "command"` 之外还有 prompt/agent/http 型
  hook（frontmatter 场景），本期不用

### 本机状态（2026-09-07 实测）

- `~/.workbuddy/` 是 WorkBuddy 的 CLI home（settings.json / plugins / skills / plans /
  sessions / shell-snapshots，结构与文档描述的 `.codebuddy` 一致）；`~/.codebuddy` 只有
  IDE 插件的 diagnostics/logs
- **`~/.workbuddy/` 下当前无 `projects/` 目录、无任何 transcript JSONL**——根 plan.md /
  AGENTS.md 的"`~/.workbuddy/projects/*/*.jsonl`"侦察事实在本机已失效（疑似被清理程序
  删除，存在 `session_fragment_repair_done520` 标记）。这强化了 hook 方案价值：hook stdin
  直接给出 transcript_path，不依赖我方猜路径
- 桌面端（v5.5.3）会话元数据在 `~/.workbuddy/workbuddy.db`（sessions 表仅元数据无正文）；
  内核为 CLI host 进程（`~/.workbuddy/sessions/<pid>.json`，version 2.137.1）
- 服务端在 NAS（WSL1），Windows 主机经 HTTP 访问——opencode 插件已验证同链路（PUT
  `/v1/sessions` + Bearer token）

### 既有约定（复用）

- 上传契约：`sessionUpsertSchema`（packages/shared/src/session.ts）：agent/machine/source_id/
  created_at/updated_at + messages[]（role/text/ts/raw），text 上限 1MB、messages 上限 5000
- 幂等三元组：agent=`workbuddy`，machine=hostname，source_id=session_id
- opencode 插件同构先例（plugins/opencode/src/plugin.ts）：截断常量（MAX_TEXT_LENGTH/
  MAX_MESSAGES/TUNCATE_MARK）、配置文件 `~/.config/session-hub/config.json`（baseUrl/token/
  timeoutMs，env `SESSION_HUB_URL`/`SESSION_HUB_TOKEN` 优先）、PUT 上传、AbortController 超时
- WorkBuddy JSONL 文本规则（AGENTS.md 既有事实）：用户输入在 `<user_query>` 标签内，过滤
  `<system-reminder`

## 方案

### 数据流

```
WorkBuddy 会话进行中
  └─ Stop / SessionEnd 触发 hook（Git Bash）
      └─ hook 命令（绝对路径调 tsx）运行 apps/collector 的适配脚本
          └─ 读 stdin JSON → 取 session_id + transcript_path
              └─ 读 transcript JSONL → 解析为 SessionUpsertInput
                  └─ PUT <server>/v1/sessions（Bearer，幂等 upsert，全量覆盖）
```

- 每次触发**全量重读 transcript + 全量 upsert**：服务端幂等，天然增量语义；v1 不做
  offset 记录（后续版本可优化为按行偏移增量上传）
- 事件配置：`Stop` + `SessionEnd` 两个。Stop 保证每轮落库（进程被杀前最新状态也已传过）；
  SessionEnd 收尾并携带 reason 语义。`UserPromptSubmit` 不配（Stop 已覆盖每轮粒度，少一个
  静默约束面）
- 会话时间戳取 transcript 行内时间（首行 created、末行 updated），**不用触发时刻**

### transcript JSONL 解析（防御式）

文档完全未给出 JSONL 行 schema，**解析器以实测采样为准**，初始实现按 Claude Code 式
JSONL 假设（`type: user|assistant`、`message.content` parts、`timestamp`、`sessionId`、
`cwd`），并做防御式处理：

- 逐行 JSON.parse，失败行跳过（计数）
- role：user/assistant/…，非法 role 跳过
- 用户文本：存在 `<user_query>` 标签时取标签内文本；纯 `<system-reminder` 内容丢弃；
  正常用户文本保留
- 助手文本：text parts 拼接；tool_use/tool_result 等非文本 parts 进 raw
- 截断：沿用 opencode 插件常量（text 1MB、messages 5000 保留最后 5000、截断标记）
- title：首条用户文本截 100 字符（无则不上传 title 字段）
- cwd：stdin JSON 的 `cwd` 字段（比行内 cwd 可靠）

### 配置与安装

- 适配脚本配置：复用 `~/.config/session-hub/config.json`（baseUrl/token/timeoutMs），env
  `SESSION_HUB_URL`/`SESSION_HUB_TOKEN` 可覆盖——与 opencode 插件同一份配置，零新增配置面
- hook 命令（写入 `~/.workbuddy/settings.json` 的 hooks 块，**改完必须在 WorkBuddy 里
  `/hooks` 面板确认一次**）：

  ```bash
  "D:/Github/session-hub/node_modules/.bin/tsx" "D:/Github/session-hub/apps/collector/src/workbuddy/hook.ts"
  ```

  绝对路径 + 显式调起，规避 Git Bash shebang 识别问题与 cwd 依赖；脚本内任何失败一律
  exit 0（错误写 stderr + 追加到日志文件），绝不阻塞会话
- 配置样例落盘 `apps/collector/config/workbuddy-hooks.sample.json`（hooks JSON 片段 + 安装
  步骤注释）

### 采样探测脚本（实测先行）

`apps/collector/scripts/workbuddy-probe.mjs`（纯 Node、零依赖，便于 hook 直调）：
把 stdin JSON 原样落盘 + 把 transcript_path 文件头尾各 N 行拷到本地采样目录。开发期先用
probe hook 采样真实 schema，据实修正解析器后再交付正式 hook。

## 涉及文件

- 新建 `apps/collector/package.json`（name `@session-hub/collector`，version **0.1.0**，
  collector 子系统版本事实源；scripts: typecheck / hook:workbuddy / probe:workbuddy）
- 新建 `apps/collector/tsconfig.json`（对齐 opencode 插件 tsconfig）
- 新建 `apps/collector/src/workbuddy/config.ts`（读配置）
- 新建 `apps/collector/src/workbuddy/parse.ts`（JSONL → SessionUpsertInput）
- 新建 `apps/collector/src/workbuddy/upload.ts`（fetch 客户端：PUT + Bearer + 超时）
- 新建 `apps/collector/src/workbuddy/hook.ts`（入口：stdin → parse → upload，静默、永不阻塞）
- 新建 `apps/collector/scripts/workbuddy-probe.mjs`（采样探测）
- 新建 `apps/collector/config/workbuddy-hooks.sample.json`（hooks 配置样例）
- 新建 `apps/collector/test/parse.test.ts`、`apps/collector/test/hook.test.ts`
- 修改 根 `package.json`：build 脚本追加 `npm run typecheck -w @session-hub/collector`
  （workspaces 已含 `apps/*`，无需改）
- 新建 `apps/collector/develop-doc/0.1.0/plan.md`（本文件）+ `summary.md`（开发完成时）
- 实测通过后（开发阶段内）：更新根 `plan.md` / `AGENTS.md` 中 WorkBuddy 采集方式事实
  （轮询 → hook 实时推送为主、文件回填兜底）

## 任务清单

1. collector 包骨架：package.json / tsconfig / 根 build 接入
2. `config.ts` + `upload.ts`（对齐 opencode 插件模式）
3. `parse.ts` 初始解析器（防御式 + 截断规则 + 单测覆盖边界）
4. `hook.ts` 入口（静默 + exit 0 语义）+ hook 集成测试（fake HTTP 服务端验证 payload/
   Bearer/超时/失败不阻塞）
5. `workbuddy-probe.mjs` 采样脚本 + `workbuddy-hooks.sample.json`
6. **实测**：本机 WorkBuddy 挂 probe hook → `/hooks` 面板确认 → 真实会话采样 → 按实际
   schema 修正 parse.ts → 正式 hook 走通 E2E（服务端可见会话、Web 检索命中）
7. 实测通过后更新根 plan.md / AGENTS.md，写 summary.md，提交

## 验收标准

- 根目录 `npm test` + `npm run build` 全绿
- 单测覆盖：解析器边界（system-reminder 过滤、user_query 提取、坏行跳过、截断、空文件、
  超 5000 条保留尾部）与 hook 行为（失败 exit 0、stdout 静默、超时不上传阻塞）
- 人工验收（记录进 summary.md）：真实 WorkBuddy 会话经 hook 链路落库，`GET /v1/sessions`
  可见 agent=workbuddy 记录，Web 检索可命中；`/hooks` 面板确认流程走通

## 风险与边界

| 风险/未知 | 处置 |
|---|---|
| transcript JSONL 行 schema 未采样 | probe 脚本先行采样；解析器防御式；实测后修正 |
| 桌面端会话是否触发 hook 未证实 | 实测；若不触发，hook 方案仅覆盖可触发场景，桌面端历史/兜底走后续版本的文件回填 |
| resume 时 session_id 是否复用未证实 | source_id 幂等不受影响；实测确认后记录进 summary |
| Stop 高频触发全量重传 | v1 接受（会话体量小）；后续可做 offset 增量 |
| hook 未配置的机器/历史会话漏采 | 本期不解决；保留后续回填通道（直读 DB/文件） |
| Git Bash 强制环境 | 命令用 bash 兼容语法 + 绝对路径；脚本不依赖 PowerShell/cmd |

**非目标（本期不做）**：轮询器守护进程、豆包适配器、直读 WorkBuddy DB 回填、消息级增量
offset、服务端任何改动、UserPromptSubmit hook。

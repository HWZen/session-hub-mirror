# 0.1.0 — Codex 采集插件：Stop hook 实时上报 + 历史回填

> 全局决策见根 `plan.md`；本档新增 Codex 信息源，不改变 Session Hub 的“全量存、对话索引、零加工”边界。
> 官方依据：[Codex Hooks](https://developers.openai.com/codex/hooks)、[Plugin packaging](https://developers.openai.com/plugins/build/plugins)。

## 需求描述

把本机 Codex（CLI 与 ChatGPT/Codex 桌面端共用的本地会话目录）接入 Session Hub：

1. **实时**：每轮主线程完成时由 Codex `Stop` hook 触发，对当前会话做一次全量幂等 upsert
2. **回填**：CLI 扫描 `$CODEX_HOME/sessions/**/*.jsonl`，补传历史会话
3. **原文保真**：用户/助手正文进入 `text`；工具调用、工具输出、扩展结果与可用的 reasoning 明文进入 `raw`
4. **服务端零改动**：只调用现有 `PUT /v1/sessions`，`agent` 固定为 `"codex"`

## 侦察事实（2026-09-18，Windows Codex Desktop 实测）

### 官方 hook 与插件能力

- Codex 原生支持 `UserPromptSubmit`、`Stop`、`SessionEnd` 等生命周期事件；本需求用 `Stop`，每轮主线程完成即触发，且不为 subagent 单独建档。
- command hook 从 stdin 收一个 JSON 对象；公共字段有 `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`，`Stop` 另有 `turn_id`、`stop_hook_active`、`last_assistant_message`。
- hook 可放在 `~/.codex/hooks.json`，也可随插件的 `hooks/hooks.json` 分发；插件命令可用 `PLUGIN_ROOT` 定位安装目录。
- 未托管 hook 安装或变更后必须在 Codex `/hooks` 中人工审阅并信任；安装插件不会自动信任 hook。
- 同步 command hook 会阻塞触发点；后台 hook 在会话结束时可能被取消。采用“入口同步、worker detached”的方式：入口只落一个小 payload、启动 worker、输出合法 JSON 后立即退出。
- 官方明确 `transcript_path` 指向的 transcript 格式**不是稳定接口**，解析器必须宽容，并用真实 fixture 锁定当前格式。

### 本地存储与真实 rollout 结构

- 会话目录：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`；`CODEX_HOME` 未设置时默认 `~/.codex`。
- 标题索引：`$CODEX_HOME/session_index.jsonl`，当前记录字段为 `id`、`thread_name`、`updated_at`。
- rollout 每行公共外层为 `{timestamp, ordinal, type, payload}`；本机样本的顶层类型包括 `session_meta`、`event_msg`、`response_item`、`turn_context`、`world_state`、`token_usage_record`。
- `session_meta.payload` 含 `session_id`/`id`、`timestamp`、`cwd`、`originator`、`source`、`thread_source`、`model_provider` 等元数据。
- 当前桌面端最适合采集的是 `event_msg.payload.type === "item_completed"` 的高层 item 流：
  - `UserMessage`：真实用户消息，`content[]` 中为 `type:"text"`
  - `AgentMessage`：助手可见消息，`content[]` 中为 `type:"Text"`，含 `phase`
  - `Reasoning`：`summary_text` 为可用明文摘要，`raw_content` 可能为空或不可用
  - `CommandExecution`：命令、cwd、stdout/stderr、exit_code、duration 等完整工具事实
  - `Extension`：浏览器、MCP 等扩展调用的 query/action/results
- `response_item` 同时保存更底层的 `message`、`reasoning`、`custom_tool_call`、`custom_tool_call_output`；其中 developer 消息含系统/仓库注入上下文，不能当用户对话正文；reasoning 多数只有 `encrypted_content`，无明文时无索引价值。
- 本机当前只有一个新格式会话样本；开发阶段还需补 CLI 与旧格式 fixture，验证兼容分支。

## 方案

### 总体数据流

```text
Codex Stop hook
  └─ dist/hook.js：stdin 读 payload → 写入 PLUGIN_DATA/queue/<uuid>.json
       → detached spawn `node dist/worker.js <payload文件>`
       → stdout 输出合法 Stop JSON，立即 exit 0
            └─ worker：按 transcript_path 读取当前 rollout
                 → parse/transform → PUT /v1/sessions

backfill CLI
  └─ 扫描 $CODEX_HOME/sessions/**/*.jsonl
       → 与 worker 共用 parse/transform/upload → PUT /v1/sessions
```

- hook 不直接做网络请求，避免阻塞 Codex；worker 成功或失败后清理自己的队列 payload。
- 每次上传当前会话**全量快照**；服务端按 `agent+machine+source_id` 整体替换，重复触发安全。
- `Stop` 时 rollout 可能仍在刷新；worker 先短延迟，再以“文件大小稳定 + 可解析到本轮 `turn_id` 或最新 AgentMessage”为条件做有限重读，总等待不超过 2 秒。
- `SessionEnd` 不作为实时主路径：它可能在关闭、归档、删除或无人连接 30 分钟后才触发，时效不满足逐轮同步。

### rollout → Session Hub 映射

| 目标字段 | 来源与规则 |
|---|---|
| `agent` | 常量 `"codex"` |
| `machine` | `os.hostname()` |
| `source_id` | `session_meta.payload.session_id ?? id`；缺失则从文件名 UUID 兜底 |
| `title` | `session_index.jsonl` 中同 id 的 `thread_name`；否则首条真实用户消息截断 2000 字符；再否则省略 |
| `cwd` | `session_meta.payload.cwd`，hook payload `cwd` 仅作兜底 |
| `created_at` | `session_meta.payload.timestamp`；否则 rollout 首个有效 timestamp |
| `updated_at` | rollout 最后一个有效 timestamp 与索引 `updated_at` 取较新值 |
| `messages` | 优先解析 `event_msg/item_completed`；无该流时回退到 legacy `response_item` |

### 消息与 raw 归一化

- 以相邻 `UserMessage` 为轮次边界：
  - `UserMessage` → 一条 `role:"user"` 消息，正文为 content text 拼接，原 item 放入 raw。
  - 随后的 `Reasoning`、`CommandExecution`、`Extension`、`AgentMessage` 聚合为该轮一条 `role:"assistant"` 消息；所有 `AgentMessage` 可见文本按顺序拼入 `text`，所有 item 按发生顺序放入 `raw`。
- raw part 做轻量归一化，同时保留原 item：
  - reasoning 有 `summary_text` 明文时写 `{type:"reasoning", text, original}`；仅有 encrypted/raw 加密内容时不生成 reasoning part，但原 item 仍作为非索引 raw 保存。
  - 命令/扩展项写 `{type:"tool", tool, state, original}`，工具输入输出只进 raw，不进对话 text。
  - 助手消息原 item 也进入 raw，保证 `/full` 能恢复 Codex 的阶段信息。
- fallback `response_item` 只接受 `role ∈ {user, assistant}` 的 message；明确丢弃 developer/system 注入。reasoning 只取 `summary[].text` 等明文，固定归一为 `{type:"reasoning", text}`。
- 不采集 `turn_context`、`world_state`、token 统计、base instructions 等运行时/注入上下文为对话消息；它们不属于用户与 Agent 的会话正文。
- 防御上限与其他适配器一致：消息超过 5000 保留最后 5000；单条 text 超 1MB 截断并留标记；未知事件保存在统计中但不抛错。

### 配置、安全与日志

- Session Hub 连接配置沿用现有约定：环境变量 `SESSION_HUB_URL` / `SESSION_HUB_TOKEN` 优先，否则读 `~/.config/session-hub/config.json`。
- 未配置 URL/token 时 hook 快速成功退出，不影响 Codex；worker 日志只记录 session id、路径、计数、HTTP 状态，不打印会话正文或 token。
- 源 rollout 只读；不修改 `$CODEX_HOME` 下的会话、索引或数据库。
- 队列 payload 只保存 hook 元数据，不复制会话正文；文件名随机，成功/失败后均尽力清理。

### 打包、安装与信任

- 插件目录 `plugins/codex/`，使用 `.codex-plugin/plugin.json` 兼容 manifest；`hooks/hooks.json` 随插件声明 `Stop` command hook。
- hook 命令在 Windows 使用 `commandWindows`，其他平台使用 `command`；两者均通过 `PLUGIN_ROOT` 执行打包后的纯 JS。
- esbuild 输出 `dist/hook.js`、`dist/worker.js`；运行时只依赖 Node 内置模块，避免 native 依赖。
- `scripts/install.mjs` 负责 build，并按 Codex 本地插件/marketplace 机制安装；开发阶段用 `plugin-creator` 的校验脚本验证 manifest。安装后明确提示用户在 `/hooks` 中审阅并信任。
- 根 npm 编排新增 Codex 插件 typecheck/build/test 接线；不把本机 token、个人 marketplace 或安装缓存写入仓库。

## 涉及文件

```text
plugins/codex/
  package.json
  tsconfig.json
  .codex-plugin/plugin.json
  hooks/hooks.json
  src/hook.ts
  src/worker.ts
  src/parse.ts
  src/transform.ts
  src/config.ts
  src/upload.ts
  src/backfill.ts
  scripts/build.mjs
  scripts/install.mjs
  test/parse.test.ts
  test/transform.test.ts
  test/config.test.ts
  test/upload.test.ts
  test/backfill.test.ts
  test/fixtures/
  develop-doc/0.1.0/
    plan.md
    summary.md
package.json
vitest.config.ts
plan.md
```

## 任务清单

- [ ] 用 CLI 与桌面端各补至少一个脱敏 fixture；确认旧格式 fallback 的真实事件名与字段
- [ ] `parse.ts`：JSONL 宽容解析、item_completed 主路径、response_item fallback、标题索引读取
- [ ] `transform.ts`：按轮聚合消息、raw 归一、时间戳/上限处理及单测
- [ ] `config.ts` / `upload.ts`：复用 Session Hub 配置与幂等上传约定
- [ ] `hook.ts` / `worker.ts`：stdin、detached worker、稳定读取、队列清理，确保 Stop 立即返回合法 JSON
- [ ] `backfill.ts`：`--codex-home`、`--since`、`--dry-run`、`--url`、`--token`，重复执行幂等
- [ ] manifest、hooks、build/install 脚本；用官方校验流程验证插件结构
- [ ] 根 npm build/test 接线；`npm test` + `npm run build` 全绿
- [ ] 真机 E2E：安装 → `/hooks` 信任 → 新会话跑两轮 → 服务端记录更新
- [ ] 历史回填 dry-run 与实跑；确认日志无正文/密钥
- [ ] 写 `summary.md`，提交本版本相关文件

## 验收标准

1. 根 `npm test` 与 `npm run build` 全绿；插件 manifest、hook 配置与打包产物通过校验。
2. Codex 每轮结束后不明显阻塞；Session Hub 中 `agent=codex` 的同一 source_id 被更新，messages 随轮次增长。
3. 用户/助手正文可被 grep 与语义搜索命中；developer/system 注入内容不进入 text。
4. 命令、工具输出和扩展结果完整保存在 `/full` 的 raw；可用 reasoning 明文以 `{type:"reasoning", text}` 被索引，仅加密 reasoning 不进入索引。
5. 标题、cwd、created_at、updated_at 均来自 Codex 源数据；回填重复执行不产生重复会话。
6. 未配置、网络失败、损坏行或未知事件不影响 Codex 主流程；日志不泄露正文、工具输出或 token。

## 风险与对策

| 风险 | 对策 |
|---|---|
| rollout 是官方声明的不稳定接口 | 主/兼容双解析路径、真实 fixture、未知事件宽容、解析统计告警 |
| Stop 触发时文件尚未刷完 | detached worker 有限等待并验证文件稳定/本轮可见；下一轮全量 upsert 可自愈 |
| hook 阻塞或改变对话控制流 | 入口不联网、立即 spawn；固定输出继续执行的合法 JSON，绝不返回 block |
| 插件 hook 未信任所以静默未运行 | 安装脚本与 README 明示 `/hooks` 审阅；E2E 验收包含信任状态 |
| reasoning 只有密文 | 原 item 留在 raw；无明文不伪造、不索引，记录 skippedEncryptedReasoning 统计 |
| 多个 AgentMessage/工具项归属错误 | 以 UserMessage 轮次边界和 ordinal 顺序聚合，fixture 覆盖 commentary、工具、最终答复、steering |
| rollout 正在追加或存在坏尾行 | 流式逐行解析，最后一行 JSON 不完整时有限重读；历史中间坏行跳过并计数 |
| 同一会话跨日期目录或索引缺失 | source_id 取 session_meta；扫描按 id 去重并选 updated_at 最新文件，标题回退首条用户消息 |

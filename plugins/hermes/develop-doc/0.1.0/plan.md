# 0.1.0 — Hermes 采集插件：Shell hook 实时上报 + 历史回填

> 全局决策见根 `plan.md`；本档不推翻任何全局决策，只新增 Hermes 信息源。
> 同构参照：`plugins/zcode/`（hook 收 payload → detached worker → db 直读 → transform → PUT /v1/sessions）。
> 环境事实：本机 Hermes 安装于 `C:\Users\example-user\AppData\Local\hermes\hermes-agent\`；4 个 profile（default / dev / qa / operations）。

## 需求描述

把本机 Hermes（多 profile）的会话上报到 session-hub 服务端：

1. **实时**：会话每轮结束后自动 upsert（节流防抖），服务端准实时可见
2. **回填**：CLI 脚本把各 profile `state.db` 里的历史会话全量补传
3. 服务端**零改动**：只调 `PUT /v1/sessions`（幂等键 agent+machine+source_id）

## 侦察事实（2026-09-30，本机安装版实测）

### Hermes 钩子体系（四套，选 Shell hooks）

| 体系 | 注册方式 | 运行范围 | 结论 |
|---|---|---|---|
| Gateway hooks | `<profile>/hooks/` HOOK.yaml+handler.py | 仅网关进程 | ❌ 不覆盖 CLI/Desktop 会话 |
| Plugin hooks | Python 插件 `ctx.register_hook()` | CLI+Gateway | ❌ 引入 Python 插件栈，违反仓库"全仓 TS"精神 |
| **Shell hooks** | config.yaml `hooks:` 块 → 任意 shell 命令 | **CLI+Gateway+Desktop 全覆盖** | ✅ 采用：宿主是命令行，可调 `node dist/hook.js` 跑 TS 产物 |
| Outbound webhooks | config.yaml `hooks.outbound:` | CLI+Gateway | ❌ 只推事件 JSON，正文还得二次拉取，且 Hermes 侧无拉取端点 |

- Shell hooks 事件全集 = `hermes_cli/plugins.py::VALID_HOOKS`（仅 `transform_api_error_classification` 不支持）
- 采用的触发事件：`post_api_request`（每轮主调用后，kwargs 含 `session_id`）+ `on_session_end` + `on_session_finalize` + `on_session_reset`（会话终结补一次）
- Shell hook 线协议：stdin JSON `{hook_event_name, tool_name, tool_input, session_id, cwd, profile, extra}`；超时后 detached 子进程仍存活（源码注释明示），**hook 内 spawn detached worker 后立即退出**的模式可行（同 zcode）
- 首次使用需同意：`(event, command)` 写入 `~/.hermes/shell-hooks-allowlist.json`；install 脚本预置该文件条目，避免首次触发弹同意阻塞
- `hermes hooks list/test/doctor` 可用于注册检查与合成 payload 单测

### Hermes 会话存储（权威数据源）

- 各 profile 的 `state.db`（SQLite）：`sessions` 表（`id, title, source, cwd, git_repo_root, started_at, last_activity_at, message_count, archived, profile_name` 等）+ `messages` 表（`id, session_id, role, content, tool_call_id, tool_calls, ...`，rowid 即对话顺序）
- **钩子 payload 不含会话正文**（只有 session_id/截断 500 字的 message）→ 与 zcode 同构：**payload 定身份与时机，state.db 直读补内容**
- state.db 无 NAS 红线（本机 SSD），但 worker 一律只读连接（`file:...?mode=ro` + `busy_timeout`）
- 思考（reasoning）未按消息持久化（仅 tokens 统计）→ 无 reasoning part，符合契约（"无明文则跳过"）
- 多 profile：Leader + dev + qa + operations 四个 profile 各有 state.db；`session_id` 全局唯一，统一 `agent="hermes"`，profile 差异暂不落库（服务端 schema 无此字段，不改服务端；title/cwd 足够定位）

### 服务端契约（零改动确认）

- `PUT /v1/sessions`（`packages/shared/src/session.ts::sessionUpsertSchema`）：`agent ≤64`（自由字符串，用 `"hermes"`）、`machine ≤128`（`os.hostname()`）、`source_id ≤256`（= Hermes session id）、`title ≤2000`、`cwd ≤2000`、`created_at/updated_at`（ms）、`messages[]`：`role ≤64` 自由、`text ≤1MB` optional、`ts` optional、`raw` 任意
- upsert = 整体替换（DELETE messages + 重插 + 清索引）→ 全量刷新语义天然成立
- 线上服务 `GET /health` 200（2026-09-30 复测）

## 方案

### 数据流（定稿：hook 定身份与时机，state.db 补内容，60s 节流）

```
post_api_request / on_session_end / on_session_finalize / on_session_reset（Shell hook，内联等待）
  └─ dist/hook.js：stdin 读 payload → 取 session_id + profile（hooks 按 profile config 注册，worker 参数显式传 profile home）
       → 节流检查（60s 内同会话已传 → exit 0）
       → spawn detached `node dist/worker.js <payload文件>` → 立即 exit 0
            └─ worker：
                 身份 ← payload（source_id=session_id）+ 启动参数（--profile <home>）
                 内容 ← readonly 打开该 profile 的 state.db
                       （sessions 行取 title/cwd/git_repo_root/started_at/last_activity_at；
                        messages 按 rowid 全量取，role∈{user,assistant} 进 text，role=tool 带工具产出进 raw/text 截断）
                 → transform 归一化 → PUT /v1/sessions（Bearer token）
                 → 成功后更新节流标记（状态文件，gitignored）
```

- 订阅 4 个事件的理由：`post_api_request` 提供准实时（zcode 的 Stop 等价物）；3 个终结事件在会话收尾时必补一次（应对节流窗口内掉电/退出）
- 节流 60s：Bot Chat 单会话数百条消息+工具产出，每轮全量 upsert + 服务端重建索引开销大；60s 窗口在"钩子源准实时"容差内。终结事件绕过节流强制上传
- 失败静默：网络/服务端故障时 worker 记日志退出非零，不重试（下轮 hook 自然重传，upsert 幂等）
- 过滤：`role='session_meta'` 丢弃；其余全量保留（含 tool 产出，符合"存得全"）
- 时间戳：`created_at = sessions.started_at`（ms）、`updated_at = sessions.last_activity_at`（ms，若为秒则 ×1000，实现时核实）；消息 `ts` 暂缺（messages 表无逐条时间列）→ 省略（契约 optional），rowid 顺序即对话顺序
- 截断：单条 text ≤1_000_000、messages ≤5000（超出取最后 5000 条，追加 `[session-hub: truncated]` 标记）、title ≤2000（同 zcode 常量）

### 目录结构（对齐 zcode）

```
plugins/hermes/
  package.json            # version 0.1.0（版本事实源）
  src/
    hook.ts               # stdin → 节流检查 → spawn detached worker
    worker.ts             # 读 state.db → transform → 上传 → 更新节流标记
    transform.ts          # 行→sessionUpsertSchema 归一化（纯函数，可测）
    hermes-db.ts          # 只读打开 state.db + 查询
    config.ts             # base_url/token 解析（skill config.json 复用 + env 覆盖）
    backfill.ts           # 历史回填 CLI：全 profile × 全会话 upsert
  test/                   # vitest：transform / config / hook 节流
  scripts/
    build.mjs             # esbuild 打包 dist/{hook,worker,backfill}.js
    install.mjs           # 写 4 个 profile config.yaml 的 hooks: 块 + 预置 allowlist + 构建
  develop-doc/0.1.0/      # 本档 + summary.md
```

- 安装形态：hooks 指向**主工作区** dist 绝对路径（`node D:/Github/session-hub/plugins/hermes/dist/hook.js --profile <home>`），worktree 只做开发，运行时用主工作区产物
- 配置解析顺序：环境变量 `SH_BASE_URL`/`SH_TOKEN` → `<leader-profile>/skills/personal/session-hub/config.json`（已存在，四 profile 均已拷贝）→ 报错退出

### backfill CLI

`node dist/backfill.js --profile <home> [--session <id>]`：遍历该 profile state.db 全部未归档会话逐个 upsert（幂等，可重复跑）；默认对 4 个 profile 依次执行。

## 涉及文件

- 新增 `plugins/hermes/**`（package.json、src、test、scripts、develop-doc）
- 根 `package.json`：build 链补 `npm run typecheck -w @session-hub/hermes-plugin`；scripts 补 `"install:hermes-plugin": "node plugins/hermes/scripts/install.mjs"`
- 根 `AGENTS.md`：§仓库结构 plugins 行补 hermes；§关键外部事实表补 Hermes 行（本档侦察事实浓缩）
- 不改：server/**、packages/shared/**、其他插件
- 依赖：devDependencies 复用 esbuild + better-sqlite3（allowScripts 已白名单，零新增编译风险）；不依赖 @session-hub/shared（避免 zod 运行时依赖进 dist，transform 用手写类型对齐契约并有单测锁定）

## 任务清单

- [ ] 脚手架：plugins/hermes/package.json + tsconfig + build.mjs（esbuild，零依赖产物）
- [ ] transform.ts + 单测（含截断/过滤/role 映射边界）
- [ ] hermes-db.ts + config.ts + 单测（只读连接、config 解析优先级）
- [ ] hook.ts（stdin/节流/spawn detached）+ worker.ts（上传/标记）+ 单测
- [ ] backfill.ts
- [ ] install.mjs（4 profile 注册 + allowlist 预置 + `hermes hooks list` 验证输出）
- [ ] 实测：真实触发一轮 → 服务端 `GET /v1/sessions?agent=hermes` 可见；回填历史会话
- [ ] summary.md；AGENTS.md 补条目

## 验收标准

1. `npm test` + `npm run build` 全绿（根目录）
2. Hermes 正常对话一轮后 ≤90s，服务端出现 `agent="hermes"` 会话且消息与 state.db 一致（抽查首尾消息）
3. 连续对话 5 轮，服务端该会话 `updated_at` 单调前进、消息数与本地一致（节流生效、无重复消息）
4. 回填后 `GET /v1/stats` 的 agent=hermes 会话数 ≥ 实际非归档会话数
5. 卸载（删 config.yaml hooks 块）后 Hermes 各端运行无异常（fail-open 验证）

## 风险与开放问题

- `post_api_request` kwargs 的 `session_id` 若个别场景缺失（文档标注 "may be absent"）→ payload session_id 为空时 worker 直接退出，等终结事件兜底
- 主 Bot Chat 体量大（数百消息）：首次上传可能数 MB，属一次性成本；之后每轮全量重传是已知代价（服务端 upsert 语义决定），节流缓解；若服务端将来支持增量再优化
- state.db 在 Hermes 运行中被写：只读连接 + busy_timeout 实测可行（本会话已验证只读查询无锁冲突）
- Windows 路径空格：install.mjs 写入的 command 需引号包裹 node 脚本路径

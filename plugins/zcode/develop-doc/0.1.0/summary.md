# 0.1.0 — 开发记录

> 计划见同目录 plan.md。开发在 worktree `.worktrees/0.1.0-dev/`（分支 `0.1.0-dev`）进行。

## 实际改动

```
plugins/zcode/
  package.json                 # @session-hub/zcode-plugin 0.1.0（scripts: typecheck/build/install:plugin/backfill）
  tsconfig.json
  .zcode-plugin/plugin.json    # name=session-hub + description
  hooks/hooks.json             # UserPromptSubmit + Stop → node dist/hook.js（相对路径，未实测）
  src/hook.ts                  # stdin payload → 临时文件 → detached spawn worker → exit 0
  src/worker.ts                # payload 取 session_id → readonly 读 db（缺会话行时重试 ≤2s）→ transform → PUT
  src/transform.ts             # 纯函数映射（semantics 过滤 / text 拼接 / raw 透传 / 5000 条与 1MB 截断）
  src/zcode-db.ts              # db.sqlite 只读访问（session/message/part，busy_timeout=3s）
  src/config.ts                # loadConfig（env 优先，兜底 ~/.config/session-hub/config.json）+ uploadSession
  src/backfill.ts              # 回填 CLI（--url --token --db --since --dry-run，跳过 subagent 子会话）
  scripts/build.mjs            # esbuild 纯 JS 打包 dist/（hook.js/worker.js）+ 生成绝对路径 hooks-absolute.json 兜底
  scripts/install.mjs          # 构建 + 产物校验 + 安装说明
  test/*.test.ts               # 21 个单测（transform 10 / zcode-db 4 / config 4 / backfill 3）
根 package.json                 # build 接线 zcode typecheck；install:zcode-plugin 脚本
根 .gitignore                   # plugins/zcode/dist/
```

## 与计划的偏差

1. **数据流按定稿方案落地**（payload 定身份与时机、db 补内容），与 plan.md 修订版一致，无偏差。
2. `hooks.json` 相对路径 `"dist/hook.js"` 的解析基准**尚未实测**（需要真实注册插件 + 新开会话才能验证）；`scripts/build.mjs` 已生成 `dist/hooks-absolute.json`（本机绝对路径版本）作为兜底，若相对路径不生效，把 manifest 的 hooks 指向该文件即可。
3. worktree 环境：`server/apps/web` 需单独 `npm install`（`@vitejs/plugin-react` 等未被 hoist 到根，与主工作区结构一致），非本版本代码问题。
4. 计划中的"worker 手动端到端"超出预期完成：除手动调用 worker 外，还以 ZCode 的调用方式（stdin 管道 + 立即 exit + detached）实测了 hook 入口全链路。

## 测试与验收结果

| 验收项（plan.md） | 结果 |
|---|---|
| 单测 + 根 npm test + npm run build 全绿 | ✅ 插件 21 个单测过；根 `npm test` 114 个全过；根 `npm run build` 全绿 |
| 安装产物纯 JS | ✅ `node --input-type=module` 直接 import dist/hook.js、dist/worker.js 成功 |
| 实时端到端 | ✅ 手动全链路：stdin → hook（exit 0 立即返回）→ detached worker → PUT → 服务端 201/200，messages 107→128 逐轮增长；title/cwd/ts 取自源数据；工具产出在 raw、含 reasoning；message 层无 todo_reminder/timeline 注入物 |
| 回填幂等 | ✅ 本机 11 个顶层会话（subagent 子会话已跳过）；连续两轮全量回填后服务端仍恰好 11 个会话 |
| 日志只记元数据 | ✅ `~/.config/session-hub/logs/zcode-worker.log` 仅记 session_id/status/messages 数 |
| 失败路径 | ✅ 服务端不可达时 hook 仍 exit 0（不阻塞 ZCode），worker 记 error 元数据日志 |

## 遗留事项

1. **用户侧实时 e2e 未做**：需在 Settings → Plugin Management 注册本地 marketplace（仓库 `plugins/` 目录）并启用 session-hub，然后新开 ZCode 会话跑两轮验证（hook 配置只在会话启动时加载）。同时确认 hooks.json 相对路径是否解析，不生效则切 `dist/hooks-absolute.json`。
2. **探针清理**：`~/.zcode/cli/config.json` 的探针 hooks（指向 `.scratch/zcode-hook-probe/`）仍在运行，待用户确认后禁用；`.scratch/` 已 gitignore，永不提交。
3. PermissionRequest / PostToolUseFailure 的 transcript 仍无有效样本（0 字节），不影响本方案（不使用 transcript）。
4. subagent 子会话不采集（按计划 0.1.0 范围外）。

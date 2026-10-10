# 0.1.0 — Claude Code 采集插件：实时 hook 上报 + 历史回填

## 实际改动

**新增 `plugins/claude-code/`**
- `.claude-plugin/plugin.json`（name `session-hub-claude-code`）
- `hooks/hooks.json`：Claude Code 插件格式（包装 `{"hooks":{...}}`，事件 UserPromptSubmit / Stop / SessionEnd，
  条目 `{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\"","timeout":10}`）
- `src/transcript.ts`：JSONL 读取 + entry 过滤 + assistant 按 `message.id` 聚合 + tool_result 按 `tool_use_id` 归并
  + **thinking → `{type:"reasoning", text}`**（契约归一化点，transcript.ts:194）
- `src/transform.ts`：归一化为 `sessionUpsertSchema`（title/cwd/时间戳/截断）
- `src/hook.ts` / `src/worker.ts`：stdin → temp file → spawn detached worker → exit 0；worker 读 transcript → 上传
- `src/config.ts`：`SESSION_HUB_URL`/`SESSION_HUB_TOKEN` → `~/.config/session-hub/config.json`，未配置静默退出
- `src/backfill.ts`：扫 `~/.claude/projects/*/*.jsonl`（跳过 `subagents/`），支持 `--since` / `--dry-run`
- `scripts/build.mjs`（esbuild，零运行时依赖产物）、`scripts/install.mjs`（构建 + 安装指引）
- `test/`：backfill / config / hook / transcript / transform 五个用例集
- `develop-doc/0.1.0/{plan,summary}.md`

**新增 `plugins/.claude-plugin/marketplace.json`**（本地 marketplace `session-hub`，与 zcode 的 `plugins/marketplace.json` 共存）

**修改**：根 `package.json`（build 链补 typecheck、install 脚本）；`AGENTS.md`（仓库结构 + 外部事实表补 Claude Code 行）

## 与计划的偏差及原因

| 偏差 | 原因 | 处理 |
|---|---|---|
| hook 条目用 `type:"command"` + `${CLAUDE_PLUGIN_ROOT}` 展开 | 初版误用 zcode 的方言（`type:"process"` + `args` + 相对路径）；Claude Code 官方格式为 `type:"command"` 单命令串，且 hook 的 cwd 非插件目录，相对路径解析不到 | 已按官方 plugin-dev hook 文档修正，并经真实链路验证 |
| `package.json` 仅保留 `esbuild` devDependency | 初版自带 `@types/node`/`typescript`/`vitest`，与仓库统一工具链重复 | 对齐 zcode 形态 |
| 插件名 `session-hub-claude-code` | 与 zcode 的 `session-hub` 区分，避免两个 marketplace 同名插件混淆 | 安装命令为 `/plugin install session-hub-claude-code@session-hub` |

## 测试/验收结果

- `npm run build`（worktree 根）：**全绿**（含 `typecheck -w @session-hub/claude-code-plugin`）；插件产物
  `dist/{hook,worker,backfill}.js` 生成，零外部 runtime 依赖
- `npm test`（worktree 根）：**52 文件 / 385 用例全过**；其中插件自身 5 文件 / 40 用例全过
- **真实端到端**：`claude -p ... --plugin-dir <worktree>/plugins/claude-code` 跑一轮 → 服务端
  `GET /v1/sessions?agent=claude-code` 返回该会话（2 条消息，`source_id` 与本地 sessionId 一致）
  → 证明 hooks.json 修复后 hook 确实被 Claude Code 触发、worker 上传成功
- **回填**：`node dist/backfill.js --dry-run` → 扫到 6 个会话（正确跳过 `subagents/`），逐条列出消息数
- **契约**：thinking 块归一为 `{type:"reasoning", text}`，由 `transcript.test.ts` 锁定
- **安全**：测试与日志仅用合成 fixture / 元数据，无真实转写正文、无 token（已 grep 校验）

## 遗留事项

1. **连续多轮验收未做**：验收标准 3（连续 5 轮 `updated_at` 单调前进、无重复消息）尚未跑
2. **reasoning 语义检索实测**：验收标准 4（对某条思考做语义搜索命中）尚未验证
3. **subagent 不采集**：0.1.0 只采主会话；`SubagentStop` 事件的 `transcript_path` 是否指向 subagent 文件未验证
4. **compact（上下文压缩）后的转写结构**未遇到，兼容性待验证
5. 插件需**重启 Claude Code** 才生效（hooks 启动时加载），安装说明已写入 `install.mjs` 输出

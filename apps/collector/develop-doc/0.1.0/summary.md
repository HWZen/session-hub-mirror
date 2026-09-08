# 0.1.0 开发记录：WorkBuddy Hook 推送式采集

## 实际改动

- `apps/collector` 包落地（name `@session-hub/collector`，version 0.1.0）：
  - `src/workbuddy/config.ts`：复用 `~/.config/session-hub/config.json`（baseUrl/token/timeoutMs），env `SESSION_HUB_URL`/`SESSION_HUB_TOKEN` 优先，与 opencode 插件同构
  - `src/workbuddy/parse.ts`：transcript JSONL → `SessionUpsertInput` 防御式解析器（坏行跳过、非法 role 跳过、`<user_query>` 提取、纯 `<system-reminder` 丢弃、text 1MB 截断、messages 保留尾部 5000、title 取首条用户文本截 100 字符、时间戳取行内时间首/末行、session_id 缺失时回退 transcript 文件名）
  - `src/workbuddy/upload.ts`：PUT `/v1/sessions` + Bearer + AbortController 超时
  - `src/workbuddy/hook.ts`：入口 stdin JSON → parse → zod safeParse（`sessionUpsertSchema`）→ upload；**stdout 恒为空**、诊断走 stderr + `~/.config/session-hub/workbuddy-hook.log`（仅元数据无正文）、**任何失败一律 exit 0**
  - `scripts/workbuddy-probe.mjs`：采样探测（stdin JSON 落盘 + transcript 头尾各 N 行拷贝，`WB_PROBE_DIR`/`WB_PROBE_HEAD`/`WB_PROBE_TAIL` 可调，默认落 `apps/collector/data/probe/`，已 gitignore）
  - `config/workbuddy-hooks.sample.json`：hooks JSON 片段（Stop + SessionEnd）+ 安装步骤说明
  - `test/parse.test.ts`（16 例）、`test/hook.test.ts`（10 例，含真实 HTTP fake server 验证 payload/Bearer/超时不阻塞）、`test/config.test.ts`（3 例）
- 根 `package.json`：build 追加 `npm run typecheck -w @session-hub/collector`
- 根 `vitest.config.ts`：test include 追加 `apps/**/*.test.ts`
- 根 `.gitignore`：追加 `apps/collector/data/`

## 与计划的偏差

- hook 入口增加 `sessionUpsertSchema.safeParse` 客户端校验（计划未明确要求）：上传前兜底，schema 不合时 exit 0 + 诊断，避免服务端 400 黑盒
- `parse.ts` 对"混有 `<system-reminder` 的正常用户文本"采取**剥离 reminder 块后保留其余文本**策略（plan 写的是"纯 reminder 丢弃、正常文本保留"，实现按此细化，含未闭合 reminder 块兜底剥离）
- vitest include 与根 build 脚本的接入位置与计划一致，无其他结构性偏差

## 测试/验收结果

- 根目录 `npm test`：23 文件 180 例全绿（含 collector 29 例）
- 根目录 `npm run build`：全绿（tsc -b + 三插件 typecheck + web 构建）
- CLI 冒烟（真实 tsx 进程）：
  - hook.ts：stdin JSON + 真实 transcript 文件 → 解析 → 上传（指向不可达地址）→ stderr 诊断 `upload failed ... fetch failed` → exit 0，stdout 静默 ✅
  - workbuddy-probe.mjs：stdin JSON → `stdin/<ts>-Stop.json` + `transcripts/*.head/.tail.jsonl` 落盘，exit 0 ✅

## 人工验收（待用户执行，见遗留事项）

按 plan 任务 6 的实测链路（挂 hook → `/hooks` 面板确认 → 真实会话采样 → 服务端可见）尚未执行，
原因：需要真实 WorkBuddy 会话配合与 `/hooks` 面板人工确认，无法在本开发会话内自动完成。

## 遗留事项

1. **实测与正式安装**（合并 master 后）：
   - 把 `config/workbuddy-hooks.sample.json` 的 hooks 块合并进 `~/.workbuddy/settings.json`（样例命令指向主工作区绝对路径 `D:/Github/session-hub/...`，故须先合并 master 使 collector 代码就位）
   - WorkBuddy 内 `/hooks` 面板审查确认一次（外部改文件不直接生效）
   - 真实会话触发 Stop/SessionEnd，验证 `GET /v1/sessions?agent=workbuddy` 可见、Web 检索命中；诊断日志 `~/.config/session-hub/workbuddy-hook.log`
2. **transcript JSONL 行 schema 实测修正**：解析器按 Claude Code 式假设实现（`type`/`message.role`/`message.content`/`timestamp`），若 probe 采样出实际 schema 有出入，按样本修正 `parse.ts`（防御式结构已就位，改动面小）
3. 桌面端（v5.5.3）会话是否触发 hook 未证实；resume 时 session_id 是否复用未证实——实测后回填结论
4. 实测通过后再更新根 `plan.md` / `AGENTS.md` 的 WorkBuddy 采集方式事实（轮询 → hook 实时推送为主、文件回填兜底）——本次提交按 plan 约定**未**提前改动这两处

## 环境备忘（开发过程发现并修复，与本版本代码无关）

- 主工作区 `node_modules/@session-hub/*` 五个 workspace junction 仍指向旧仓库位置 `D:\Download\session-hub`（搬家遗留断链），已重建指向 `D:\Github\session-hub`；否则 `tsc -b` 无法解析 `@session-hub/shared`
- worktree 无 node_modules（gitignore），采用 junction 复用主工作区依赖（根 `node_modules` + `server/apps/web/node_modules`）

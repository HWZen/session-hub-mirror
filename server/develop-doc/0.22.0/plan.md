# 0.22.0 — 对话视图过滤：非 full 仅保留用户内容与助手正文

## 需求描述

用户反馈：非 full 对话视图（`GET /v1/sessions/:id` 以及 Web 会话详情页的对话流）里混入了大量不属于对话的内容：

- opencode V2 宿主写入会话历史的 **system 消息**（Code Mode 工具目录变更等系统提示词，单条可达 46KB）；
- 注入型 **synthetic**（AGENTS.md 指令块、system-reminder 等）与轮次结束 **idle** 标记；
- 每步一条的 assistant 消息中**无正文**的步骤（仅 reasoning/工具调用）。

要求：非 full 对话视图**只展示「用户内容 + 助手正文」**，系统提示词等一律不出现；完整数据（含 raw）仍由 `/v1/sessions/:id/full` 提供，数据库与检索不受影响。

## 侦察事实（2026-10-13 实测）

1. 非 full 数据源：`server/apps/server/src/routes/sessions.ts` 的 `GET /:id` → `dbsessions.getConversation`，当前为 `SELECT idx, role, text, ts FROM messages WHERE session_id = ? ORDER BY idx`，**不过滤 role**。
2. Web 会话详情页 `session-detail.tsx` 由 `api.getSession` → `/v1/sessions/:id/full` 渲染对话列表（`s.messages.map(...)`）。因此页面与 non-full 需同时收紧；页面数据源仍保留 /full（保证「原始 JSON」折叠与元数据完整）。
3. 本机真实会话实测：145 条消息 = user 5 / assistant 120（其中 74 条无正文，仅 reasoning+tool step）/ system 3 / synthetic 8 / idle 9；与源会话逐条一致（fidelity 已由插件侧验收覆盖），本次只改**视图语义**。
4. `routes/help.ts` 与 `skills/session-hub/SKILL.md` 均在描述 `/:id` 为「对话消息」，需同步新语义。
5. 现有测试：`server/apps/server/test/sessions.test.ts`「GET /:id 只返回对话消息（idx/role/text/ts），不含元数据与 raw」；`help.test.ts` 文档断言。均需相应更新。

## 方案

### 过滤规则（唯一语义，两端一致）

对话视图消息 = **`role ∈ {user, assistant}` 且正文非空**（`(text ?? "").trim() !== ""`）。

- assistant 只保留有正文的步骤；纯 reasoning/工具步骤不进入对话视图（raw 仍在 /full）；
- user 行按同一非空规则（正常都有正文）；
- system / synthetic / idle 及未来新增的标记类 role **一律不进入**（白名单：只有显式列入 `user`/`assistant` 的 role 才可能展示）；
- **保留原始 `idx`**（允许不连续），保证与 /full、raw、检索结果的对应关系不破坏。

### 变更点

| 位置 | 变更 |
|---|---|
| `apps/server/src/db/sessions.ts#getConversation` | 在映射后按上述规则过滤（SQL 保持简单；非空判定用 JS `trim`，与前端同语义） |
| `apps/web/src/lib/conversation.ts`（新增）+ `conversation.test.ts` | 对话视图过滤纯函数（与后端同规则），含单测 |
| `apps/web/src/routes/sessions/-components/session-detail.tsx` | 对话列表渲染前调用过滤函数 |
| `apps/server/src/routes/help.ts` | `GET /v1/sessions/:id` 的 summary/description/returns 更新（只含用户内容与助手正文；完整内容走 /full） |
| `skills/session-hub/SKILL.md` | `/:id` 描述行同步 |
| `apps/server/test/sessions.test.ts` | 更新/新增用例：构造含 system/synthetic/idle/空正文 assistant 的会话，断言仅返回 user+正文 assistant、idx 保序、404 语义不变 |

**不变**：`/full`、`/full_length`、列表 `message_count`（仍为归档总数，不是对话行数）、数据库 schema、search/grep（基于全量 chunk 的检索继续完整）。

### 决策点（已定）

- 只收紧**视图**，不删除、不改动存储与索引——「存得全、找得到」不变。
- 页面不加「已隐藏 N 条」提示（保持对话干净；完整内容走 /full）。
- 列表 `message_count` 不改。

## 涉及文件

```
server/
  package.json                                          # 0.21.1 → 0.22.0（已完成）
  apps/server/src/db/sessions.ts                        # 对话视图过滤
  apps/server/src/routes/help.ts                        # /:id 文档语义
  apps/server/test/sessions.test.ts                     # 用例更新/新增
  apps/web/src/lib/conversation.ts                      # 新增：过滤纯函数
  apps/web/src/lib/conversation.test.ts                 # 新增：单测
  apps/web/src/routes/sessions/-components/session-detail.tsx  # 接入过滤
  develop-doc/0.22.0/                                   # 本档
skills/session-hub/SKILL.md                             # /:id 描述同步
```

基线：本分支 `0.22.x-server-dev` 基于 `feature/0.21.0` @ `4d0ad25`（服务端 0.21.1，线上在飞；0.21 线尚未合入 master）。

## 任务清单

- [ ] worktree 初始化：`server/.env`（PORT 避开 7428、`SH_DB_PATH` 指向本 worktree 的 `server/data/`）、`server/config/providers.local.json`、DB 拷贝（拷贝前停主工作区服务端）
- [ ] 服务端过滤实现 + `sessions.test.ts` 用例（含边界：全空文本、trim、软删 404）
- [ ] Web 过滤函数 + `session-detail.tsx` 接入 + 单测
- [ ] `help.ts` 与 `SKILL.md` 文档同步
- [ ] 根 `npm test` + `npm run build` 全绿
- [ ] 手验：dev 起服务 + 前端联调，用本机真实多类型会话核对 `/v1/sessions/:id` 与详情页
- [ ] `develop-doc/0.22.0/summary.md` + 提交

## 验收标准

1. 含 system/synthetic/idle/无正文 assistant 的会话：`GET /v1/sessions/:id` 仅返回 user 与有正文 assistant；idx 保留原值且升序；不存在/已软删仍 404。
2. 同一会话的 `/full`、`/full_length`、列表响应在改动前后语义不变（消息总量含全部角色与 raw）。
3. Web 详情页对话流只显示上述消息；可见行「原始 JSON」正常；标题/徽章/时间等其余部分不变。
4. 根 `npm test`、`npm run build` 全绿。
5. help 与 SKILL.md 的描述与新语义一致。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 外部 Agent 依赖 non-full 曾返回全量 role | 本需求即为收紧语义；help 与 SKILL.md 明确写清并指向 /full |
| 前后端过滤规则漂移 | 两端各自单测同一组用例（空串/空白/缺失文本、白名单、idx 保序） |
| 未来新增 role 误入对话视图 | 白名单默认排除；新增需显式加入并补测试 |
| SQL trim 语义（仅去空格）与 JS trim 不一致 | 非空判定统一放在 JS 侧，SQL 不做文本过滤 |

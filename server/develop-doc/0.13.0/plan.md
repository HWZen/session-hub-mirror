# 0.13.0 会话详情接口拆分：messages / full / full_length

## 需求描述

拆分 `GET /v1/sessions/:id` 的返回内容：

- `GET /v1/sessions/:id`：**只返回对话信息**（messages 数组，仅 `idx/role/text/ts`，不含会话元数据与消息 `raw`）
- 新增 `GET /v1/sessions/:id/full`：返回全部信息（即 0.12.0 的 SessionDetail：会话记录 + messages 含 raw）
- 新增 `GET /v1/sessions/:id/full_length`：返回该会话 full 内容的大小（字节）

## 现状（侦察结论，2026-09-10）

- `routes/sessions.ts` 的 `GET /:id` 直接返回 `repo.get(id)` = SessionDetail（11 个会话字段 + messages），无任何裁剪
- `repo.get()` 单次查询 sessions 行 + 全量 messages（含 raw JSON 解析）；无仅取 messages 的轻量方法
- 消费方三处：
  1. Web 详情页 `session-detail.tsx`：**同时用元数据**（title/agent/machine/cwd/indexed_*/created_at/updated_at/source_id）和 messages ⇒ 不能直接吃"仅 messages"，需改调 /full
  2. `skills/session-hub/SKILL.md` 192 行：文档写"详情，含全部消息"，需同步
  3. `help.ts` endpoints 白名单：`GET /v1/sessions/:id` 已登记；新端点不登记则 `?help=1` 404
- 测试：`sessions.test.ts` 58/193 行断言 detail 结构；`help.test.ts` 断言 `/v1/sessions/:id` 文档匹配（`matchPath` 按 `/` 分段比较，`:id/full` 两段 vs `/:id` 一段互不误匹配，已验证算法兼容）
- Hono 路由：`/:id`、`/:id/full`、`/:id/full_length` 段数不同，无匹配冲突

## 方案

### 1. `packages/shared/src/api.ts`
- `packages/shared/src/session.ts` 新增 `ConversationMessage { idx, role, text, ts }`；`MessageRecord` 改为 extends 它再加 `raw`
- 新增 `SessionMessagesResponse { messages: ConversationMessage[] }`
- 新增 `SessionFullLengthResponse { full_length: number }`（单位：字节）
- /full 响应类型复用既有 `SessionDetail`（session.ts），不新建别名

### 2. `server/apps/server/src/db/sessions.ts`
- 新增 `getConversation(id): ConversationMessage[] | null`：先 `SELECT deleted_at FROM sessions WHERE id = ?` 做存在性 + 软删除校验（null = 不存在或已删除），再只查 `idx, role, text, ts`（**不取 raw**）按 idx 排序
- `get()` 保持不变，供 /full 与 full_length 使用

### 3. `server/apps/server/src/routes/sessions.ts`
- `GET /:id` → `repo.getConversation(id)`；null → 404；否则 200 `{ messages }`（每项仅 idx/role/text/ts）
- `GET /:id/full` → `repo.get(id)`（原逻辑原样迁移）；null → 404
- `GET /:id/full_length` → `repo.get(id)`；null → 404；否则 `{ full_length: Buffer.byteLength(JSON.stringify(detail)) }`
  - 口径：**等于 /full 响应体序列化后的字节数**（UTF-8），非 DB 存储字节；实现简单且与 /full 严格一致
  - 大会话会整体序列化一次，可接受（消息上限 5000 条/会话）

### 4. `server/apps/server/src/routes/help.ts`
- `GET /v1/sessions/:id`：summary 改为"获取会话对话消息（仅 idx/role/text/ts，不含元数据与 raw）"，returns 更新
- 新增两条：`GET /v1/sessions/:id/full`（全量详情）、`GET /v1/sessions/:id/full_length`（full 响应体字节数）

### 5. Web `server/apps/web/src/lib/api.ts`
- `getSession(id)` 改调 `/v1/sessions/:id/full`；`session-detail.tsx` 零改动（数据结构不变）

### 6. 文档同步
- 根 `plan.md` §7 API 表：`:id` 行改为"对话消息（仅 messages）"；新增 `/full`、`/full_length` 两行
- `skills/session-hub/SKILL.md`：接口列表同步三处

### 明确出界
- 不动 PUT / DELETE、列表、搜索/grep；不改 DB schema；不加新 DB 连接点
- /v1/sessions/:id 不带任何元数据字段（含 id），也不带消息 raw——严格按"只返回对话信息"

## 涉及文件

- 根 `plan.md`（§7 API 表）
- `server/package.json`：version 0.12.0 → 0.13.0（已完成）
- `packages/shared/src/session.ts`、`api.ts`
- `server/apps/server/src/db/sessions.ts`、`routes/sessions.ts`、`routes/help.ts`
- `server/apps/web/src/lib/api.ts`
- `skills/session-hub/SKILL.md`
- `server/apps/server/test/sessions.test.ts`（`help.test.ts` 视断言受影响情况）
- 本档 `plan.md` / `summary.md`

## 任务清单

1. shared：`ConversationMessage` + 两个响应类型
2. repo：`getConversation(id)`（不取 raw）
3. routes/sessions.ts：三路由改造/新增
4. help.ts：三条端点元数据
5. Web：`api.ts` getSession → /full
6. 文档：根 plan.md §7 + SKILL.md
7. 测试：sessions.test.ts 改造 + 新增三接口用例，`help.test.ts` 按需
8. `npm test` + `npm run build` 全绿，写 summary.md，提交

## 验收标准

- `GET /v1/sessions/:id` 返回 `{ messages: [{ idx, role, text, ts }] }`：不含 id/agent/machine 等元数据字段，也不含消息 `raw`；响应体显著小于 /full
- `GET /v1/sessions/:id/full` 返回完整 SessionDetail（含消息 raw），与 0.12.0 的 `GET /v1/sessions/:id` 行为一致
- `GET /v1/sessions/:id/full_length` 返回 `{ full_length: N }`，N 为对应 /full 响应体 UTF-8 字节数（测试里用 `Buffer.byteLength(JSON.stringify(full))` 断言相等）
- 不存在或已软删除的会话：三个接口均 404
- `?help=1` 能发现三个端点且文档准确
- Web 详情页元数据 + 消息渲染不回退（内部改走 /full）
- 根目录 `npm test` + `npm run build` 全绿

## 非目标

- messages 分页/裁剪参数（后续按需）
- full_length 的 DB 存储字节口径或缓存
- 列表接口的返回裁剪

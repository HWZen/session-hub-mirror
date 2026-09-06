# 0.11.0 关键词 grep 检索（LIKE 子串）

## 需求描述

给会话正文加传统 grep 式关键词检索：字面子串匹配，与向量语义检索并列：

- 检索范围：`messages.text`（+ 会话标题子串过滤 `title`）；可与既有结构化过滤组合（agent / machine / source_id / 时间范围）
- API 与 Web 一起做：检索页加"语义/关键词"模式切换，会话列表加标题过滤框
- 不依赖 embedding 提供商（0.10.0 遗留：语义搜索因提供商链未通不可用，本功能正好补空档）
- 实现方式用户已定稿：**LIKE 子串扫描，不做 FTS5**

## 现状（侦察结论，2026-09-06）

- `messages.text` 是普通 TEXT 列：无 FTS 表、无 LIKE 查询，`/v1/sessions` 过滤不含任何文本条件；全仓无 grep/keyword/fts 占位
- 根 plan.md §3"查询能力"原只有 CRUD + 语义搜索；grep 从未被否决，属全新增（本版已补记，§7 API 草案同步加 `GET /v1/grep`）
- upsert 语义为整会话删除重插（单事务），且 `messages.id` 是 AUTOINCREMENT、重传会变 ⇒ **grep 结果引用 session_id + idx，不引用 message_id**
- `routes/help.ts` 的 `endpoints` 数组是 `?help=1` 的白名单，新端点不登记即 404 "endpoint not documented"
- 测试基建现成：`test/helpers.ts` 的 `makeDb()`（临时目录真实文件库，journal_mode=TRUNCATE）/ `buildApp()`（FakeEmbedProvider）/ `putSession()`
- FTS5 否决理由：中文为主的内容里默认分词器无效，trigram 又要求 ≥3 字符（两字中文词必须 LIKE 兜底），两套逻辑都要写；LIKE 零迁移、零写放大（upsert 本就整会话重插），个人库规模（十万级消息）毫秒~秒级；数据量上涨再升级 FTS5，接口不变

## 方案

### 1. `packages/shared/src/session.ts`
- `sessionFilterSchema` 增可选 `title`：标题子串包含
- 新增 grep 查询 schema：`q`（1–256 字符必填）、`case_sensitive`（可选，默认否；仅 ASCII 折叠，与 SQLite LIKE 语义一致）、`limit`（1–200 默认 50，对齐 /v1/sessions）、`offset` ≥ 0、filters 复用 `sessionFilterSchema`
- 类型：`GrepResponse`（total / limit / offset / items）

### 2. `server/apps/server/src/db/grep.ts`（新）
- `grepMessages(db, q, caseSensitive, filters, { limit, offset })`：
  - q 中 `\` `%` `_` 转义后 `m.text LIKE '%' || ? || '%' ESCAPE '\'`
  - 大小写不敏感用 `instr(lower(m.text), lower(q))` 定位（与 LIKE 折叠域一致），敏感模式 `instr()` 原样
  - JOIN sessions 复用 `buildSessionFilter`；`ORDER BY s.updated_at DESC, s.id, m.idx`；LIMIT/OFFSET **按命中消息行计**；`COUNT(*)` 同条件得 total
  - JS 按会话分组，每会话最多 5 条片段（对齐语义搜索 MAX_SNIPPETS_PER_SESSION）
  - snippet：命中前后取上下文、总长 ≤500 字符（对齐 SNIPPET_MAX_CHARS），返回 `match_start` = 命中在片段内的偏移（前端高亮预留）
- 返回 `items: [{ session: SessionRecord, hits: [{ message_idx, role, ts, snippet, match_start }] }]`

### 3. `server/apps/server/src/db/sessions.ts`
- `buildSessionFilter` 加 `title` 条件：`title LIKE '%' || ? || '%' ESCAPE '\'`；LIKE 转义抽成共享小函数（grep 与 title 共用）

### 4. `server/apps/server/src/routes/grep.ts`（新）+ `app.ts`
- `GET /v1/grep`：query 参数收集（风格同 sessions 路由 FILTER_KEYS）→ zod 校验 → 400 带 issues / `grepMessages` → 200
- `app.ts` 挂 `app.route("/v1/grep", ...)` 于 `/v1/search` 旁，自动获得 bearerAuth + helpInterceptor

### 5. `server/apps/server/src/routes/help.ts`
- `endpoints` 数组登记 `GET /v1/grep`（queryParams 从 schema 生成参数说明）

### 6. Web
- `lib/api.ts`：`grep(params)` 走 GET + 现有 `buildQuery`
- `routes/search.tsx`：URL 加 `mode`（semantic | keyword）；表单加模式切换；queryFn 按 mode 分派（`api.search` / `api.grep`）；结果卡复用——关键词模式隐藏距离 Badge 与 provider 摘要行；页头文案按模式切换
- `routes/sessions/-components/session-list.tsx`：过滤行加标题过滤输入框（title 参数）

### 7. `skills/session-hub/SKILL.md`
- 示例章节补 `GET /v1/grep` 一小节（接口动态发现不受影响，仅为示例完整）

### 不变项 / 明确出界
- 不建 FTS5 表、不加迁移（LIKE 扫描零 schema 变更）；不引入新 DB 连接点（存储红线不动）
- `raw` JSON 字段不参与检索；不做正则；不做前端高亮渲染（match_start 已预留）

## 涉及文件

- 根 `plan.md`：§3 查询能力行（+ 关键词子串检索）；§7 API 草案表（+ `GET /v1/grep`）
- `server/package.json`：version 0.10.0 → 0.11.0
- `packages/shared/src/session.ts`
- `server/apps/server/src/db/grep.ts`（新）、`db/sessions.ts`、`routes/grep.ts`（新）、`routes/help.ts`、`app.ts`
- `server/apps/web/src/lib/api.ts`、`routes/search.tsx`、`routes/sessions/-components/session-list.tsx`
- `skills/session-hub/SKILL.md`
- `server/apps/server/test/grep.test.ts`（新）、`test/sessions.test.ts`
- 本档 `plan.md` / `summary.md`

## 任务清单

1. shared：`sessionFilterSchema` + title、grep schema、`GrepResponse` 类型
2. db：`grep.ts` + `buildSessionFilter` title + 共享 LIKE 转义函数
3. `routes/grep.ts` + `app.ts` 挂载 + `help.ts` 登记
4. 测试：`grep.test.ts` + `sessions.test.ts` 增补，`npm test` / `npm run build` 全绿
5. Web：`api.ts` / `search.tsx` 模式切换 / `session-list.tsx` 标题过滤
6. `SKILL.md` 示例 + `summary.md`，提交（可拆多个，`模块: 摘要`）

## 验收标准

- `GET /v1/grep?q=` 按子串命中消息，按会话分组返回片段；`?help=1` 可见该端点文档
- q 含 `%` `_` `\` 时按字面匹配；默认大小写不敏感，`case_sensitive=1` 时敏感
- 过滤组合可用：agent / machine / source_id / 时间范围 / title；软删除会话不出现
- 分页 limit/offset 语义正确，total 为命中消息总数
- 关键词检索不依赖 embedding 提供商
- 检索页可切换语义/关键词；会话列表可按标题过滤
- 根目录 `npm test` + `npm run build` 全绿

## 非目标

- 正则匹配
- FTS5 索引（数据量上涨后的性能升级路径，接口不变）
- 前端命中高亮渲染

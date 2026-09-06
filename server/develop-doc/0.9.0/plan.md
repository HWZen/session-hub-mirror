# 0.9.0 — Agent Skill 与接口动态发现

> 起因（2026-09-06，用户决策）：为 session-hub 提供一个"给 Agent 用的 skill"，工作方式参照
> 示例组织客户画像系统 skill（样例见 D:\temp\skill.md）：一份 SKILL.md + HTTP 直调，零 SDK 依赖，
> 任何能发 HTTP 请求的 Agent 即可操作本系统。
> 用户已拍板：① 认证**沿用现有固定 Bearer token**，不引入 agent token 绑定/吊销流；
> ② 接口信息走**服务端动态发现**（L0 索引 + L1 详情），SKILL.md 不固化接口清单；
> ③ skill 放**仓库独立目录**。本需求在 `0.9.0-dev` worktree 内全程开发。

## 现状（侦察结论）

- 端点全景（`/v1/*` 全部受 `bearerAuth` 保护，`/health` 免认证）：
  - `PUT /v1/sessions`（幂等 upsert，`agent`/`machine`/`source_id` 三元组）、
    `GET /v1/sessions`（filter + limit/offset 分页）、`GET /v1/sessions/:id`、`DELETE /v1/sessions/:id`
  - `POST /v1/search`（向量检索，`query` + `top_k` + `filters`；embedding 不可用时 503）
  - `GET /v1/stats`
  - `GET /v1/settings/providers`、`PUT /v1/settings/providers`、`POST /v1/settings/providers/test`、
    `POST /v1/settings/reindex`
  - `GET /health`
- 响应格式：各路由自由 JSON，**无统一 `{ok, code}` 壳**；错误统一 `{ error: string, issues? }`，
  语义仅靠 HTTP status（400/401/404/503/500）。
- 校验全走 zod（`sessionUpsertSchema` / `sessionFilterSchema` / `searchRequestSchema` /
  providers schema，位于 `@session-hub/shared`），schema 无 description 元数据。
- 认证：`auth.ts` 单一固定 token（`SH_AUTH_TOKEN`），timing-safe 比较，401 `{error:"unauthorized"}`。
- 上传成功响应：`{ id, created }`（0.8.0 起异步索引，响应不含 `indexed`）。

## 需求描述

1. **服务端动态接口发现**：
   - `GET /v1/help`（L0）：返回全量 `/v1` 端点索引（`path` / `method` / `summary`）+
     "任意接口附加 `?help=1` 查看详情" 的 hint。
   - 任意 `/v1` 业务接口附加 `?help=1`（L1）：返回该接口结构化说明
     （`summary`、`params`/body 字段表、`returns`、`example`、`errors`），**不执行业务逻辑**、
     不产生任何数据变更。
2. **Agent Skill 文档**：`skills/session-hub/SKILL.md`，参照齐道 skill 结构：
   基础信息 → 认证 → 接口发现 → 响应与错误 → 完整调用示例。
3. **不做的事（边界）**：
   - 不引入 agent token 管理（request/bind/status/revoke）——沿用固定 token（用户决策）。
   - 不统一响应壳（`{ok, code, message}`）——会破坏现有 Web 前端与 opencode 插件两个消费方；
     SKILL.md 如实描述现有格式即可。

## 方案

### 1. `routes/help.ts`（新增）

- 维护一份**端点描述注册表**：每条含 `path` / `method` / `summary` / `params`（含 body 字段）/
  `returns` / `example` / `errors`。L0 与 L1 均由注册表渲染，接口演进只改注册表一处。
- `GET /v1/help` 返回 L0 索引 + hint。
- `?help=1` 拦截：在 `app.ts` 于 `bearerAuth` 之后挂中间件，命中 `/v1/*` 且
  `query.help === "1"` 时查注册表返回 L1（404 若端点未收录）；未命中放行业务路由。
- `params` 来源：从 zod schema 派生字段表（不新增第三方依赖）。为防手写描述与 schema 漂移，
  测试中断言注册表字段名集合与对应 zod schema 的 shape keys 一致。

### 2. 各业务路由

- 业务逻辑零改动；sessions / search / stats / settings 的 summary、example、errors 收录进注册表。
- 错误口径收录：400（invalid body/filters，带 zod issues）、401、404、503（embedding unavailable）、500。

### 3. `skills/session-hub/SKILL.md`（新增，仓库根 `skills/`）

- §0 基础信息：API 基址（本机默认 `http://127.0.0.1:7428`；NAS 部署时由用户提供）、
  `Authorization: Bearer <token>`、JSON in/out。
- §1 认证：token 来自部署方（服务端 `SH_AUTH_TOKEN`）；skill 同目录 `config.json` 缓存
  `{ base_url, token }` 供复用——已有则直用，无则向用户索取一次后保存；401 时提示 token
  失效、重新索取。
- §2 接口发现：先 `GET /v1/help`（L0）→ `?help=1`（L1）→ 按 params 构造请求；文档不固化清单。
- §3 响应与错误：现有响应格式说明 + HTTP 状态码表（400/401/404/503）与可恢复性语义。
- §4 完整示例：上传会话（PUT upsert，三元组幂等）、列表过滤分页、向量搜索、删除、stats、
  触发 reindex。
- §5 约束提醒：对源会话文件只读；时间戳取源数据时间；日志不得打印会话正文。

### 4. AGENTS.md

- 仓库结构图补 `skills/session-hub/` 一行（随本版提交在分支内）。

## 涉及文件

- `server/package.json`（version 0.8.0 → 0.9.0）
- `server/apps/server/src/routes/help.ts`（新增）
- `server/apps/server/src/app.ts`（挂 help 路由 + `?help=1` 中间件）
- `server/apps/server/test/help.test.ts`（新增）
- `skills/session-hub/SKILL.md`（新增）
- `AGENTS.md`（仓库结构）

## 任务清单

1. ✅ 递增 version 0.9.0、本 plan.md（规划阶段，在 worktree 内完成）
2. help 注册表 + L0/L1 路由 + `?help=1` 中间件接线
3. 各端点元数据收录（sessions/search/stats/settings）
4. help 测试：L0 全量、L1 不执行业务逻辑（DB 无副作用）、未认证 401、未知端点
5. SKILL.md 编写
6. AGENTS.md 仓库结构更新
7. 根目录 `npm test` + `npm run build` 全绿；写 summary.md；提交（中文，`模块: 摘要`）

## 验收标准

- `GET /v1/help` 返回全部 `/v1` 端点索引；`PUT /v1/sessions?help=1` 等返回 L1 详情且
  不产生任何数据变更（测试断言 DB 状态不变）。
- `/v1/*` 未认证仍 401，help 也不例外（端点清单与会话库地址同样敏感）。
- SKILL.md 让一个"零上下文"Agent 照文档即可完成：拿 token → 发现接口 → 上传会话 → 搜索回来。
- 现有测试、Web 前端、opencode 插件行为不受影响；根目录 `npm test` / `npm run build` 全绿。

## 遗留事项

- 统一 `{ok, code}` 响应壳与 agent token 授权流本次明确不做；未来若 Agent 数量变多、
  需要细粒度权限/吊销时再立项。

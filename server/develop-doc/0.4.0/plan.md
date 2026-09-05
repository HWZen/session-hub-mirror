# 0.4.0 — 会话列表过滤支持 source_id

> 伴随 `plugins/opencode/develop-doc/0.1.0/`（opencode 插件）需求产生；背景、侦察与总体方案见该档。

## 需求描述

opencode 插件的删除镜像：本地 `session.deleted` 后，插件需按幂等键（`agent+machine+source_id`）定位服务端记录再 `DELETE /v1/sessions/:id`。当前列表过滤（`agent/machine/created_*`/`updated_*`）不含 `source_id`，无法定位。

## 方案

在既有 CRUD 上加一个可选过滤字段，不新增路由：

- `packages/shared/src/session.ts`：`sessionFilterSchema` 加 `source_id: z.string().min(1).max(256).optional()`
- `server/apps/server/src/routes/sessions.ts`：`FILTER_KEYS` 加 `"source_id"`
- `server/apps/server/src/db/sessions.ts`：`list()` WHERE 支持 `source_id` 精确匹配

## 任务清单

- [ ] 三处修改 + `sessions.test.ts` 补用例（按 source_id 过滤命中/空结果；与 agent/machine 组合）
- [ ] 根 `npm test` + `npm run build` 全绿

## 验收标准

- `GET /v1/sessions?agent=opencode&machine=<host>&source_id=<id>` 精确返回 0 或 1 条
- 既有过滤行为不回归

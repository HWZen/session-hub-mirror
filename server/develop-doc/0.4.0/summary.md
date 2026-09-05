# 0.4.0 summary — 会话列表过滤支持 source_id

## 实际改动

- `packages/shared/src/session.ts`：`sessionFilterSchema` 新增可选 `source_id`（min 1 / max 256）
- `server/apps/server/src/routes/sessions.ts`：`FILTER_KEYS` 加入 `"source_id"`
- `server/apps/server/src/db/sessions.ts`：`buildSessionFilter` 支持 `source_id = ?` 精确匹配
- `server/apps/server/test/sessions.test.ts`：新增「filters by source_id alone and combined with agent/machine」用例（命中/空结果/组合）

## 与计划的偏差

无。

## 测试/验收结果

- 根 `npm test` 68 用例全绿、`npm run build` 全绿
- 验收①：本地实测 `GET /v1/sessions?agent=opencode&machine=WORKSTATION-A&source_id=...` 精确返回 0/1 条
- 验收②：既有过滤（agent/machine/时间/分页/400 用例）全部通过，无回归
- 提供插件 0.1.0 删除镜像实测：PUT 假会话 → mirrorDelete 按三元组定位 found=1 deleted=1 → 列表归零

## 遗留事项

无。

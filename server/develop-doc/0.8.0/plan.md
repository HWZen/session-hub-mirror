# 0.8.0 — 上传接口异步索引

> 起因（2026-09-06，用户决策）：插件 backfill 逐个上传 session，而 `PUT /v1/sessions`
> 在请求内同步执行 `indexSession`（等 embedding 往返 + 写向量），导致 N 个 session 的
> backfill 总耗时 ≈ Σ(单 session 索引耗时)。用户确认改为异步索引。
> 用户的向量模型全部部署在自己机器上，抗不了并发——后台索引并发量必须保持 1（现状即串行，
> 本版不得引入并发）。

## 现状（侦察结论）

- `routes/sessions.ts` `PUT /`：`repo.upsert` 后 `await indexer.indexSession(id)` 再返回，
  响应含 `indexed: boolean`。全仓库唯一同步等索引入口。
- 后台 `AutoIndexer`（auto-index.ts）：单循环内逐个 `await indexSession`，并发量已是 1；
  `runOnce` 每轮最多 50 个 session，轮间由 `SH_AUTO_INDEX_INTERVAL_MS`（默认 30000）定时，
  `kick()` 可立即触发（已有，settings 保存 provider 时在用）。
- 索引失败不丢数据：session 已落库（`indexed_at IS NULL`），AutoIndexer 下轮自动补。
- `indexed` 响应字段的消费方：**无**。opencode 插件 `uploadSession` 只看 HTTP status；
  Web 前端不调 PUT。测试里有断言，需随本版更新。
- embed 调用粒度：`registry.embed(texts)` 把**单 session 全部消息文本一次性**塞进一个
  `input` 发给 provider（registry.ts），无分批。并发虽是 1，但超大 session 会形成
  超大 batch，可能压垮/超时本地推理服务。
- `POST /settings/reindex`（Web 手动补索引按钮）与 `npm run reindex`：独立的同步串行入口，
  用户手动触发，本版不动。

## 需求描述

1. **上传异步索引**：`PUT /v1/sessions` 落库后立即返回，不再同步等待索引完成；
   索引统一交给 AutoIndexer 后台执行。
2. **上传即触发**：上传成功（含 re-upsert 内容变更）后立即 `kick()` 后台补索引，
   不等默认 30s 定时器；backfill 场景下索引在后台以并发量 1 持续追平。
3. **并发量硬约束 = 1**：任一时刻至多 1 个在飞的 embedding 请求（AutoIndexer 串行保持）。
4. **embed 分批（顺带）**：`registry.embed` 将入参按 `SH_EMBED_BATCH_SIZE`（默认 32）
   拆成多批**串行**调用 provider 后按序合并，控制单请求 batch 上限，照顾本地推理服务。

## 方案

### 1. `routes/sessions.ts`

- `PUT /` 删除 `await deps.indexer.indexSession(id)`；落库成功后调用 `deps.onUpserted?.()`
  立即返回。
- `SessionRouteDeps` 改为 `{ repo, onUpserted?: () => void }`（不再持有 indexer）。
- 响应体改为 `{ id, created }`，**移除 `indexed` 字段**（无消费方，随版废止）。

### 2. `app.ts` / `index.ts` 接线

- `AppDeps` 增加 `onSessionUpserted?: () => void`，透传给 `sessionRoutes`。
- `index.ts` 注入 `onSessionUpserted: () => autoIndexer.kick()`（与现有
  `onProvidersSaved: () => autoIndexer.kick()` 同模式）。
- 测试环境不传 `onSessionUpserted` 时行为不变（可选回调）。

### 3. `embedding/registry.ts` 分批

- `embed(texts)`：批大小 ≤ N（构造参数或 setter，由 config 注入）时按现逻辑单批直发；
  超过 N 时按 N 切片**串行** await provider.embed，结果按序拼接后走原有
  `#validateVectors`/`#dims` 校验。failover（换 provider 重试）以整次调用为单位，
  不在半批上切换 provider。
- 串行是硬约束：禁止 Promise.all 并发批。

### 4. `config.ts`

- 新增 `SH_EMBED_BATCH_SIZE`：`z.coerce.number().int().min(1).default(32)`。

### 5. 不改的部分（明确出界）

- 插件端（`plugins/opencode`）零改动：只看 status code，`indexed` 字段废止不影响。
- `POST /settings/reindex`、`npm run reindex` 保持同步串行语义（手动触发，响应仍含
  indexed/failed/remaining 统计）。
- AutoIndexer 本体逻辑不动（串行、BATCH=50、kick 均沿用）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `server/apps/server/src/routes/sessions.ts` | PUT 异步化，移除 indexed 字段 |
| `server/apps/server/src/app.ts` | AppDeps 增加 onSessionUpserted |
| `server/apps/server/src/index.ts` | 接线 autoIndexer.kick |
| `server/apps/server/src/embedding/registry.ts` | embed 分批串行 |
| `server/apps/server/src/config.ts` | SH_EMBED_BATCH_SIZE |
| `server/apps/server/test/sessions.test.ts` 等 | 响应断言更新 + kick/分批新断言 |
| `server/package.json` | version 0.8.0 |

## 任务清单

1. [x] 升 `server/package.json` version → 0.8.0（规划阶段完成）
2. [ ] `PUT /v1/sessions` 异步化 + `onUpserted` 回调接线
3. [ ] `registry.embed` 分批串行 + `SH_EMBED_BATCH_SIZE`
4. [ ] 测试更新：移除/改写 `indexed` 响应断言；新增 kick 触发断言、分批断言
5. [ ] `npm test` + `npm run build` 全绿，写 summary.md

## 验收标准

- `npm test` + `npm run build` 全绿。
- `PUT /v1/sessions` 落库后立即返回 `{ id, created }`，响应不含 `indexed`；
  会话初始状态为未索引（`indexed_at IS NULL`）。
- 上传后 AutoIndexer 被立即触发（不等 30s 定时器），最终会话被后台索引
  （fake provider 测试验证 indexed_at 落位）。
- 任一时刻至多 1 个在飞 embed 请求（代码审查 + 串行测试断言）；
  单个 embed 请求 `input` 条数 ≤ SH_EMBED_BATCH_SIZE（分批测试断言）。
- provider 失败时整批 failover 语义不变；索引失败的会话保持未索引，由后台下轮补。
- 实测：backfill 多个 session 时上传阶段快速完成，索引在服务端日志（`[auto-index]`/`[index]`）中后台追平。

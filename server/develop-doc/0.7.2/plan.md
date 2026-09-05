# 0.7.2 — 旧模型空间向量不再自动清除

> 版本顺延说明（2026-09-06）：原规划编号 0.7.1；因当日先出现 vec0 影子表损坏需紧急修复，
> 修复占 0.7.1，本需求顺延为 0.7.2。

> 起因（2026-09-06，用户决策）：0.6.0 实现的 `storeEmbeddings` 在为会话写入新模型向量时，
> 会先清掉该会话在**所有**模型表的旧向量（0.7.0 summary 偏差 1 记录过与 plan 原文的冲突）。
> 用户明确要求：旧空间数据不自动清，切回旧模型时不必重新 embed。
> 本版本收回该行为，与根 `plan.md` §3 "旧空间数据保留但检索不可见" 对齐（无需改根 plan）。

## 需求描述

1. **补索引不清旧空间**：为会话补建活跃模型向量时，其他模型表中该会话的向量一律保留；
   切模型 A→B→A 来回切换时，只要会话内容未变，旧空间向量持续有效
2. **切回旧模型零成本恢复**：切回某模型时，若该模型表已覆盖会话全部可索引消息，
   直接置 `indexed`，不调用 embedding provider（保留旧空间数据的实际价值兑现）
3. 边界（保持不变，向用户明示）：**会话内容变更（re-upsert）时全模型表向量照常回收**——
   消息行删除重建、message id 全新，旧向量成为指向死行的孤儿，属失效数据清理，
   不属于"清旧空间"；内容更新过的会话回切旧模型需重新 embed（覆盖检查会发现不覆盖）

## 方案

### 1. `db/embeddings.ts`

- `clearSessionEmbeddings(db, sessionId)` **保留全表清理语义不变**，但调用方收窄为仅 `repo.upsert`
  （内容变更 → 所有模型的旧向量全部作废，必须回收，防止孤儿行膨胀/污染）
- `storeEmbeddings`：去掉 `clearSessionEmbeddings` 调用，改为事务内
  `ensureEmbeddingsTable` + **目标表定向 DELETE**（`DELETE FROM <table> WHERE message_id IN
  (SELECT id FROM messages WHERE session_id = ?)`）后再插入。
  定向清只服务幂等（vec0 表 `message_id PRIMARY KEY`，重复插入会撞主键），不再波及其他模型表
- 新增 `sessionVectorCoverage(db, sessionId, model): boolean`：
  - 表不存在 → false
  - `expected` = `COUNT(messages WHERE session_id = ? AND text <> '')`（与 `messageTexts` 口径一致）
  - `actual` = 同子查询限定下该模型表的行数
  - `expected > 0 && actual === expected` → true
  - 正确性依据：`messages.id` 为 AUTOINCREMENT，upsert 是 DELETE + 重插（id 单调不复用），
    因此"id 同时存在于 messages 与向量表" ⟹ 该向量由这条消息行文本算出 ⟹ 有效。
    覆盖检查只需比对 id 集合，无需校验文本

### 2. `indexing.ts`

- `SessionIndexer.indexSession`：rows 非空时，embed 之前先查
  `sessionVectorCoverage(db, sessionId, activeModel)`：
  - true → 直接 `setIndexed(sessionId, activeModel)` 并 log `[index] session=x covered by <model>, skip embed`，返回 true（不调 provider）
  - false → 原路径 embed → `storeEmbeddings` → `setIndexed`
- 空消息会话路径不变（无 rows 直接 `setIndexed`）

### 3. 不变项

- 无 DB schema 迁移、无 API 契约变化、无前端变化
- `repo.upsert` 的全表清理时机保持 0.6.0 偏差 3 的结论（在 `DELETE FROM messages` 之前）
- 检索只查活跃模型表，保留的旧空间向量天然不可见，无需改动

## 涉及文件

| 文件 | 动作 |
|---|---|
| `server/package.json` | version 0.7.1 → 0.7.2 |
| `server/apps/server/src/db/embeddings.ts` | storeEmbeddings 改定向清；新增 sessionVectorCoverage |
| `server/apps/server/src/indexing.ts` | indexSession 加覆盖检查跳过 embed |
| `server/apps/server/test/model-partition.test.ts` | 3 处"旧表被清"断言翻转；新增回切零 embed 用例 |
| `server/apps/server/test/auto-index.test.ts` | 补"runOnce 后旧 A 表行数不变"断言 |

## 任务清单

1. `db/embeddings.ts`：storeEmbeddings 定向清 + sessionVectorCoverage
2. `indexing.ts`：覆盖检查跳过 embed
3. `model-partition.test.ts` 断言翻转 + 回切用例；`auto-index.test.ts` 补断言
4. 根目录 `npm test` + `npm run build` 全绿
5. 写 `summary.md`

## 测试口径变化（model-partition.test.ts）

现有断言翻转（旧语义 → 新语义）：

| 位置 | 旧断言 | 新断言 |
|---|---|---|
| 逐会话重索引 s1 后 | A=1（s1 的 A 行被清） | A=3（s1、s2 的 A 行全保留） |
| reindex 全部完成后 | A=0 | A=3 |
| re-upsert s1 后 | A=0 | A=1（仅 s2 的 A 行保留；s1 内容变更被回收） |

新增用例：A 索引 → 切 B 补索引 → 切回 A → `runOnce()` 后
`FakeEmbedProvider.calls` 不增加（全程零 embed）、`setIndexed` 恢复到 A、A 空间检索命中。

## 验收标准

- 根目录 `npm test`、`npm run build` 全绿
- A 索引 → 切 B → 补索引：B 空间可检索、stats 未索引归零，**A 表行数不变**
- 切回 A：无任何 embed 调用（provider calls 计数不变），A 空间立即可检索、stats 归零
- 会话内容变更后：该会话所有模型表旧向量被回收；未变更会话的旧空间向量保留
- 重复补索引幂等（定向清保证不撞主键、行数不翻倍）

## 非目标 / 遗留

- **不提供手动清理旧模型空间的入口**：磁盘占用随历史使用过的模型数量增长（每模型一张 vec0 表），
  如后续 NAS 空间有压力，另立 MINOR 版本做「清理旧模型空间」维护操作（列出非活跃模型表 + 行数 + 删除）
- 不同模型 slug 撞名（如 `bge-m3` / `bge.m3` 同表）沿用 0.6.0 遗留，不处理
- 0.7.0 summary 偏差 1 由本版本收回，0.7.0 的 summary 与 commit 作为历史记录不改

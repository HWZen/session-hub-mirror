# 0.16.0 会话元数据进入首个向量切片

## 需求描述

当前语义索引只覆盖消息正文/思考，**会话自身元数据（`title` / `machine` / `agent` / `source_id` / `cwd`）完全不进向量空间**——用会话名、机器名、Agent 名去语义检索命中不到。本版把会话元数据拼进该会话**首个向量切片**的 embedding 输入，使元数据可被语义检索召回。

已确认字段范围（用户定）：`title` + `machine` + `agent` + `source_id` + `cwd`。不加时间戳（毫秒数对语义是噪声）。

## 现状（侦察结论，2026-09-10，基于 0.15.0 切片索引）

- 索引链：`indexing.ts:17 collectChunks` 只从 `messages.text` 与 `raw` 抽取的 reasoning 产出切片；`indexSession` 对 `pending.map(c => c.text)` 调 `registry.embed` 后 `storeChunks` 存储。**全程不读 sessions 元数据**。
- 切片表：`message_chunks(id, message_id, chunk_no, source, text, char_start)`，`message_id` **NOT NULL** 且 FK 指向 messages；向量表 `chunk_embeddings_<模型>(chunk_id PK, embedding)`。
- 检索：`search.ts` 查 `chunk_embeddings_<模型>` → `JOIN message_chunks` → `messages` → `sessions`；命中后会话元数据随 `session` 对象一并返回。
- `char_start` 记录切片在消息正文中的偏移；经检索路径确认**运行期未被消费**（仅存储）。
- `db/chunks.ts` 已有 `listChunkEmbeddingTables`（枚举 `chunk_embeddings_%` 虚表）与 `storeChunks`（事务内先 `clearSessionChunks` 再逐行插入），0005 删表可直接复用；`collectChunks` 有跨消息文本去重（`seen` 集合），`pending[0]` 即去重后的会话首个切片。
- 切片参数：`DEFAULT_CHUNK_MAX_CHARS = 1200`（`chunk.ts`）；header 拼接进首切片 embedding 输入后仍远小于 bge-m3 8K 上下文，无截断风险。
- `upsert` 已在事务内 `clearSessionChunks` + 重置 `indexed_at/indexed_model`，已索引会话被更新后走同一 `indexSession` 重建，本版无需改 upsert 路径。
- 重建触发：`listUnindexed` 口径 `indexed_at IS NULL OR indexed_model != 活跃模型`；0.15.0 迁移 `0004` 通过重置 flags + 删 `message_embeddings%` 触发全量重建。
- 仓库现有 0.15.0 切片索引已提交（分支 `0.15.0-server-0.2.0-collector-dev` 的 `a4446b9`/`548341c`），本版**基于切片索引**开发。

## 方案

### 决策：元数据只进"首切片"的 embedding 输入，不改存储文本

- 把元数据拼到该会话**第一个待索引切片**（按消息 `idx`、消息内 text→reasoning 顺序取 `pending[0]`）的**待嵌入文本**上。
- `message_chunks.text` **仍存原始切片文本**，不改：
  - 保持 `char_start` 语义对齐；
  - 检索 snippet 保持干净（元数据已随命中 `session` 对象返回，消费者能看到，不需要在片段里重复）。
- 只有首切片携带元数据（一个会话一条），符合"session 首个向量切片"的字面要求；不采用"每条切片都拼"，避免重复稀释。

### 1. 新增 `src/indexing/session-meta.ts`（纯函数）

- `buildSessionMetaHeader(meta: SessionRecord): string`：
  - 固定标签、稳定格式，例如：
    `会话元数据：标题=<title>；Agent=<agent>；机器=<machine>；源会话ID=<source_id>；工作目录=<cwd>`
  - `title` / `cwd` 为 null 或空白时**整段省略**；`agent` / `machine` / `source_id` 为 NOT NULL，始终包含。
  - 便于单测与后续调整措辞。

### 2. `src/db/sessions.ts`

- 新增轻量 `findById(id: string): SessionRecord | null`（`SELECT ${SESSION_COLUMNS} WHERE id = ?`），供索引器取元数据，**不加载 messages**（`get()` 会加载全量消息，不用）。不按 `deleted_at` 过滤（索引入口 `listUnindexed` 只产出未删除会话，防御性取到已删会话也只是多索引一次，无害）。

### 3. `src/indexing.ts`

- `indexSession` 流程：
  1. 取 `messages = messageSources(sessionId)`、`pending = messages.flatMap(collectChunks)`（不变）。
  2. 取 `meta = repo.findById(sessionId)`；`header = meta ? buildSessionMetaHeader(meta) : ""`。
  3. `embedInputs = pending.map((c, i) => (i === 0 && header !== "" ? `${header}\n${c.text}` : c.text))`。
  4. `registry.embed(embedInputs)`。
  5. `storeChunks` 仍以 `c.text`（原始）与对应 `vector` 落库。
- `pending.length === 0`（无任何切片，含空会话）时行为不变：仍 `storeChunks([])` + `setIndexed`（**本版不生成独立元数据向量**，见非目标）。
- 日志保持只记元数据/统计，不打印正文。

### 4. 迁移 `0005_session_meta_chunk`（`src/db/migrate.ts`）

元数据进入 embedding 后，旧向量空间内容已变，需全量重建：

1. `DELETE FROM message_chunks`（清旧切片行）。
2. 复用 `listChunkEmbeddingTables` 枚举并逐个 `DROP` 所有 `chunk_embeddings_%` vec0 虚表，再按 `chunk_embeddings_%` LIKE 兜底清残余影子表（参照 0004 `dropMessageEmbeddingsTables` 的两段式写法）。
3. `UPDATE sessions SET indexed_at = NULL, indexed_model = NULL`（关键：否则 `listUnindexed` 不认为需重建）。

重建仍由既有 auto-indexer / `npm run reindex` 入口自动完成，无需清库文件。

### 5. 文档

- 根 `plan.md` §3"索引粒度"决策行补一句：会话元数据（title/machine/agent/source_id/cwd）并入会话**首切片**的 embedding 输入，存储文本不变。
- `help.ts` / `SKILL.md` / Web：**无需改动**（无 API/响应结构变化，搜索行为增强对消费者透明）。
- 本档 `plan.md` / `summary.md`。

### 明确出界

- 不改 `message_chunks` schema、不加 `session_id`/`message_id IS NULL`、不新建 session 级向量表。
- 不加新的 `MessageSource` 枚举值。
- 不改 search/列表/grep/详情接口的数据结构。
- 不改 embedding 提供商链、切片参数。
- 时间戳不进向量。

## 涉及文件

- `server/package.json`：version 0.15.0 → 0.16.0（已完成）
- `server/apps/server/src/indexing/session-meta.ts`（新）
- `server/apps/server/src/indexing.ts`
- `server/apps/server/src/db/sessions.ts`（`findById`）
- `server/apps/server/src/db/migrate.ts`（0005）
- 根 `plan.md`（§3 索引粒度行）
- `server/apps/server/test/session-meta.test.ts`（新）、`indexing.test.ts`、`search.test.ts`、`migrate-repair.test.ts`（或新增迁移用例）、`helpers.ts`（如需记录型 provider）
- 本档 `plan.md` / `summary.md`

## 任务清单

1. `session-meta.ts` + 单测：5 字段全含 / 省略空 title / 省略空 cwd / 格式稳定
2. `sessions.findById`
3. `indexing.ts`：首切片拼元数据进 embedding 输入、存储文本保持原样
4. `migrate.ts`：0005（清 chunk + 删 chunk 向量表 + 重置 flags）
5. 测试：
   - `indexing.test.ts`：记录型 provider 断言 `embed` 第一个输入以 header 开头且含各字段；断言 `message_chunks[0].text` 不含 header、后续切片不含 header
   - `search.test.ts`：以"header + 首切片原文"为 query（fake provider 精确串）命中该会话
   - 迁移用例：预置 chunk 行 + `chunk_embeddings_x` 虚表 + 已索引标记 → 跑 0005 → 全部清空/重置
6. 根 `plan.md` §3 同步
7. `npm test` + `npm run build` 全绿，写 summary.md，提交

## 验收标准

- 会话首切片的 embedding 输入 = `会话元数据：...` + 原始首切片文本；`message_chunks.text` 与 `char_start` 保持原始值不变。
- 仅会话首个待索引切片携带元数据，其余切片 embedding 输入不含 header。
- 以元数据 header + 首切片原文作为查询，能命中该会话且距离显著小于无关会话（fake provider 精确串下距离≈0）。
- 迁移后 DB 无 `chunk_embeddings_%` 残留、`message_chunks` 被清空、所有会话 `indexed_at/indexed_model` 置空。
- 重建完成后 `GET /v1/stats` 的 `indexed == sessions`，无 unindexed 残留。
- 根目录 `npm test` + `npm run build` 全绿。

## 风险与未知

| 风险/未知 | 处置 |
|---|---|
| 首切片语义被 header 稀释/偏移（首切片短时更明显） | header 控制在单行、字段精简；真机对比召回后必要时调措辞/权重 |
| 元数据只在首切片，若首切片语义弱则元数据召回弱 | 符合"首个切片"要求；若实测不足，另立版本评估独立 session 向量 |
| 全量重建窗口（再次重建） | 后台 auto-indexer 慢慢补；必要时 `npm run reindex`；期间检索覆盖不全属预期 |
| 空会话无切片 ⇒ 无元数据向量 | 已知限制，写入 summary；本版不引入独立 session 向量 |

## 非目标

- 独立 session 级向量表 / `message_id` 可空 / `session_chunks`（超出"首切片加元数据"）
- 每条切片都拼元数据
- 搜索响应结构或 `MessageSource` 枚举变更
- 时间戳、model 等其余字段入向量
- 词法融合 / RRF（0.15.0 已列为另立需求）

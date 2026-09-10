# 0.15.0 会话切片索引：text + reasoning 碎片级向量化

## 需求描述

把向量索引粒度从"一条消息一个向量"改为**切片（chunk）级**，并让每条消息的**思考（reasoning）**也进入索引：

- **索引源**：`text` 用已清洗的 `messages.text`；`reasoning` 从 `messages.raw` 抽取（按 agent 归一化）。
- **接受向量库重建**：删旧向量表、全量重算，不做增量迁移。
- 检索结果片段标注来源（`text` / `reasoning`）。

起因：向量检索出现"字面就在库里却 MISS"——精确串 `no-negative-echo` 的 KNN top-10 为空，而 `grep` 同串命中 4 个会话。根因一：`/v1/search` 纯向量无语法兜底（另立需求）；根因二：**一消息一向量、零切片**，长样板消息（如整篇 SKILL.md）把稀有条目平均掉；且当前只索引 `text`，占大部分语义内容的 reasoning 完全没进索引。

> 注：本版只解决"内容覆盖 + 粒度"。**错实体词桥接（no-navigate → no-negative-echo）不在本版范围**，需词法融合（RRF），另立需求。

## 现状（侦察结论，2026-09-10）

### 索引链路

- `indexing.ts:24`：`this.registry.embed(rows.map((r) => r.text))` —— 每条消息整段一次 embed，**无切片**。
- `db/sessions.ts:233` `messageTexts`：`SELECT id, idx, text FROM messages WHERE session_id = ? AND text <> '' ORDER BY idx` —— 只取 `text`，空 text 消息（纯 reasoning/tool）被跳过。
- `db/embeddings.ts:46`：`INSERT INTO message_embeddings_<slug> (message_id, embedding)`，`message_id INTEGER PRIMARY KEY` —— **物理上一消息仅一个向量**，切片必须换表结构。
- 向量表按模型分表（0.6.0 决策）：`message_embeddings_<slug>`；维度运行时事实。
- 重建入口：`auto-index.ts`（后台串行，BATCH=50）、`routes/settings.ts:91`（同步 ≤200）、`scripts/reindex.ts`（≤10000）。`listUnindexed` 口径：`indexed_at IS NULL OR indexed_model != activeModel`（**清空 indexed_model 才会重建**）。

### raw 结构实测（**不一致，必须按 agent 归一化**）

| agent | raw 顶层形态 | part 类型 | reasoning 位置 | 备注 |
|---|---|---|---|---|
| opencode | 多 part→数组；单 part→裸对象；空→null | `text`/`reasoning`/`tool`/`step-start`/`step-finish`/`file`/`patch` | `{type:"reasoning", text, time}` | 已在 raw |
| zcode | 数组/裸对象 | `text`/`reasoning`/`tool`/`step-start`/`step-finish` | `{type:"reasoning", text, metadata, time}` | 与 opencode 近乎同构 |
| workbuddy | 多为单对象（也可 string） | `input_text`/`output_text`/`text` | **当前不在 raw** —— 源 JSONL `type:"reasoning"` 独立行、无 role，被 `parse.ts` 丢弃 | 由采集器 0.2.0 补 |

坑：单 part 时 raw 是**裸对象非数组**；workbuddy content 可为 string；raw 可 null；思考字段名可能为 `thinking`（Anthropic 风格）。

### 体量佐证（会话 `1d90b8b9-94e8-4b5d-8633-519ae775b385`）

- `text`：8 段 / 7,115 字；`reasoning`：**39 段 / 41,245 字**（约 6×）。
- 结论：加 thinking 后索引体量显著膨胀，**切片是必需**，否则重现"长消息一个向量"的稀释。

## 方案

### 1. `packages/shared/src/session.ts`

- 新增 `MessageSource = "text" | "reasoning"`。
- `SearchSnippet` 增字段 `source: MessageSource`（片段来源）；其余保持。

### 2. DB schema 与迁移（重建）

- 新增表 `message_chunks`：
  ```sql
  CREATE TABLE message_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    UNIQUE (message_id, chunk_no, source)
  );
  CREATE INDEX idx_message_chunks_message ON message_chunks (message_id);
  ```
- 新向量表命名 `chunk_embeddings_<slug>`（slug 化同现有 `embeddingTableFor`），`chunk_id INTEGER PRIMARY KEY, embedding float[dim]`。
- migration `0004_chunk_indexing`（`db/migrate.ts`）：
  1. 删除全部 `message_embeddings_%` 虚拟表（含影子表，复用 `dropOrphanShadowTables` 兜底）。
  2. 建 `message_chunks`（`IF NOT EXISTS`）。
  3. `UPDATE sessions SET indexed_at = NULL, indexed_model = NULL`（**关键**：否则 `listUnindexed` 认为已索引，不会重建）。
- 重建由既有 auto-indexer / reindex 入口自动完成，无需清空 db 文件。

### 3. raw 归一化（新增 `src/indexing/raw-extract.ts`）

- 入口：`extractReasoning(agent: string, raw: unknown): string[]`（返回该消息所有 reasoning 明文，按出现顺序）。
- 归一化：raw 可为数组/单对象/字符串/null；产出 part 列表。
- reasoning part 判定：
  - `type === "reasoning"` → 取 `text`；
  - `type === "thinking"`（Anthropic 风格）→ 取 `text` ?? `thinking`；
  - 兜底：`summary` 为数组时拼接各项 `text` / `summary_text`。
- 未知 agent：只做上述通用判定；无 reasoning 则返回空。

### 4. 切片（新增 `src/indexing/chunk.ts`）

- `chunkText(text, { maxChars, overlapChars }): { text, char_start }[]`。
- 默认 `maxChars ≈ 1200`、`overlap ≈ 15%`；优先在段落/换行边界断开，长行强制硬切。
- `text` 与 `reasoning` 各自独立切片、各自带 `source`；空串/纯空白跳过。
- 切片尺寸为**代码常量**，不引入"最大上下文"配置（守 0.6.0 决策）。

### 5. 存储层（新增 `src/db/chunks.ts` 或扩展 `embeddings.ts`）

- `chunkEmbeddingTableFor(model)` → `chunk_embeddings_<slug>`（与 `message_embeddings_` 前缀区分）。
- `listChunkEmbeddingTables(db)`。
- `storeChunks(db, sessionId, model, rows: { messageId, chunkNo, source, text, charStart, vector }[])`：
  - 事务内：清该会话在**所有** `chunk_embeddings_%` 表中的旧向量 + 删 `message_chunks` 行 → 建/确认向量表（按向量实际维度）→ 插 `message_chunks` 行（取回 id）→ 插向量。
- `clearSessionChunks(db, sessionId)`：清向量 + chunk 行（供 upsert 复用）。

### 6. 索引器（`src/indexing.ts` 重构）

- 取数改为 `messageSources(sessionId)`：`SELECT id, idx, role, text, raw FROM messages WHERE session_id = ? ORDER BY idx`，在代码里过滤"text 非空 **或** 能抽出 reasoning"的消息。
- 对每条消息：`text` 源 = `messages.text` 切片；`reasoning` 源 = raw 抽取后合并切片。
- 汇总所有 chunk → `registry.embed(chunk texts)`（沿用 batchSize 串行与 failover）→ `storeChunks` → `setIndexed`。
- 无任何 chunk（空会话）时仍 `setIndexed`（保持现有空会话行为）。

### 7. 检索（`src/db/search.ts`）

- KNN 改为查 `chunk_embeddings_<slug>`：`SELECT chunk_id, distance FROM ... WHERE embedding MATCH ? AND k = ?`。
- Join `message_chunks c` → `messages m`（取 `idx/role/ts`）→ `sessions s`（过滤 + 元数据）。
- 按 session 聚合，取最小距离；snippet 取自**命中 chunk**：`{ message_idx, role, ts, source, text(≤500 截断), distance }`。
- `k`：`Math.min(Math.max(topK * 50, topK), 1024)`（chunk 数远多于消息数，需更大候选）。
- `hasTable` 改判 `chunk_embeddings_<slug>`。

### 8. 文档与 Web

- `routes/help.ts`：`POST /v1/search` 的 `results[].snippets[]` 增加 `source` 字段说明。
- Web `routes/search.tsx`：`NormalizedHit.lines` 增 `source`，片段渲染加来源标签（"思考"/"正文"）。
- `skills/session-hub/SKILL.md`：search 返回片段说明补 `source`（接口仍动态发现，不固化）。
- 根 `plan.md` §3 决策表：补一行"索引粒度=切片级（text+reasoning），向量表按模型分表且前缀 `chunk_embeddings_`"。

### 9. 明确出界

- 不改 PUT/DELETE、列表、grep、会话详情接口的数据结构。
- 不做词法融合 / RRF（另立需求）。
- 不改 embedding 提供商链、不做 query instruct 前缀。
- 不引入切片尺寸等配置项。

## 涉及文件

- `server/package.json`：version 0.14.0 → 0.15.0（已完成）
- `packages/shared/src/session.ts`（`MessageSource` + `SearchSnippet.source`）
- `server/apps/server/src/db/migrate.ts`（0004）
- `server/apps/server/src/db/chunks.ts`（新）
- `server/apps/server/src/db/sessions.ts`（`messageSources`；upsert 清 chunk）
- `server/apps/server/src/db/search.ts`（改查 chunk）
- `server/apps/server/src/indexing/raw-extract.ts`（新）
- `server/apps/server/src/indexing/chunk.ts`（新）
- `server/apps/server/src/indexing.ts`（重构）
- `server/apps/server/src/routes/help.ts`
- 根 `plan.md`、根 `AGENTS.md`（契约条款）
- `server/apps/web/src/routes/search.tsx`
- `skills/session-hub/SKILL.md`
- `server/apps/server/test/*`（chunk / raw-extract / search / migrate / sessions 相关）
- 本档 `plan.md` / `summary.md`

## 任务清单

1. shared：`MessageSource` + `SearchSnippet.source`
2. `chunk.ts`（+ 单测：边界、重叠、长行硬切、空串）
3. `raw-extract.ts`（+ 单测：opencode/zcode/workbuddy 三形态、裸对象/数组/string/null、thinking 字段）
4. DB：migration 0004 + `chunks.ts` + `sessions.messageSources` + upsert 清 chunk（+ 测试）
5. `indexing.ts` 重构（text+reasoning → chunk → embed → store）
6. `search.ts` 改查 chunk + snippet `source`（+ 测试）
7. help / web / SKILL.md / 根 plan.md / AGENTS.md 同步
8. `npm test` + `npm run build` 全绿；真机重建 + before/after 召回对比；写 summary.md；提交

## 验收标准

- 同一 query 对目标会话的召回升位（记录 before/after 的 rank 与 distance；以 reasoning 携带的语义为 query 时应有明显改善）。
- `GET /v1/stats`：重建后 `indexed == sessions`，无 unindexed 残留。
- DB 中无 `message_embeddings_%` 残留；存在 `message_chunks` 与 `chunk_embeddings_<活跃模型>`。
- `POST /v1/search` snippet 带 `source`，Web 显示"思考/正文"标签。
- 根目录 `npm test` + `npm run build` 全绿。

## 风险与未知

| 风险/未知 | 处置 |
|---|---|
| WorkBuddy reasoning 行 schema 未采样 | **不阻塞**：raw 抽取通用、opencode/zcode 已实测；collector 侧按候选形态防御式兼容。真机采样为 E2E 验证项，未采到前 workbuddy 仅索引 text（不回退） |
| 重建窗口长（向量 ~6×、串行 batch=32、NAS TRUNCATE+FULL） | 后台 auto-indexer 慢慢补；必要时 `npm run reindex`；期间检索覆盖不全属预期 |
| reasoning 啰嗦/重复，稀释区分度 | chunk 内去重；后续可加相似度去重（本版先不做） |
| snippet 暴露思考的隐私面 | 已定：标注来源并展示；日志仍只记元数据 |
| 切片参数影响召回 | 先定默认值，真机对比后调；参数集中为常量 |

## 非目标

- 词法融合 / BM25 / RRF
- query 侧 instruct 前缀
- chunk 级分页、按 source 过滤检索
- 旧空间向量的增量保留（本版接受删表重建）

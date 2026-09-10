# 0.15.0 会话切片索引：实际改动记录

## 实际改动

- `packages/shared/src/session.ts`：新增 `MessageSource = "text" | "reasoning"`；`SearchSnippet` 增 `source: MessageSource`
- `server/apps/server/src/indexing/chunk.ts`（新）：`chunkText(text, { maxChars, overlapChars })`，默认 1200 / 180（15%），优先段落（`\n\n`）→ 换行（`\n`）→ 空格 → 制表符断句，无边界则硬切；返回 `{ text, char_start }`，空串/纯空白跳过；`char_start` 对齐 trim 后正文起点
- `server/apps/server/src/indexing/raw-extract.ts`（新）：`extractReasoning(agent, raw)`。raw 兼容数组/单对象/字符串/null；`type:"reasoning"` 取 `text`，`type:"thinking"` 取 `text ?? thinking`，兜底拼接 `summary[]` 的 `text`/`summary_text`；无明文（仅 encrypted）返回空
- `server/apps/server/src/db/chunks.ts`（新）：
  - `chunkEmbeddingTableFor(model)` → `chunk_embeddings_<slug>`；`listChunkEmbeddingTables` 只列 vec0 虚表
  - `ensureChunkEmbeddingsTable(db, model, dim)`：`chunk_id INTEGER PRIMARY KEY, embedding float[dim]`
  - `clearSessionChunks(db, sessionId)`：遍历所有 `chunk_embeddings_%` 删该会话 chunk 向量 + 删 `message_chunks` 行（复用于 upsert 与重建）
  - `storeChunks(db, sessionId, model, rows)`：事务内清旧 → 按实际维度建表 → 插 `message_chunks`（取回 id）→ 插向量
- `server/apps/server/src/db/migrate.ts`：新增 `0004_chunk_indexing`
  1. `dropMessageEmbeddingsTables`：先 DROP `message_embeddings%` 全部虚表（级联影子表），再兜底 DROP 残留影子/杂表
  2. 建 `message_chunks`（`UNIQUE(message_id, chunk_no, source)` + `idx_message_chunks_message`）
  3. `UPDATE sessions SET indexed_at = NULL, indexed_model = NULL` 触发全量重建
- `server/apps/server/src/db/sessions.ts`：`upsert` 改调 `clearSessionChunks`；`messageTexts` 替换为 `messageSources(sessionId)`（JOIN sessions 取 `agent`，返回 `id/idx/role/text/raw/agent`，raw 解析 JSON）
- `server/apps/server/src/indexing.ts`：取 `messageSources` → 每条消息分别对非空 `text` 与 `extractReasoning` 结果切片（同消息内按 (source, text) 去重）→ 汇总 `registry.embed` → `storeChunks` → `setIndexed`；无 chunk 时仍 `setIndexed`（沿用空会话行为）；日志改记 `chunks=`
- `server/apps/server/src/db/search.ts`：KNN 改查 `chunk_embeddings_<slug>`，JOIN `message_chunks` → `messages` → `sessions`；`k = min(max(topK*50, topK), 1024)`；按会话聚合取最小距离，snippet 取自命中 chunk 并带 `source`；`hasTable` 改判 chunk 表
- `server/apps/server/src/routes/help.ts`：`POST /v1/search` returns 描述补 snippet 字段与 `source`（text/reasoning）
- `server/apps/web/src/routes/search.tsx`：`NormalizedHit.lines` 增 `source`；语义/关键词两路填充；片段渲染加来源标签「思考」/「正文」（reasoning 用 warning 色）
- `skills/session-hub/SKILL.md`：search 返回示例与说明补切片粒度与 `source`
- 根 `plan.md` §3：新增「索引粒度」决策行；「向量模型」行「消息级 embedding」改「切片级 embedding」
- `package-lock.json`：collector workspace 版本同步 0.1.0 → 0.2.0（规划期 package.json 改动补齐）

## 测试

- 新增 `chunk.test.ts`（6 例）：空/纯空白、短文本与 trim 后 `char_start`、段落边界、长行硬切、重叠偏移、overlap 封顶且必前进
- 新增 `raw-extract.test.ts`（7 例）：null/undefined/string、opencode/zcode 数组、裸对象、thinking 字段、summary 拼接、encrypted 跳过、未知 part
- 新增 `chunks.test.ts`（2 例）：`storeChunks` 写入/重建清旧/`clearSessionChunks` 全清；`messageSources` 解析 reasoning raw
- `search.test.ts`：既有排名用例补 `source="text"` 断言；新增「reasoning 从 raw 抽取入索引、snippet source=reasoning」用例
- `model-partition.test.ts`：表名改 `chunk_embeddings_*`（计数口径不变：2+1=3）；原 0002 迁移用例替换为 `0004` 迁移用例（清空 session 的 indexed 标记、建 `message_chunks`、无 `message_embeddings%` 残留）
- `migrate-repair.test.ts`：0003 修复用例调整 `DROP TABLE IF EXISTS`；删除对旧向量空间的检索断言；no-op 用例改为断言 `message_embeddings%` 为空 + `message_chunks` 存在
- `auto-index.test.ts` / `shutdown.test.ts`：表名同步 `chunk_embeddings_*`

## 与计划的偏差

- 计划 §6 的 `messageSources` SQL 未含 agent，实际 JOIN `sessions` 取 `agent` 以喂给 `extractReasoning(agent, raw)`；字段不变，仅多取一列
- 计划「chunk 内去重」为风险表缓解项，实际按 (source, chunk.text) 做同消息精确去重（不做相似度去重，与计划一致）
- `embeddingTableFor`/`storeEmbeddings` 等旧 `embeddings.ts` 函数保留未删：`listEmbeddingTables` 仍被历史迁移 0003 使用，`toVectorBlob` 被 `chunks.ts` 复用；旧存储函数在运行期已无调用点（不影响功能）
- 计划涉及 `raw-extract.ts` 仅列 text/thinking/summary；实现额外保留了通用 summary 兜底分支（非 reasoning type 且带 summary 时），属防御式，不扩大正常行为

## 测试 / 验收结果

- `npm test`：27 文件 206 用例全绿（新增 13 例 + 既有改造）
- `npm run build`：tsc -b + opencode/zcode/collector 三插件 typecheck + web（tsr generate / tsc / vite）全绿
- 验收标准逐条：
  - 「DB 无 `message_embeddings_%` 残留；存在 `message_chunks` 与 `chunk_embeddings_<活跃模型>`」✓（`0004` 迁移用例 + 模型分表用例）
  - 「`GET /v1/stats` 重建后 `indexed == sessions`，无 unindexed 残留」✓（模型分表切换后 `runOnce` 一轮 indexed=2/unindexed=0）
  - 「`POST /v1/search` snippet 带 `source`」✓（search 新用例 + Web 标签渲染）
  - 根目录 `npm test` + `npm run build` 全绿 ✓
  - 「同一 query 召回升位（before/after rank 与 distance）」：**未在本机执行**，见遗留事项（无真实 DB / embedding provider 运行时环境）

## 遗留事项

- **真机重建 + before/after 召回对比未执行**：worktree 无 `server/.env`、`server/config/providers.local.json`、`server/data/session-hub.db`，无法连真实 embedding provider 重建与对比；需在具备真实配置的环境按 plan 验收项补测，记录目标会话前后 rank/distance
- 切片参数（1200/15%）为初值，待真机对比后调；已集中为 `chunk.ts` 常量
- workbuddy reasoning 真实 schema 仍待采集器侧采样（collector 0.2.0，本版服务端已按候选形态兼容；另立版本落地）
- `embeddings.ts` 旧存储函数可择机随历史迁移一并清理
- worktree 依赖：本 worktree 原无 `node_modules`（构建经目录树借用了主工作区旧 shared，导致 `MessageSource` 未导出）。本次以 `npm install --ignore-scripts` 建立本地 workspace 链接；`better-sqlite3` 直接用包内 `prebuilds/win32-x64.node`（N-API）加载，实测可用，无需编译。带脚本安装会走 `prebuild-install || node-gyp rebuild`，prebuild-install 未命中后回落 node-gyp，而该 shell 未激活 conda，node-gyp 只探到 32 位 Python 3.8（不支持）与 WindowsApps 存根故报错；本机 `C:\Users\HWZ\miniconda3` 的 Python 3.13.11 可用，只是不在 PATH。如需普通 `npm install` 也通过，可设 `PYTHON=C:\Users\HWZ\miniconda3\python.exe` 或先激活 conda

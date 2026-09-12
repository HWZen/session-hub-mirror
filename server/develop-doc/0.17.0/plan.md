# 0.17.0 会话元数据仅标题入向量（独立探针验证）

## 目标

首切片 embedding 输入中的会话元数据只保留 `title`；`cwd` / `agent` / `machine` / `source_id` 作为 `sessions` 结构化字段仅用于过滤，不进入向量。用脱离 session-hub 服务与数据库的独立探针，在真实向量（`qwen3-embedding:8b`）上量化「纯正文 / 全字段 header / 仅标题」三种首切片拼法的召回差异，据此确认本版形态。

## 依据

元数据的向量检索价值取决于其在库内的**区分度**与**自然语言性**：

| 字段 | 库内取值 | 向量检索价值 |
|---|---|---|
| `cwd` | 同批会话内近乎恒定（如 `D:\Github\session-hub`），且为 Windows 路径类 token | 无区分度 |
| `agent` / `machine` | 按 Agent / 机器恒定 | 无区分度 |
| `source_id` | 唯一但不透明 | 无自然语言语义 |
| `title` | 每会话唯一、自然语言摘要 | 唯一有效字段 |

抽查会话 `ses_synthetic00000000000000002`（标题「核对本地/远程分支是否都已合入master」，cwd `D:\Github\session-hub`，0.16 生产索引）：

| Query | 该会话排名 | top1 距离 |
|---|---|---|
| 首切片被 embed 的原文（header+正文）整段 | #1 d=0.000 | — |
| `核对本地/远程分支是否都已合入master`（标题原文） | #1 | 0.452 |
| `检查所有分支是否都已合并` | #1 | 0.647 |
| `分支合并核对` | MISS(>10) | 0.562 |
| `D:\Github\session-hub 分支合并核对` | MISS(>10) | 0.636 |
| `D:\Github\session-hub 核对分支` | MISS(>10) | 0.660 |

含 `cwd` 的 query 未带来召回收益，标题类 query 表现稳定。

## 现状（基于 0.16.0）

- `session-meta.ts:8 buildSessionMetaHeader(meta)` 产出 `会话元数据：标题=…；Agent=…；机器=…；源会话ID=…；工作目录=…`；`title`/`cwd` 空则整段省略。
- `indexing.ts:65-68`：`header = buildSessionMetaHeader(meta)`；`pending[0]` 的 embed 输入 = `${header}\n${chunk.text}`；其余切片不变；`storeChunks` 存原始 `chunk.text`（`message_chunks.text` / `char_start` 不变）。
- `sessions` 表已存 `title` / `cwd` / `agent` / `machine` / `source_id`；`GET /v1/sessions` 与 `/v1/search` 支持按这些字段过滤（`filters`）→ 这些字段保留为结构化过滤维度，检索能力不因本版改变而丢失。
- 迁移：`migrate.ts` 现有 0001–0005；`0005_session_meta_chunk` 的清理模式（`DELETE message_chunks` → `dropChunkEmbeddingsTables` → 重置 `indexed_at/indexed_model`）可复用。
- 测试：`session-meta.test.ts`（格式/省略/trim）、`indexing.test.ts`（记录型 provider 断言首输入含 header）、`search.test.ts`（header+首切片原文命中）、`migrate-repair.test.ts`（0005 清理）。
- 本地向量服务：`http://127.0.0.1:434/v1`，`qwen3-embedding:8b`，无 API key（`providers.local.json` 已配、`enabled:true`）。

## 方案

### 1. `src/indexing/session-meta.ts`：header = 标题

- `buildSessionMetaHeader(meta)` 返回 `meta.title` trim 后的文本；`title` 为 `null` 或 trim 后为空 → 返回 `""`。
- 函数名与调用点保持不变。

### 2. `src/indexing.ts`

- `header !== ""` 时拼到 `pending[0]` 的 embed 输入；`header === ""` 时首切片与其余一致。
- 存储仍为原始 `chunk.text`。

### 3. 迁移 `0006_meta_title_only`（`src/db/migrate.ts`）

向量空间内容变化，需全量重建（与 0005 同构）：

1. `DELETE FROM message_chunks`
2. `dropChunkEmbeddingsTables`（枚举 + LIKE 兜底清影子表）
3. `UPDATE sessions SET indexed_at = NULL, indexed_model = NULL`

> **为什么必须迁移**：embedding 向量是「被索引文本」的函数。header 变了，旧会话的向量仍按旧 header 算出，会与新查询/新向量混在同一张 `chunk_embeddings_<模型>` 表里，导致同一向量空间内约定不一致、召回不可复现。0006 用「清空切片行 + 删向量表 + 重置 `indexed_at/indexed_model`」强制全量重建，让库里只剩新约定下的向量——这是版本化的「索引契约变更」，不是 schema 变更。

### 4. 独立探针（脱离 session-hub 服务与 DB）

目的：不启动 session-hub 服务、不碰其数据库，用真实向量量化「首切片拼什么」对召回的影响，作为本版形态的依据。

- 位置：`server/develop-doc/0.17.0/probe/`（tsx 直跑的一次性验证工具，不属产品代码）。
- 数据来源：经远程 API `GET /v1/sessions/:id/full` 拉一批会话（建议 30–60 个，覆盖不同主题/长度/标题质量），落 `probe/data/sessions.json`（本地，gitignore）。仅只读拉取。
- 复刻索引：复用纯函数 `chunk.ts chunkText`（1200/180）与 `raw-extract.ts extractReasoning` 的抽取规则，按消息顺序产出切片；`pending[0]` 即首切片。
- 待比较变体（只改首切片的 embed 输入）：
  - **V0 纯正文**：不拼接（对照）
  - **V1 全字段**：`会话元数据：标题=…；Agent=…；机器=…；源会话ID=…；工作目录=…\n<首切片>`
  - **V2 仅标题**：`<title>\n<首切片>`（title 空则同 V0）
- 向量：`http://127.0.0.1:434/v1/embeddings`，model `qwen3-embedding:8b`，无 key。
- query 集：`probe/queries.json`，覆盖标题原文 / 标题改写 / 正文改写 / `路径+语义` / 唯一标识符（分支名、commit、错误码）/ 跨会话同主题，每条标注目标 `source_id`。至少含：
  - `D:\Github\session-hub 分支合并核对` → `ses_synthetic00000000000000002`
  - `分支合并核对` → 同上
  - `核对本地/远程分支是否都已合入master` → 同上
  - `首个对话切片是否包含工作路径` → `ses_synthetic00000000000000003`
  - `buildSessionMetaHeader 拼接 header` → `ses_synthetic00000000000000003`
  - `0.15.0-server-0.2.0-collector-dev 合并了吗` → `ses_synthetic00000000000000002`
- 每个变体对每个 query：在该变体全部会话切片上取与 query 的最小距离，得到目标会话排名；汇总 Recall@1 / Recall@5 / MRR@10 / 平均最小距离 / MISS 数。
- 输出：`probe/result.md`（三变体逐条对比表）+ `probe/result.json`。

**判定**：V2 相对 V1 在标题类、路径类 query 不回退，且相对 V0 不显著变差 → 采纳仅标题；否则记录数据，另立版本评估。探针结论决定第 5 步是否落地。

### 5. 落地产品代码（探针通过时）

- `session-meta.ts`：`buildSessionMetaHeader` 返回 trim 后 title；空标题返回 `""`。
- `indexing.ts`：逻辑不变（`header !== ""` 才拼首切片）。
- `migrate.ts`：新增 `0006_meta_title_only`（见 §3）。
- 测试同步（见任务清单）。

### 6. 文档

- 根 `plan.md` §3「索引粒度」行更新为：仅 `title` 并入会话首切片 embedding 输入；其余元数据作为结构化过滤维度。
- `help.ts` / `SKILL.md` / Web：无 API/响应结构变化，不改。

## 涉及文件

- `server/package.json`：0.16.0 → 0.17.0（规划阶段已完成）
- `server/apps/server/src/indexing/session-meta.ts`
- `server/apps/server/src/db/migrate.ts`（0006）
- `server/apps/server/test/session-meta.test.ts`、`indexing.test.ts`、`search.test.ts`、`migrate-repair.test.ts`
- 根 `plan.md`（§3 索引粒度行）
- 本档 `plan.md` / `probe/`（`sessions.json`、`queries.json`、`probe.mjs`、`result.md`、`result.json`）/ `summary.md`

## 任务清单

1. 建 worktree `.worktrees/0.17.0-server-dev` + 分支、`server/package.json` 升 0.17.0、拷贝 `.env`（PORT=7430）/`providers.local.json`。（规划阶段已完成）
2. 落探针数据：从远程 API 拉一批会话 `/full`（含 raw）到 `probe/data/sessions.json`。
3. 落 `probe/queries.json` + `probe/probe.mjs`（V0/V1/V2 三变体），跑出 `probe/result.md`。
4. 依结论落地：改 `session-meta.ts`（仅标题）+ 单测。
5. 改 `migrate.ts`（0006）+ 单测；`indexing.test.ts`/`search.test.ts` 断言同步。
6. `npm test` + `npm run build` 全绿。
7. 根 `plan.md` §3 同步；写 `summary.md`（含探针对比结论）；提交（只含本版本文件）。

## 验收标准

- 探针产出 `probe/result.md`：V0/V1/V2 三变体逐条 query 排名 + Recall@1/5 / MRR@10 / 平均最小距离 / MISS 数对比，结论明确。
- `buildSessionMetaHeader` 输出 = trim 后标题；空标题返回 `""`。
- 有标题会话：首切片 embed 输入 = `标题 + "\n" + 原始首切片文本`；无标题会话：首切片 embed 输入 = 原始首切片文本；其余切片不含 header；`message_chunks.text`/`char_start` 不变。
- 迁移 0006 后：无 `chunk_embeddings_%` 残留、`message_chunks` 清空、所有会话 flags 置空；重建后 `GET /v1/stats` `indexed == sessions`。
- 根目录 `npm test` + `npm run build` 全绿。

## 风险与未知

| 风险/未知 | 处置 |
|---|---|
| 仅标题相对全字段无增益 | 探针三变体量化；无增益则 summary 记录，另立版本评估 |
| 探针语料样本量小/偏 session-hub 主题，结论不泛化 | 拉 30–60 个跨主题会话；结论作方向性依据，最终以生产抽验为准 |
| 探针复刻切片规则与 `indexing.ts` 有偏差 | 直接复用 `chunk.ts`/`raw-extract.ts` 纯函数 |
| 本机 434 与生产模型同名，量化/版本可能微差 | 探针只做 V0/V1/V2 同环境相对比较 |
| 标题质量参差（`New session - <时间戳>` 类空标题） | 空/低质标题不拼；query 集含此类样本观察 |

## 非目标

- 独立 session 级向量表 / `message_id` 可空 / 合成 meta chunk
- 词法/混合检索（BM25、RRF）
- 将 `cwd` / `agent` / `machine` / `source_id` 纳入向量
- 搜索响应结构、`MessageSource` 枚举、embedding 提供商链、切片参数变更
- 时间戳入向量

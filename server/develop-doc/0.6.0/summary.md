# 0.6.0 — 向量模型按提供商配置，活跃模型分表索引 · 完成记录

## 实际改动

### shared（`packages/shared/src/`）

- `embedding.ts`：删除 `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` 常量；`embeddingProviderConfigSchema` 新增 `model: z.string().min(1).default("bge-m3")`（旧配置文件经 zod default 自动补齐，向后兼容）
- `settings.ts`：`ProviderSettingsItem` 加 `model: string`；`ProviderTestResult` 加 `model: string | null`
- `api.ts`：`HealthStatus.embedding.model` 语义改为活跃模型（类型不变）；`providers` 每项加 `model`

### server

- `embedding/registry.ts`：
  - `RemoteEmbedProvider` 请求体发 `config.model`，不再写死 `bge-m3`
  - `EmbedProvider` 接口加 `readonly model: string`；`EmbedOutput` 加 `model`
  - 新增 `activeModel()`：weight 最高（同名并列按 name asc）已启用 provider 的 model，无 provider → null
  - `embed()` 跳过 `model !== activeModel` 的 provider（与 `ready` 判断并列）；同模型内按序 failover；无任何同模型候选成功 → `EmbeddingUnavailableError`
  - 维度按模型空间发现并缓存（`#dims: Map<model, dim>`）：首次成功响应（含探针）确立该模型空间维度，后续响应与空间不符的 provider 判失败并 fallthrough，防止同一空间混维
  - `status()` 返回活跃模型与各 provider 的 model；`testProvider()` 返回各自 model 与实际 dim
- `db/migrate.ts`：新增迁移 `0002_model_partioned_embeddings`，把旧 `message_embeddings`（1024 维）搬到 `message_embeddings_bge_m3`（建新 vec0 表 → `INSERT ... SELECT` → DROP 旧表）
- `db/embeddings.ts`：`embeddingTableFor(model)` slug 化表名（小写、非 `[a-z0-9_]` → `_`）；`ensureEmbeddingsTable` 按本次向量实际维度 `CREATE VIRTUAL TABLE IF NOT EXISTS ... float[<dim>]`；`clearSessionEmbeddings` 按 `sqlite_master` 遍历全部 `message_embeddings_%` vec0 表清理（排除 `_chunks`/`_rowids` 等 shadow 表，用 `sql LIKE 'CREATE VIRTUAL TABLE%'` 过滤）；`storeEmbeddings(db, sessionId, model, rows)` 改签名，先全表清旧向量再按模型表插入
- `db/sessions.ts`：`upsert()` 清向量改为跨表清理（**时机在删除 messages 之前**，见偏差 3）；`listUnindexed(limit, activeModel)` 口径 `deleted_at IS NULL AND (indexed_at IS NULL OR indexed_model != ?)`；`stats(activeModel)` 的 indexed 口径改为活跃模型空间内已索引数
- `db/search.ts`：`searchSessions(db, model, vector, topK, filters)` 改签名，KNN 在该模型表上执行；表不存在（该模型从未索引）返回空结果
- `indexing.ts`：`setIndexed` 记 `embed()` 实际返回的 model（= activeModel，由同模型约束保证）；空消息会话按 `activeModel()` 落 `indexed_model`，activeModel 为 null 时不置 indexed 并返回 false
- `routes/search.ts`：响应 `model` 用 embed 输出的模型（与检索表一致）
- `routes/settings.ts`：`GET /providers` 返回 `model`；`PUT` 走新 schema（zod default 补齐）；reindex 与 remaining 用 activeModel 口径
- `routes/stats.ts`：`StatsRouteDeps` 加 `registry`，`stats()` 传 activeModel
- `scripts/reindex.ts`：listUnindexed 传 activeModel，日志带 activeModel

### web（`server/apps/web/src/`）

- `lib/api.ts`：`ProviderSettingsInput` 加 `model`
- `routes/settings.tsx`：provider 行新增"模型"输入框（新增行默认 `bge-m3`，`buildInput` 校验非空）；探针结果展示 model；卡片描述改为"模型按提供商配置；检索只使用最高优先级已启用提供商的模型空间，切换模型后需重新索引"
- `routes/system.tsx`：描述改为"活跃模型 {model || 未配置}"，提供商列表行加 model 徽章
- `routes/search.tsx`：描述去掉"（bge-m3）"硬编码

### 配置与文档

- `server/config/providers.json`：每条 provider 加 `model`（GPU/云端 `bge-m3`；`local-inference` 示例 `qwen3-embedding:8b`，baseUrl 示例同步改为起因中实测的 `127.0.0.1:434/v1`）；`_note` 更新
- `.env.example`：无模型相关环境变量，未改动
- 根 `plan.md` / `AGENTS.md` / `README.md`：规划阶段已同步，本次未动

### 测试（`server/apps/server/test/`）

- `embedding-registry.test.ts`：新增 activeModel 取 weight 最高、embed 跳过异模型、仅同模型 failover、无同模型候选抛 EmbeddingUnavailableError、空间维度不符 fallthrough、status/testProvider 返回 model 等用例；"全链 1024 断言"改为动态维度语义
- `model-partition.test.ts`（新增）：
  - 分表集成：A 模型索引 2 会话 → 切 B 模型 → B 空间搜索为空、stats indexed=0/unindexed=2、listUnindexed 口径生效、旧空间向量保留 → 逐会话重索引后 B 可检索、A 空间该会话向量被清理 → 再 upsert 后各表计数正确
  - 0002 迁移回归：手工构造旧库（1024 维 `message_embeddings` 含向量）→ `migrate()` 后表重命名、向量保留、bge-m3 空间检索命中、重复写入幂等
- `settings.test.ts`：GET/PUT 带 model、旧格式默认 bge-m3、探针返回 model 与实际 dim（4096 维可测）、空间不符探针失败详情
- `sessions.test.ts`：`listUnindexed` 调用补 activeModel 入参
- `helpers.ts`：三个 fake provider 支持 `model` / `priority` / `dims` 参数（默认 bge-m3 / 原值 / 1024）

## 与计划的偏差

1. **维度记录粒度**：plan 写"每 provider 记录实际维度"，实施为 registry 按**模型**记录（Map<model, dim>）。failover 已限定同模型，按模型记录才能阻止同一空间内不同 provider 返回不同维度导致 vec0 表混维；是"按该 provider 自己的维度校验"的等价加强。
2. **0002 迁移未用 `ALTER TABLE ... RENAME`**：实测本机 sqlite-vec 对 vec0 表执行 RENAME 后 shadow table（`*_rowids` 等）不跟随，任何后续 DML 报 `Error preparing rowid scan: no such table`，直接采用 plan 中的退路方案（建新表复制后 DROP）。
3. **upsert 清理向量时机**（plan 未明确）：跨表清理必须在 `DELETE FROM messages` **之前**执行——先删消息会使子查询拿到新 message id，旧向量成为孤儿永远清不掉（实施中被分表用例暴露，已修复）。
4. **activeModel 为 null（无已启用 provider）空态**：`stats()` indexed=0、`listUnindexed` 返回全部未删除会话、空消息会话不置 indexed。plan 未定义该空态，按语义一致性处理。
5. **附带修复（0.6.0 范围外，挡"全绿"门槛）**：`plugins/opencode` 的 `loadConfig` 存在环境依赖测试缺陷——本机存在真实 `~/.config/session-hub/config.json` 导致 "returns null without config" 用例失败（master 基线即失败）。给 `loadConfig` 增加可选 `configPath` 参数（默认值不变），测试传入不存在路径使其封闭。
6. `system.tsx` 提供商行顺带加了 model 徽章（health providers 已含该字段，信息有用）。

## 测试 / 验收结果

- 根目录 `npm test`：**11 个文件 80 个用例全绿**
- 根目录 `npm run build`：tsc -b + 前端构建 + 插件 typecheck 全绿
- 验收标准逐条核对：
  - 双模型 provider 配置（bge-m3 weight 10 / qwen3-embedding:8b weight 100）：activeModel 取 weight 最高 ✅（registry 用例）；索引写入对应 slug 表 ✅（分表用例）；高优失败降级不跨模型，无同模型候选抛 EmbeddingUnavailableError ✅
  - Web 设置页可按 provider 填模型；旧格式（无 model）默认 bge-m3 不报错 ✅（settings 用例）
  - 切换活跃模型：旧空间搜索无结果、数据保留、未索引数上升、reindex 后新空间可检索 ✅（分表集成用例）
  - 旧库 0002 迁移后 bge-m3 空间检索行为不变 ✅（迁移回归用例）
  - 探针返回 provider 的 model 与实际 dim，4096 维可测试通过 ✅（settings 用例）

## 遗留事项

- 不同 model slug 化后可能撞名（如 `bge-m3` 与 `bge.m3` 同表）；plan 的 slug 规则如此，实际多模型混用场景罕见，暂不处理
- sqlite-vec 对 vec0 表的 `ALTER TABLE RENAME` 不可用（shadow table 断链），后续若升级 sqlite-vec 可重试，但复制方案已足够
- 同模型多 provider 若实际返回不同维度（配错），会在"空间维度不符"处显式失败并 fallthrough，最终 EmbeddingUnavailableError 暴露——符合"不静默兜底"原则

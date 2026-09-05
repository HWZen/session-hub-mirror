# 0.6.0 — 向量模型按提供商配置，活跃模型分表索引

> 起因（2026-09-05，用户实测）：本地 Ollama 透 qwen3-embedding 服务（`http://127.0.0.1:434`），
> 想在 Web 设置页填模型名；而旧决策"全链锁死 bge-m3（1024 维）"不允许配置模型，
> 且请求体固定发 `model: "bge-m3"`，对端直接不认识。

## 需求描述

用户决策（已同步根 `plan.md` §3/§7/§9 与 `AGENTS.md`）：

1. **模型按提供商配置**：provider 配置新增 `model` 字段（默认 `bge-m3`，向后兼容旧配置文件）
2. **活跃模型（activeModel）= weight 最高的已启用 provider 的 model**；索引与语义检索只使用活跃模型的向量空间
3. **failover 候选仅限同模型 provider**：`registry.embed` 只调 `model === activeModel` 的 provider（"降级只换谁在算，不换算什么"沿用；保证落库向量永远与检索空间一致，不混杂）
4. **向量表按模型分表**：`message_embeddings_<slug>`（slug = model 小写、非 `[a-z0-9_]` 替换为 `_`，如 `bge-m3` → `message_embeddings_bge_m3`）；维度为运行时事实（首次拿到向量时按实际维度建表），删除全局 `EMBEDDING_DIMENSIONS` 常量
5. **切换模型 = 切换向量空间**：旧空间数据保留但检索不可见；`indexed_model != activeModel` 的会话自动进入待索引队列
6. **不引入"最大上下文"配置**：消息级 embedding（一条消息一次调用），超限由提供商报错自然暴露

## 方案

### 1. shared（`packages/shared/src/`）

- `embedding.ts`：删 `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` 常量；`embeddingProviderConfigSchema` 加 `model: z.string().min(1).default("bge-m3")`
- `settings.ts`：`ProviderSettingsItem` 加 `model: string`；`ProviderTestResult` 加 `model: string | null`
- `api.ts`：`HealthStatus.embedding` 的 `model` 语义改为"活跃模型"（类型不变）

### 2. registry（`server/apps/server/src/embedding/registry.ts`）

- `RemoteEmbedProvider`：请求体发 `config.model`；删除对 `EMBEDDING_DIMENSIONS` 的全局校验，改为**每 provider 记录实际维度**（首次成功响应时发现并缓存），校验按该 provider 自己的维度
- `EmbeddingRegistry` 新增 `activeModel(): string | null`（weight 最高的已启用 provider 的 model；无已启用 provider → null）；`embed()` 遍历时跳过 `model !== activeModel` 的 provider（与 `ready` 判断并列）
- `status()`：`model` 返回 `activeModel()`；providers 列表每项加 `model`
- `testProvider()`：结果加 `model: provider.config.model`

### 3. db：向量表按模型分表（`server/apps/server/src/db/`）

- `migrate.ts`：新增迁移 `0002_model_partioned_embeddings`
  - 旧 `message_embeddings`（1024 维）→ 重命名为 `message_embeddings_bge_m3`（bge-m3 仍默认，不丢已索引数据）；`ALTER TABLE ... RENAME` 若 sqlite-vec 版本不支持，退路为建新表 `INSERT ... SELECT` 复制后 DROP 旧表（实施时验证）
  - 删除 `_migrations` 里对表维度的隐含依赖；新表全部延迟到首次写入时创建
- `embeddings.ts`：`tableFor(model)` slug 化表名；`storeEmbeddings(db, sessionId, model, rows)` 改签名——建表（`CREATE VIRTUAL TABLE IF NOT EXISTS ... float[<dim>]`，维度来自本次向量实际长度）、清理该会话在**所有** `message_embeddings_%` 表中的旧向量、按模型表插入
- `sessions.ts`：`upsert()` 清理向量改为遍历 `sqlite_master` 中 `message_embeddings_%` 全部表；`listUnindexed` 口径改为 `deleted_at IS NULL AND (indexed_at IS NULL OR indexed_model != ?)`（入参 activeModel）；`stats()` 的 indexed 统计口径同改（activeModel 空间内已索引数）
- `search.ts`：`searchSessions(db, model, vector, topK, filters)` 改签名——KNN 在该模型的表上执行；表不存在（该模型从未索引过）返回空结果

### 4. indexing / 路由（`server/apps/server/src/`）

- `indexing.ts`：`registry.embed` 返回值携带 `model`（provider 的 model）；`setIndexed(sessionId, model)` 记实际所用模型（= activeModel，由 embed 的同模型约束保证）
- `routes/search.ts`：`registry.activeModel()` 传给 `searchSessions`；响应 `model` 字段用 activeModel（实际 embed 用到的 provider 模型，两者恒等）
- `routes/settings.ts`：`GET /providers` 返回 `model`；`PUT` 走新 schema（zod default 补齐）；`POST /providers/test` 透传 `model`
- `routes/health.ts`：无改动（`registry.status()` 已带 activeModel）；`warnings` 增加"活跃模型空间无任何 provider"不再单独警告——沿用"无已启用 provider"警告即可

### 5. Web（`server/apps/web/src/`）

- `lib/api.ts`：`ProviderItem` / `ProviderTestResult` 同步加 `model`
- `routes/settings.tsx`：provider 行加"模型"输入框（默认 `bge-m3`），`buildInput` 校验非空；卡片描述去掉"模型全链固定 bge-m3（1024 维），不可配置"，改为"模型按提供商配置；检索只使用最高优先级已启用提供商的模型空间，切换模型后需重新索引"
- `routes/system.tsx`：去掉写死的"（1024 维）"文案，展示 health 返回的 model
- `routes/search.tsx`：描述文案去掉"（bge-m3）"硬编码

### 6. 配置样例与文档

- `server/config/providers.json`：每条 provider 加 `model` 字段示例（GPU 机条目 `bge-m3`；`local-inference` 示例 `qwen3-embedding:8b`）；`_note` 更新
- 根 `plan.md` / `AGENTS.md` / `README.md`：✅ 已同步（规划阶段完成）

### 7. 测试（`server/apps/server/test/`）

- 更新硬编码断言：`bge-m3`（health/search/sessions）、`1024`（helpers hashVector、settings dim）——改为动态或与配置一致
- `embedding-registry.test.ts`：新增用例——不同 provider 不同 model 时 `activeModel()` 取 weight 最高；`embed()` 跳过异模型 provider（仅同模型参与 failover）；testProvider 返回各自 model
- 新增分表用例（可并入 search/sessions test）：模型 A 索引后切到模型 B → B 空间搜索为空、A 空间数据仍在、`listUnindexed` 把 A 期会话列为未索引；upsert 后各模型表旧向量被清理
- `settings.test.ts`：`GET/PUT` 带 `model` 字段；旧格式配置（无 model）加载后 default 为 `bge-m3`

## 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/shared/src/embedding.ts` | 删两常量；schema 加 model |
| `packages/shared/src/settings.ts` | 类型加 model |
| `server/apps/server/src/embedding/registry.ts` | per-provider model + activeModel + 同模型 failover + 动态维度 |
| `server/apps/server/src/db/migrate.ts` | 0002 迁移（旧表重命名） |
| `server/apps/server/src/db/embeddings.ts` | 按模型分表读写 |
| `server/apps/server/src/db/sessions.ts` | upsert 清理多表 / listUnindexed 与 stats 口径 |
| `server/apps/server/src/db/search.ts` | 按模型表 KNN |
| `server/apps/server/src/indexing.ts` | setIndexed 记实际模型 |
| `server/apps/server/src/routes/{search,settings}.ts` | activeModel 传递 / model 字段 |
| `server/apps/web/src/lib/api.ts` + `routes/{settings,system,search}.tsx` | 表单与文案 |
| `server/config/providers.json` | 样例加 model |
| `server/apps/server/test/*.test.ts` + `helpers.ts` | 同步与新用例 |

## 任务清单

1. shared：embedding.ts schema + settings.ts 类型
2. server db：migrate 0002、embeddings 分表、sessions 口径、search 分表
3. server registry：per-provider model / activeModel / 同模型 failover / 动态维度
4. server 路由与 indexing：search、settings、health、indexing
5. web：api.ts + settings/system/search 三页
6. config 样例 + `.env.example` 检查（无模型相关 env，预计无改动）
7. test：更新断言 + registry 分模型用例 + 分表集成用例
8. 根目录 `npm test` + `npm run build` 全绿
9. 写 summary.md

## 验收标准

- 根目录 `npm test`、`npm run build` 全绿
- 配置两条不同 model 的 provider（如 bge-m3 weight 10、qwen3-embedding:8b weight 100）：`/health` 的 `embedding.model` = `qwen3-embedding:8b`；索引写入 `message_embeddings_qwen3_embedding_8b` 表；`registry.embed` 在高优 provider 失败时降级不跨模型（找不到同模型候选则 EmbeddingUnavailableError）
- Web 设置页可为每 provider 填模型；旧格式 `providers.local.json`（无 model）加载后默认 `bge-m3`，不报错
- 切换活跃模型后：旧空间搜索无结果但数据保留；总览"未索引"数上升；reindex 后新空间可检索
- 旧库（含 1024 维 `message_embeddings` 表）启动迁移后，bge-m3 空间检索行为不变（回归）
- 探针 `POST /settings/providers/test` 返回该 provider 的 `model` 与实际 `dim`；qwen3-embedding:8b（4096 维）可测试通过并按 4096 维建表

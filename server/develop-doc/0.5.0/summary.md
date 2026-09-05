# 0.5.0 summary — 移除本地 CPU 向量兜底，提供商链纯化 + health 警告

## 实际改动

### shared（packages/shared）

- `api.ts`：`HealthStatus` 顶层新增 `warnings: string[]`
- `settings.ts`：`ProvidersSettingsResponse` 删除 `localFallback` 字段

### server

- `src/embedding/registry.ts`：删除 `LocalEmbedProvider`、`createLocalEmbedProvider`、`LOCAL_*` 常量、`FeatureExtractionPipeline` 类型导入；`EmbedProvider.kind` 收窄为 `"remote" | "fake"`；`EmbeddingRegistry` 构造函数移除第二参 `local`，`providers` getter 恒返回 remote 数组；`RegistryStatus.providers.kind` 同步收窄；`createRegistry` 简化为双参（该函数当前无调用点，保留备用）
- `src/bootstrap.ts`：不再创建 localProvider，`SettingsRouteDeps` 不再传 `localFallbackName`
- `src/config.ts`：envSchema 删除 `SH_MODEL_CACHE_DIR` / `SH_MODEL_HUB_ENDPOINT` / `SH_MODEL_HUB_PATH_TEMPLATE`（旧 .env 残留键被 zod strip，不报错）
- `src/routes/settings.ts`：`SettingsRouteDeps` 删 `localFallbackName`；`GET /providers` 响应删 `localFallback` 字段；`EMBEDDING_MODEL` 导入随之移除
- `src/routes/health.ts`：`registry.providers` 为空时 `warnings` 返回 `["未配置任何向量提供商，索引与语义检索不可用"]`，否则 `[]`；HTTP 仍 200（`ok` 只反映 db 与存活）
- `package.json`：删除 `@huggingface/transformers` 依赖（npm install 共移除 46 个包，lockfile 已刷新）
- `.env.example` / 本机 `.env`：删除模型缓存目录与模型下载源两段配置
- `config/providers.json`：`_note` 重写（无内置兜底、本地推理服务按普通 provider 配置、全禁用时不静默兜底）；新增 `local-inference` 示例条目（`enabled: false`，指向 Ollama 默认端口写法）

### web

- `settings.tsx`：删除"本地 CPU 兜底"卡片与 `localFallback` 引用、`CpuIcon` 导入；providers 列表为空时显示警告引导文案（接入 OpenAI 兼容服务 / 本地推理服务同法配置）
- `system.tsx`：健康页顶部按 warning 样式条展示 `warnings`
- `index.tsx`：总览页新增告警条（复用未索引告警样式），展示 health `warnings`

### test

- `helpers.ts`：`makeSettingsDeps` 删 `localFallbackName`
- `settings.test.ts`：删除 `localFallback` 断言，空链用例改名"GET 返回空链信息"
- `health.test.ts`：新增两个用例——providers 非空 → `warnings` 为 `[]`；providers 为空 → 指定警告文案且 HTTP 200
- `embedding-registry.test.ts`：无 local 用例残留，未改动（全部用例本就单参构造）

## 与计划的偏差

- `createRegistry`（registry.ts 尾部，当前无调用点）：计划未明确，按同样去本地化处理为双参，避免留下引用已删除符号的死代码
- `settings.test.ts` 空链用例改为断言 `providers: []`（原断言的主体是已删除的 `localFallback` 字段）
- 其余全部按计划落地，无偏差

## 测试 / 验收结果

- 根目录 `npm test`：10 个文件 70 个用例全绿
- 根目录 `npm run build`：tsc -b + 前端 Vite 构建全绿
- `grep "transformers|LocalEmbed|localFallback|SH_MODEL_"`：src 范围零命中（仅 package-lock 历史依赖描述，刷新后随 npm install 消除）
- 运行时冒烟（独立端口 + 临时 DB/providers 文件）：
  - 空链：`/health` 200，`version: "0.5.0"`，`warnings` 非空，`embedding.providers` 为空
  - 非空链（1 个 enabled provider）：`warnings` 为 `[]`，provider `kind: "remote"`
- `/v1/search` 空链错误映射与 reindex failed 计数由现有测试覆盖（`EmbeddingUnavailableError` 路径）

## 遗留事项

- 本机 7428 端口上尚有一个改动前启动的旧 dev 进程在运行旧代码，需手动重启后才能看到新行为
- 云端 provider（`cloud-newapi`）仍是占位地址，待按根 plan.md 提供商链补真实地址

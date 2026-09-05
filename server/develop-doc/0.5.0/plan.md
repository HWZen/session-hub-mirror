# 0.5.0 — 移除本地 CPU 向量兜底，提供商链纯化 + health 警告

## 需求描述

实测（2026-09-05）：索引时远程链全部失败，全部会话降级到 `local-cpu-bge-m3`（`@huggingface/transformers` fp32 CPU 推理），Node 进程峰值内存 **20G+**。根因：bge-m3 fp32 权重常驻 ~2.2G + batch 8 × 8192 token 的 fp32 注意力中间张量（`registry.ts` LOCAL_BATCH_SIZE=8 / LOCAL_MAX_CHARS=12000）。

部署服务器（plan.md §4）：i3-9100F / 16G / 1050Ti 4G（决策：向量计算不用 GPU），本地 fp32 推理根本跑不动。

用户决策（2026-09-05，已同步根 `plan.md` §3 与 `AGENTS.md` 提供商链章节）：

1. **取消"本地向量模型"特殊概念**：删除内置本地 CPU 兜底 provider
2. 本地推理服务（Ollama/llama.cpp/vLLM 等）如需要，**按普通 OpenAI 兼容 provider 配置**（`providers` 数组里加一条指向 `http://127.0.0.1:11434/v1` 之类的条目即可；模型名仍全链固定 `bge-m3`，符合"不允许配置模型"决策）
3. **无可用提供商不静默兜底**：health 返回警告；索引/搜索走现有失败路径显式报错

## 方案

### 1. Registry 纯远程化（`server/apps/server/src/embedding/registry.ts`）

- 删除 `LocalEmbedProvider` 类、`createLocalEmbedProvider`、`LOCAL_BATCH_SIZE`/`LOCAL_MAX_CHARS`/`LOCAL_MODEL_REPO`/`LOCAL_COOLDOWN_MS` 常量、`FeatureExtractionPipeline` 类型导入
- `EmbeddingRegistry` 构造函数移除第二参 `local`（测试均用单参构造，调用点天然兼容）；`providers` getter 恒返回 remote 数组
- 删除 `@huggingface/transformers` 依赖（`server/apps/server/package.json`）

### 2. 配置面收敛

- `config.ts` envSchema 删 `SH_MODEL_CACHE_DIR` / `SH_MODEL_HUB_ENDPOINT` / `SH_MODEL_HUB_PATH_TEMPLATE`（zod 对多余 env 键默认 strip，旧 `.env` 不清理也不报错，但仍应删掉）
- `.env.example` 删"模型缓存目录/模型下载源"两段
- `config/providers.json` 样例：`_note` 更新（说明本地推理服务按普通 provider 配置）；新增一条 `local-inference` 示例条目（`enabled: false`）演示写法
- `packages/shared/src/settings.ts`：`ProvidersSettingsResponse` 删 `localFallback` 字段（真实 `providers.local.json` 无该字段，无需迁移）

### 3. health 警告

- `packages/shared/src/api.ts`：`HealthStatus` 顶层加 `warnings: string[]`
- `routes/health.ts`：`registry.providers` 无任何 enabled provider（即数组为空）时 push `"未配置任何向量提供商，索引与语义检索不可用"`；否则空数组。HTTP 仍 200（`ok` 只反映 db 健康与存活，缺提供商属配置缺失）

### 4. Web

- `settings.tsx`：删"本地 CPU 兜底"卡片（约 427-431 行）与 `localFallback` 引用（216 行）；provider 列表为空时显示提示文案
- `system.tsx`：健康页展示 `warnings`（警告样式条）
- `index.tsx`：总览页加告警条（复用未索引告警样式），展示 health `warnings`

### 5. 测试

- `settings.test.ts`：删 `localFallback` 断言（36-40 行）；helpers.ts 删 `localFallbackName`
- `health.test.ts`：加 warnings 断言（空链 → 警告；有 provider → 空数组）
- `embedding-registry.test.ts`：确认无 local 用例残留

## 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/shared/src/api.ts` | HealthStatus 加 warnings |
| `packages/shared/src/settings.ts` | 删 localFallback 字段 |
| `server/apps/server/src/embedding/registry.ts` | 删 local provider 全部代码 |
| `server/apps/server/src/bootstrap.ts` | 不再创建 localProvider；SettingsRouteDeps 删 localFallbackName |
| `server/apps/server/src/config.ts` | 删 3 个 SH_MODEL_* env |
| `server/apps/server/src/routes/settings.ts` | 删 localFallback 输出 |
| `server/apps/server/src/routes/health.ts` | warnings 逻辑 |
| `server/apps/server/package.json` | 删 @huggingface/transformers |
| `server/apps/server/test/{helpers,settings,health,embedding-registry}.test.ts` | 同步 |
| `server/.env.example` / `server/.env`（本机不入库） | 删模型缓存/hub 配置 |
| `server/config/providers.json` | 样例更新 |
| `server/apps/web/src/routes/{settings,system,index}.tsx` | UI 同步 |
| 根 `plan.md` / `AGENTS.md` | ✅ 已同步（规划阶段完成） |

## 任务清单

1. shared：`api.ts` 加 warnings、`settings.ts` 删 localFallback
2. server：registry 清理、bootstrap/config/settings 路由联动删引用
3. server：health warnings 逻辑
4. server：依赖删除（package.json）与 `.env` / `.env.example` / `config/providers.json` 清理
5. web：settings / system / index 三页
6. test：helpers + 三个测试文件更新
7. 根目录 `npm test` + `npm run build` 全绿
8. 写 summary.md

## 验收标准

- 根目录 `npm test`、`npm run build` 全绿
- `grep -r "transformers\|LocalEmbed\|localFallback\|SH_MODEL_"`（src 范围）零命中
- providers 全空：`/health` 200 且 `warnings` 非空；`/v1/search` 返回现有 EmbeddingUnavailable 错误映射；reindex 返回 failed 计数
- providers 非空（enabled）：`warnings` 为 `[]`
- 设置页无"本地 CPU 兜底"卡片；providers 空时有引导提示
- 总览页/健康页能看到"未配置任何向量提供商"警告

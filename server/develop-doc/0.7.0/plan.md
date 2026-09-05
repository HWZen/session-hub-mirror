# 0.7.0 — 索引状态口径对齐 + 后台自动补索引

> 起因（2026-09-05，用户实测）：切换向量提供商（活跃模型变更）后，
> ① 存量会话不会自动重建索引，检索搜不到任何内容，必须手动点「重建索引」；
> ② 会话详情页徽标仍显示绿色「已索引」（旧模型索引的），与总览页"全部未索引"矛盾，误导用户。

## 需求描述

1. **后台自动补索引**：服务端运行期间自动消化未索引积压（含模型切换后 `indexed_model != activeModel` 的会话），用户切换模型后无需手动补索引
2. **详情页徽标口径对齐**：索引状态按活跃模型判定，与 `stats()` / `listUnindexed` 口径一致，不得再出现"详情页已索引、总览页未索引"的矛盾展示
3. 设置页「重建索引」保留为手动兜底入口，文案同步"后台自动补索引"的存在

## 方案

### 1. 自动补索引器（新模块 `server/apps/server/src/auto-index.ts`）

- `AutoIndexer` 类：依赖 `repo` / `indexer` / `registry`，构造参数注入 `intervalMs`
- 循环用**递归 setTimeout**（不用 setInterval，天然防重入）：
  - `runOnce()`：`activeModel()` 为 null → 直接返回（无 provider，静默等下轮）；`listUnindexed(BATCH, activeModel)` 非空则逐个 `indexSession`，本批全成功且可能还有积压则立即继续下一批，否则结束本轮
  - 单轮整体 try/catch：`EmbeddingUnavailableError`（全部 provider 失败/冷却中）只记日志退避等下轮，**绝不让未捕获异常杀死服务**（NSSM 守护场景）
  - `start()`：启动即跑首轮，之后每 `intervalMs` 一轮；`stop()` 清 timer
- 批量大小 BATCH = 50（单轮内多批消化，避免一次性占库太久；SMB 上 TRUNCATE/FULL 模式下写压力大）
- 触发点：
  - `index.ts` 启动后 `autoIndexer.start()`
  - `PUT /v1/settings/providers` 保存后调用 `autoIndexer.kick()`（提前触发下一轮，模型切换后秒级开始重建，不必等 interval）
- 与手动 `POST /settings/reindex` 并发：操作按会话事务（`storeEmbeddings` 内嵌事务 + `setIndexed` 幂等），重叠无害，不做互斥（记录为已接受的设计取舍）
- 日志：只打 `[auto-index]` 元数据与统计（会话 id、计数、provider 错误消息），不打印会话正文

### 2. 配置（`config.ts` + `.env.example`）

- envSchema 新增 `SH_AUTO_INDEX_INTERVAL_MS`（`z.coerce.number().int().min(5000).default(30000)`）
- `.env.example` 补一行注释示例

### 3. 详情页徽标口径（`server/apps/web/src/routes/sessions/-components/session-detail.tsx`）

- 详情页新增 `useQuery(["health"])` 取 `embedding.model`（= activeModel，overview 已有同款用法）
- 徽标三态：
  - `indexed_at == null` → 「未索引」（warning，现状不变）
  - `indexed_at != null && indexed_model === health.model` → 「已索引」（success，附模型名）
  - `indexed_at != null && indexed_model !== health.model` → 「已索引(旧模型 xxx)」（warning 样式，title 提示"当前模型空间未索引，检索覆盖不到，等待后台补索引或手动重建"）
- `health` 未加载完成 / 无 provider（model 为空串）时：按 `indexed_at` 展示并附 `indexed_model` 名，不误标绿色

### 4. 设置页文案（`server/apps/web/src/routes/settings.tsx`）

- 「重建索引」卡片描述改为说明"服务端运行时会自动为未索引会话补建向量（每 30 秒一轮）；此按钮为手动立即触发"

### 5. 测试（`server/apps/server/test/`）

- 新增 `auto-index.test.ts`（fake providers，vitest 假计时器或直接调 `runOnce()`）：
  - 模型 A 索引后切到模型 B：`runOnce()` 一轮后 B 空间可检索、`stats` 归零、旧 A 表数据仍在
  - 无 provider（activeModel null）时 `runOnce()` 不动作不报错
  - provider 全失败时 `runOnce()` 不抛异常、会话保持未索引，下一轮恢复后消化
  - `kick()` 在 interval 未到时提前触发下一轮
- `settings.test.ts`：PUT providers 后触发 kick 的冒烟断言（ spying 或间接验证）

## 涉及文件

| 文件 | 动作 |
|---|---|
| `server/package.json` | version 0.6.0 → 0.7.0 |
| `server/apps/server/src/auto-index.ts` | 新建 AutoIndexer |
| `server/apps/server/src/index.ts` | 启动 AutoIndexer |
| `server/apps/server/src/routes/settings.ts` | PUT providers 后 kick |
| `server/apps/server/src/config.ts` | env 加 SH_AUTO_INDEX_INTERVAL_MS |
| `server/.env.example` | 补示例 |
| `server/apps/web/src/routes/sessions/-components/session-detail.tsx` | 徽标三态口径 |
| `server/apps/web/src/routes/settings.tsx` | reindex 卡片文案 |
| `server/apps/server/test/auto-index.test.ts` | 新建用例 |
| `server/apps/server/test/settings.test.ts` | kick 冒烟断言 |

## 任务清单

1. config.ts + .env.example：新 env
2. auto-index.ts：AutoIndexer（runOnce / start / stop / kick）
3. index.ts 启动接线；settings.ts PUT 后 kick
4. web session-detail 徽标三态
5. web settings 文案
6. test：auto-index 用例 + settings kick 断言
7. 根目录 `npm test` + `npm run build` 全绿
8. 写 summary.md

## 验收标准

- 根目录 `npm test`、`npm run build` 全绿
- 集成行为：配置 provider A（模型甲）索引若干会话 → 切换为 provider B（模型乙）→ 不做任何手动操作，30 秒内自动补索引完成，检索在新模型空间可命中，总览未索引数归零
- provider 全挂时服务不崩：日志出现 `[auto-index]` 失败记录，恢复后自动消化积压
- 详情页：旧模型索引的会话显示警告态"已索引(旧模型 xxx)"而非绿色已索引；当前模型索引的显示绿色已索引(模型名)；无索引记录显示未索引
- 手动「重建索引」与自动补索引并发不产生脏数据（重复执行幂等）

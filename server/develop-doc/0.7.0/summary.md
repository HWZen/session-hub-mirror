# 0.7.0 — 索引状态口径对齐 + 后台自动补索引 · 完成记录

## 实际改动

### server

- `auto-index.ts`（新增）：`AutoIndexer` 类，构造注入 `repo` / `indexer` / `registry` / `intervalMs`
  - `runOnce()`：`activeModel()` 为 null 直接返回 0；循环 `listUnindexed(BATCH=50, activeModel)` 逐个 `indexSession`，本批全成功且满批（可能还有积压）才继续下一批，否则结束；返回本轮成功数
  - `start()`：启动即跑首轮；`stop()` 清 timer 并停摆；`kick()` 在空闲且有 pending timer 时清掉并立即跑一轮（interval 未到提前触发），`#running` 标记防重入
  - 循环用递归 setTimeout（非 setInterval），单轮整体 try/catch，任何异常（含 `EmbeddingUnavailableError`）只打 `[auto-index]` 日志后照常排下轮，不会杀死服务
- `index.ts`：启动后 `new AutoIndexer(...)` + `start()`；`settings` deps 注入 `onProvidersSaved: () => autoIndexer.kick()`
- `routes/settings.ts`：`SettingsRouteDeps` 加可选 `onProvidersSaved`；`PUT /providers` 保存并 `replaceRemoteProviders` 后调用（校验失败不触发）
- `config.ts`：envSchema 新增 `SH_AUTO_INDEX_INTERVAL_MS`（`z.coerce.number().int().min(5000).default(30000)`）
- `.env.example`：补 `SH_AUTO_INDEX_INTERVAL_MS` 注释示例

### web（`server/apps/web/src/`）

- `routes/sessions/-components/session-detail.tsx`：详情页新增 `useQuery(["health"])` 取活跃模型；索引徽标抽成 `IndexBadge` 三态：
  - `indexed_at == null` → 「未索引」（warning）
  - `indexed_model === activeModel` → 「已索引 · 模型名」（success）
  - `indexed_model !== activeModel` → 「已索引(旧模型 xxx)」（warning，title 提示"当前模型空间未索引，检索覆盖不到，等待后台补索引或手动重建"）
  - health 未加载 / 无 provider（activeModel 空串）→ 按 `indexed_at` 展示并附 `indexed_model` 名，warning 样式，不误标绿色
- `routes/settings.tsx`：维护卡片描述改为"服务端运行时会自动为未索引会话补建向量（默认每 30 秒一轮，保存提供商配置后立即提前触发）；此按钮为手动立即触发（每次最多 200 条）"

### 测试（`server/apps/server/test/`）

- `auto-index.test.ts`（新增，4 用例）：
  - 模型 A 索引 2 会话 → 切模型 B：切换动作本身不破坏旧 A 表数据（3 条向量仍在）、`listUnindexed` 口径命中 2 条；`runOnce()` 一轮后 B 空间检索命中 2 条、stats indexed=2/unindexed=0、B 表 3 条
  - 无 provider（activeModel null）`runOnce()` 返回 0 不报错
  - FailingEmbedProvider 全失败：`runOnce()` 不抛异常返回 0、会话保持未索引；换 good provider 后下一轮 `runOnce()` 消化并检索命中
  - fake timers：`start()` 首轮后制造积压，`advanceTimersByTimeAsync(59_999)`（60s interval 未到）不动作；`kick()` 立即触发一轮消化积压；`stop()` 后时间推进不再动作
- `settings.test.ts`：新增"PUT 保存成功触发 `onProvidersSaved`（auto-index kick 冒烟），校验失败不触发"用例

## 与计划的偏差

1. **"旧 A 表数据仍在"的断言时机**：plan 的 runOnce 用例写"一轮后……旧 A 表数据仍在"，但 0.6.0 已定稿的 `storeEmbeddings` 语义是先跨表清旧向量再写新模型表（`model-partition.test.ts` 已验证补索引成功后旧表行清空），补索引成功后 A 表不可能残留已处理会话的向量。测试改为断言**切换后、runOnce 前**旧 A 表数据完好（3 条向量仍在，证明切换/补索引动作不会预先破坏旧数据），补索引成功后按 0.6.0 口径清空。该"切换不破坏旧数据"属性与 plan 意图一致。
2. **`stop()` 后的收尾**：plan 只说"stop() 清 timer"；实现还带 `#stopped` 标记，stop 后未决 timer 回调/ kick 均不再启动新循环，避免测试与关停场景残留动作。
3. `runOnce()` 返回本轮成功数（plan 未定义返回值），供测试断言与日志使用。

## 测试 / 验收结果

- 根目录 `npm test`：**12 个文件 85 个用例全绿**
- 根目录 `npm run build`：tsc -b + 插件 typecheck + 前端构建全绿
- 验收标准逐条核对：
  - 切换模型后自动补索引：集成路径由 `auto-index.test.ts` 首个用例覆盖（切换 → runOnce → B 空间可检索、stats 未索引归零）；真实 30 秒轮询由 `start()`/`kick()` 接线保证（PUT providers 后 kick，秒级触发）
  - provider 全挂服务不崩：`runOnce()` 整轮 try/catch + `indexSession` 内部捕获，`[auto-index]` 失败日志、恢复后自动消化 ✅（用例 3）
  - 详情页徽标三态口径对齐：当前模型绿色已索引(模型名)、旧模型 warning"已索引(旧模型 xxx)"、无索引记录"未索引"、health 缺失不误标绿色 ✅（`IndexBadge`）
  - 手动 reindex 与自动补索引并发：两边都走 `indexSession`（`storeEmbeddings` 内嵌事务 + `setIndexed` 幂等），重复执行无脏数据；按 plan 记录为已接受的设计取舍，未做互斥

## 遗留事项

- 自动补索引与手动 reindex 并发时同一会话可能被重复索引（幂等，无脏数据，仅浪费一次 embed 调用）；如后续 SMB 写压力明显，可加进程内互斥
- 未处理进程退出信号（SIGTERM/SIGTERM 时 `stop()`），pending timer 随进程终止自然消亡，NSSM 守护场景无影响
- `SH_AUTO_INDEX_INTERVAL_MS` 最小 5000ms；批量大小 BATCH=50 为硬编码常量，未开放配置

# 0.7.1 — 修复 vec0 影子表损坏（ALTER RENAME 后遗症）

> 起因（2026-09-06 凌晨排障）：0.6.0 开发期间对旧向量表执行过
> `ALTER TABLE message_embeddings RENAME TO message_embeddings_bge_m3`（意图免重嵌迁移），
> 而 **sqlite-vec 0.1.9 未实现 xRename**：vtab 注册行被改名，影子表
> （`*_info` / `*_chunks` / `*_rowids` / `*_vector_chunks00`）仍留在旧名 `message_embeddings_*` 下。
> 结果：`message_embeddings_bge_m3` 成为指向不存在影子表的"空壳"，一切读写报
> `no such table: main.message_embeddings_bge_m3_rowids`。
> 22:05 迁移 0002 应用时因 bge_m3 "已存在"走了只 DROP 旧表的分支（旧表当时已被改名，
> DROP 无对象可删），损坏固化。

## 现象（排障实测）

- 活跃模型已切 `qwen3-embedding:8b`（5070ti-frp），133 个会话全部待索引；
  auto-index 每轮真实调用远端 embed 成功（远端 GPU 持续工作），但落库阶段
  `storeEmbeddings → clearSessionEmbeddings` 遍历到损坏的 bge_m3 表即抛错，
  133/133 全部失败（`POST /v1/settings/reindex` 实测 `{"total":133,"indexed":0,"failed":133}`）
- 连带症状：`repo.upsert` 同样调用 `clearSessionEmbeddings` 遍历所有模型表，
  因此 22:05 之后**所有会话 upsert 也静默失败**，新会话无法入库
- 真库状态：`message_embeddings_bge_m3`（vtab 空壳）+ 孤儿影子表
  `message_embeddings_info/_chunks/_rowids/_vector_chunks00`（内含 2161 行旧 bge-m3 向量，数据完好）

## 机制（已用最小复现确认）

- vec0 0.1.9 的 `CREATE VIRTUAL TABLE` 影子表命名正确（`<表名>_info` 等）
- `ALTER TABLE <vec0> RENAME TO`：只改 vtab 注册行，**影子表不跟随**（无 xRename）
- 改名后的 vtab 按新名查找影子表 → 全部缺失 → 读写全炸
- 对影子表缺失的 vtab 直接 `DROP TABLE` 也失败（vec0 destroy 找不到影子表报 SQL logic error）
- 可用出路：**把 vtab 改名回影子表所属的旧名**，表立即恢复健康、2161 行数据可读可写；
  随后走 0002 本应走的正规路径（建新表 + 拷贝 + DROP 旧表），干净收尾
- `writable_schema` 直改 sqlite_master 被 SQLite 3.53 拒绝；`VACUUM INTO` 会把损坏原样带走，均不可用

## 方案

### 1. `db/migrate.ts`

新增迁移 `0003_repair_vec0_shadow_tables`，检测签名（三个条件同时满足才触发）：

- vtab `message_embeddings_bge_m3` 存在
- 其影子表 `message_embeddings_bge_m3_info` 不存在
- 旧名影子表 `message_embeddings_info` 存在（即影子表仍挂在旧名下）

修复动作（事务内）：

1. `ALTER TABLE message_embeddings_bge_m3 RENAME TO message_embeddings`
   —— 逆转改名，表恢复健康（副本实测：2161 行完好、可写）
2. 复用 `renameLegacyEmbeddingsTable`：新建空壳同名 bge_m3 → `INSERT INTO ... SELECT` 拷贝
   全部向量 → `DROP` 旧表，与 0002 原始意图完全一致
3. 结果：健康的 `message_embeddings_bge_m3`（含全部 2161 行旧 bge-m3 向量），
   无孤儿表残留

兜底清理：若 `message_embeddings%` 下存在**不属于任何活跃 vtab** 的孤儿影子表
（如未来出现改名+建新表并存的组合态），逐个 `DROP`（已验证普通 DROP 对无主影子表可行）。

其余状态一律 no-op（全新库、健康库、已修复库）。

### 2. 不变项

- sessions / messages / `indexed_at` / `indexed_model` 均不动；
  修复后 auto-indexer 发现活跃模型 qwen3-embedding:8b 下全部未索引，自动补嵌全量
- 2161 行旧 bge-m3 向量**保留**（与本仓库"旧空间数据保留"决策一致；
  切回 bge-m3 provider 时 0.7.2 的覆盖检查可直接复用，无需重嵌）
- upsert 路径无需改动：损坏表修复后 `clearSessionEmbeddings` 自然恢复正常

## 涉及文件

| 文件 | 动作 |
|---|---|
| `server/package.json` | version 0.7.0 → 0.7.1（规划阶段已改） |
| `server/apps/server/src/db/migrate.ts` | 新增 0003 迁移 + 孤儿影子表兜底清理 |
| `server/apps/server/test/migrate-repair.test.ts` | 新增：损坏态修复、幂等、健康态 no-op |
| `server/develop-doc/0.7.1/plan.md`、`summary.md` | 本档案 |

## 任务清单

1. migrate.ts：损坏签名检测 + 0003 迁移 + 兜底清理
2. migrate-repair.test.ts：三态用例
3. 根目录 `npm test` + `npm run build` 全绿
4. 线上验证：tsx watch 自动重启 → `/health` 正常 → `/v1/stats` 未索引逐步归零、
   qwen3 表行数增长、新会话可入库
5. summary.md + commit

## 验收标准

- 迁移后 `sqlite_master` 中 `message_embeddings%` 仅剩健康 vtab 及其 4 张影子表，
  `select count(*) from message_embeddings_bge_m3` = 2161
- `/v1/settings/reindex` 返回 `failed=0`；补索引完成后 stats `unindexed` 归零
- upsert 恢复：新会话可入库（观察 sessions 总数增长）
- 对健康库重复启动 / 重复迁移不产生任何副作用

## 非目标 / 遗留

- 不升级 sqlite-vec（0.1.9 现状够用）；"vec0 表禁止 RENAME"作为经验记录进 summary，
  不加运行时防御
- 旧空间保留与切回零成本复用 → 0.7.2（原需求顺延）
- 孤儿影子表兜底清理仅覆盖 `message_embeddings%` 前缀，通用虚拟表巡检另立版本

# 0.7.1 — 修复 vec0 影子表损坏（ALTER RENAME 后遗症）

## 实际改动

| 文件 | 改动 |
|---|---|
| `server/package.json` | version 0.7.0 → 0.7.1 |
| `server/apps/server/src/db/migrate.ts` | 新增 `0003_repair_vec0_shadow_tables`：签名检测（bge_m3 vtab 存在 + 其影子表缺失 + 旧名影子表存在）→ `ALTER RENAME` 逆转改名恢复旧表 → 复用 `renameLegacyEmbeddingsTable` 建新表 + 拷贝 2161 行向量 + DROP 旧表；另加 `dropOrphanShadowTables` 兜底清理无主 `message_embeddings%` 残留 |
| `server/apps/server/test/migrate-repair.test.ts` | 新增 3 用例：损坏态修复（含垃圾表兜底清理 + 二次迁移幂等）、修复后向量可检索、健康库 no-op |

## 与计划的偏差

无实质偏差。两点记录：

1. 测试实现细节：`makeDb()` 首次 `migrate()` 即把 0003 记为已应用（健康态 no-op），
   之后人为构造损坏态再 `migrate()` 不会触发修复——测试用例需先
   `DELETE FROM _migrations WHERE name='0003...'` 再触发（等价于"带着损坏升级到含修复的版本"）。
   线上真实库无此问题（0003 此前从未应用过）。
2. 排障期间曾尝试 `writable_schema` 直改 sqlite_master（SQLite 3.53 拒绝）、
   `VACUUM INTO`（损坏原样带走）两条路，均不可用，最终确定 RENAME 逆操作是唯一干净出路，
   已写入 plan.md 供后续参考。

## 测试 / 验收结果

- `npm test`：13 文件 88 用例全过（含新增 3 用例）
- `npm run build`：全绿
- 线上验证（tsx watch 自动重启后）：
  - `sqlite_master` 中 `message_embeddings%` 仅剩 `message_embeddings_bge_m3` + 其 4 张影子表 +
    `message_embeddings_qwen3_embedding_8b` + 其 4 张影子表，无孤儿残留
  - auto-indexer 自动以 qwen3-embedding:8b 补嵌全部 133 会话，`/v1/stats` 归零：
    `{"sessions":133,"indexed":133,"unindexed":0}`
  - upsert 链路恢复：探针会话 `PUT /v1/sessions` 返回 201 且 `indexed=true`
    （即时索引命中），随后 `DELETE` 清理，会话总数回到 133
- `/health`：version 0.7.1，db ok（journal_mode=truncate），embedding provider ready

## 遗留事项

- **经验红线**：sqlite-vec 0.1.9 未实现 xRename，vec0 表**禁止 `ALTER TABLE RENAME`**
  （vtab 行被改、影子表不跟随，表即报废）。未加运行时防御，靠评审把关
- 旧空间向量保留 / 切模型零成本复用 → 0.7.2（原需求顺延，plan 已就位）
- 排障期间发现的 0.6.0 `storeEmbeddings` 全模型表清理行为正是本次故障的放大器
  （遍历到损坏表即全盘失败），0.7.2 的定向清理改造会同时消除该放大器
- 排障用的临时脚本与 DB 副本均在 `C:\Users\HWZ\AppData\Local\Temp\opencode\`，不入库

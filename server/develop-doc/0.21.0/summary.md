# 0.21.0 开发总结 — FTS5 trigram/BM25 + Dense 混合检索与 Session 级 RRF

按 `plan.md` 落地完成。`npm test`（31 文件 / 253 用例）与 `npm run build` 全绿。

## 实际改动

### 数据库 / 迁移

- `server/apps/server/src/db/migrate.ts`
  - 新增 `0007_chunk_fts`：external-content FTS5 表 `message_chunks_fts`（trigram tokenizer，
    content 指向 `message_chunks`，rowid 对齐 `message_chunks.id`）；
  - 同步 triggers：`message_chunks_fts_ai/ad/au`（INSERT/DELETE/UPDATE 三路同步，含 FTS5
    `'delete'` 命令的正确旧值传递）；
  - 迁移时对存量 chunks 执行 `rebuild`——升级不需要重算 embedding、不清 `indexed_at/indexed_model`；
  - 迁移内显式探测 FTS5 可用性（`fts5Available()`），不可用时迁移失败报错，不静默退回 dense-only。

### 词法通道

- 新增 `server/apps/server/src/db/lexical.ts`
  - `buildLexicalMatch()`：query trim → Unicode whitespace 切 atom → 按 Unicode code point
    （`[...atom]` 展开，surrogate pair 正确）滑窗 3 字符 → 去重 → 超过 `MAX_LEXICAL_TRIGRAMS=128`
    时等距采样（保首尾）→ quoted phrase（`"` 转义为 `""`）OR 连接；无 trigram 返回 null；
  - `searchLexicalChunks()`：FTS5 MATCH + `bm25()` 升序，JOIN `message_chunks → messages → sessions`
    复用 `buildSessionFilter()`（filters 对 lexical 生效），候选量级与 dense 同（×50、上限 1024）。

### 融合检索

- `server/apps/server/src/db/search.ts` 重构
  - dense 检索抽出 `searchDenseChunks()`（行为不变，SELECT 增加 `chunk_id`），行统一为
    `CandidateRow`（含 `session: SessionRecord`）；
  - `aggregateBySession()`：两通道各自按输入序（dense 按 distance、lexical 按 bm25）聚合为
    session ranking，rank 从 1 起，每 session 留前 5 个 chunk 作 snippet 候选；
  - fusion depth：`min(max(top_k*5, 50), 200)`，两路各提供最多 depth 个 session；
  - RRF：`k=60`，dense/lexical 等权（各 1），排序为 score 降序 → 最佳单路 rank 升序 →
    session id 稳定 tie-break；
  - snippet 合并：按 `chunk_id` 去重，双路命中合并 `matched_by`，dense/lexical 交错取证据，
    每 session 仍 ≤5 条、文本截断 500 字符；
  - `searchSessions()` 签名增加 `query` 字符串参数（供 lexical 构造）。

### API / 契约

- `packages/shared/src/session.ts`
  - 新增 `SearchChannel = "dense" | "lexical"`；
  - `SearchHit`：`distance: number|null`、新增 `score`（RRF）与 `matched_by`；
  - `SearchSnippet`：`distance` 改 nullable、新增 `matched_by`；
- `server/apps/server/src/routes/search.ts`：传入 query 文本，其余流程不变；
  embedding 仍必需（全不可用保持 503），lexical-only 降级不在本版。
- `server/apps/server/src/routes/help.ts`：`/v1/search` 文案全面改写（混合检索、RRF、score、
  nullable distance、matched_by、trigram 短查询下限、grep 分工）；`/v1/grep` 描述同步微调。

### Web / Skill

- `server/apps/web/src/routes/search.tsx`
  - 语义模式更名展示为"混合检索"；会话级显示命中通道 badge（语义 / 词法 / 双路）；
  - `distance` badge 降级为辅助信息（title 提示"仅供参考"，移除原按距离着色的相关性暗示）；
  - snippet 级在 lexical 参与时显示"词法 / 双路"小标签；
- `skills/session-hub/SKILL.md`：/search 场景改为混合检索，示例返回补 `score`/`matched_by`，
  说明 lexical-only 的 `distance=null` 与 3 字符下限；grep 场景补充短串分工。

### 测试

- 新增 `server/apps/server/test/lexical.test.ts`：query builder 11 用例（中文、identifier、
  kebab-case、跨 atom 独立开窗、去重、surrogate pair、引号转义、<3 字符 null、128 上限等距采样保首尾）；
- `migrate-repair.test.ts` 新增 `0007 chunk fts` 组：新库建表与 triggers、存量 chunks rebuild 后
  rowid 对齐、upsert（清旧+插新）与 UPDATE 后 FTS 一致、删除消息无 orphan；
- `search.test.ts` 新增 `hybrid search` 组：identifier 由 lexical 召回、双路命中合并 `matched_by`、
  无 dense 表时 lexical-only（`distance=null`）、filters 对 lexical 生效、短查询 dense 正常；
- `model-partition.test.ts`：切模型后 B 空间搜索断言由 `results=[]` 改为
  "无 dense 命中（matched_by 不含 dense 且 distance 全 null）"——行为变化来自 lexical 通道不依赖模型，
  分区语义本身不变（auto-index、embedding 相关其余测试均未改动）。

### 验收

- `server/develop-doc/0.21.0/acceptance/run.tsx` + `acceptance.md`：构造 4 会话数据集验证
  §11 三类查询（identifier / 自然语言 / 混合），lexical 召回与 RRF 融合均符合预期，
  双路命中分数约为单路两倍；记录各查询的 per-session `matched_by` 与 fused score。

## 与计划的偏差

1. **`server/package.json` version 递增补在开发阶段**：规划提交（520f95e）只含 plan.md，
   本次开发将 version 0.20.0 → 0.21.0。
2. **dense 行结构显式化**：实现中发现 dense/lexical 两路需要统一的 `CandidateRow`
   （含 `session` 对象与 `chunk_id`），比 plan 中"沿用现有 KnnRow"多了一层显式类型收敛，
   属实现细节，无行为差异。
3. **model-partition 测试断言语义更新**（见上），是 hybrid 化的必然结果，非回归。

## 测试 / 验收结果

- `npm test`：31 文件 / 253 用例全部通过；
- `npm run build`：tsc + 前端构建通过；
- 人工验收（构造数据集）：见 `acceptance/acceptance.md`。

## 线上 dev 验收环境（0.21.x 线复用）

0.21.0 已部署到远程 dev 实例供真实库验收，**0.21.x 线的后续修复与验收继续复用该环境**（修改后重传产物并重启即可），不要动 `~/apps/session-hub`（生产 1696）：

| 项 | 值 |
|---|---|
| 机器 | `ssh hwz_intel_26`（WSL2 Ubuntu-26.04，用户 intel，sudo 密码向用户索取） |
| 部署目录 | `~/apps/session-hub-021-dev` |
| 服务 | `node apps/server/dist/index.js`（编译产物直跑），端口 **1697**，监听 127.0.0.1 |
| 公网入口 | `https://session-hub.example.test`（Windows 侧 nginx 反代 → 127.0.0.1:7428） |
| 数据库 | `~/apps/session-hub-021-dev/server/data/session-hub.db`，生产库的在线一致备份快照（better-sqlite3 backup API）；dev 与生产数据互不同步 |
| 配置 | `server/.env`（PORT=1697，token 与生产一致）；`server/config/providers.local.json` 复制自生产，embedding 走同一 frpc 隧道 |
| 依赖 | `node_modules` 整体复制自生产（better-sqlite3/sqlite-vec prebuilds 直接可用，不要在远程跑 `npm install`） |
| 启动 | `cd ~/apps/session-hub-021-dev/server && nohup node apps/server/dist/index.js > /tmp/sh021-dev.log 2>&1 &`；机器/WSL 重启后需手动拉起 |
| 日志 | `/tmp/sh021-dev.log` |

更新 dev 代码的流程（本分支有新 commit 时）：

```sh
git -C .worktrees/feature-0.21.0 archive --format=zip -o <tmp>.zip HEAD   # 注意 -C 指到本 worktree
scp <tmp>.zip hwz_intel_26:/tmp/
# 远端解压覆盖到 ~/apps/session-hub-021-dev（gitignore 的 .env/data/config/node_modules 不受影响）
```

- 仅 TS/前端改动：可本地 `npm run build` 后直传三份产物（`packages/shared/dist`、`server/apps/server/dist`、`server/apps/web/dist`）覆盖，再重启进程——远程缺插件 workspace 依赖，不要在远程跑全量 build。
- 若迁移有新增：重启即自动执行；重大迁移前先对 dev db 做一份备份。

## 遗留事项

- 真实库验收进行中（见 `acceptance/acceptance.md` 与上述 dev 环境），用户反馈的小问题将在
  0.21.x 线内继续修复；FTS rebuild 在十万级 chunks 上一次性完成，耗时可接受，升级时无需重算 embedding。
- plan §设计边界中列出的后续方向（text/reasoning/tool 分路、filtered-KNN recall、
  weighted RRF 等）未在本版处理，按计划留待后续版本。

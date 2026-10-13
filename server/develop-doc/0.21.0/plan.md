# 0.21.0 — FTS5 trigram/BM25 + Dense 混合检索与 Session 级 RRF

## 需求描述

当前 `POST /v1/search` 只有 dense 向量通道：query embedding → sqlite-vec KNN → chunk 命中 → 按 session 取最小 distance 聚合。
该方案对自然语言语义查询表现较好，但对分支名、函数名、错误码、路径片段、罕见英文术语等精确/稀有字面串召回不稳定。

0.17.0 探针已经出现明确例子：唯一标识符
`0.15.0-server-0.2.0-collector-dev` 在三个向量变体中都落到 40 名以后，说明继续调整 dense 元数据拼接无法解决此类问题。

本版本增加一条本地 lexical 通道：

- SQLite FTS5
- `trigram` tokenizer
- FTS5 内置 `bm25()` 排序
- lexical 与 dense **各自先聚合为 session 排名**
- 最后用 **Reciprocal Rank Fusion（RRF）** 融合

目标是补齐字面召回，同时保持当前 dense 语义检索优势，不引入 reranker、LTR、查询改写或额外模型。

---

## 设计边界

本版本只处理「lexical + dense + session-level fusion」。

以下内容明确留到后续版本讨论：

- `text` / `reasoning` / tool output 拆分为独立向量通道及不同权重；
- tool output 的索引策略；
- reasoning 数量明显高于正文导致的候选机会数偏置；
- dense KNN 在 session filters 之前取候选导致的 filtered-recall 问题；
- exact/grep 作为强 boost 信号；
- query rewrite / multi-query / HyDE；
- cross-encoder / LLM rerank；
- SPLADE / learned sparse / ColBERT；
- LTR。

`GET /v1/grep` 保持独立字面子串接口，本版不参与 RRF。

---

## 现状

### Dense 通道

`server/apps/server/src/db/search.ts` 当前：

1. query 由活跃 embedding provider 向量化；
2. `chunk_embeddings_<model>` 上 sqlite-vec KNN；
3. chunk 候选数：
   `k = min(max(top_k * 50, top_k), 1024)`；
4. JOIN `message_chunks → messages → sessions`；
5. session distance 取该 session 首个/最小 distance chunk；
6. 每 session 最多保留 5 个 snippet；
7. 最终按 distance 升序返回 top-k session。

### Chunk 数据

`message_chunks` 已持久化：

- `id`
- `message_id`
- `chunk_no`
- `source`（当前为 `text | reasoning`）
- `text`
- `char_start`

因此 lexical 索引可直接建立在现有 chunk 文本上，不需要重新解析原始会话。

### Grep

`GET /v1/grep` 当前使用 `messages.text LIKE '%q%'` / `instr()`：

- 只扫正文；
- 精确子串语义清晰；
- 无 relevance score；
- 按 session 更新时间排序；
- 不适合作为普通 ranked retriever。

---

## 方案

## 1. 新增 FTS5 trigram 索引

新增迁移 `0007_chunk_fts`。

建立 external-content FTS5 表，以 `message_chunks.id` 作为 rowid：

```sql
CREATE VIRTUAL TABLE message_chunks_fts USING fts5(
  text,
  content='message_chunks',
  content_rowid='id',
  tokenize='trigram'
);
```

选择 external-content 而不是在 FTS 表中重复保存 chunk 文本：

- 原始文本继续以 `message_chunks` 为唯一事实源；
- FTS 只承担倒排索引；
- 减少正文重复存储；
- lexical 命中后仍通过 `rowid → message_chunks.id` 回到现有数据模型。

为 `message_chunks` 建 INSERT / DELETE / UPDATE trigger，同步维护 FTS index。
虽然当前产品写路径主要是整 session 删除旧 chunks 后重新 INSERT，仍保留 UPDATE trigger，避免以后写路径扩展时产生隐式不一致。

迁移完成时对现有 `message_chunks` 执行一次 FTS5 `rebuild`，因此：

- 升级 0.21.0 **不需要重新请求 embedding**；
- 不需要清空 `indexed_at/indexed_model`；
- 不触发全库向量重建。

### FTS5 可用性

在迁移/测试中明确验证当前 better-sqlite3 所带 SQLite 支持 FTS5。
若运行环境缺少 FTS5，应启动/迁移时显式失败，不静默退回 dense-only，避免不同部署产生不同搜索语义。

---

## 2. Lexical query 构造

FTS5 trigram 对一整个长字符串做 phrase 查询会过于接近“完整子串匹配”，不适合作为 BM25 lexical 通道。
本版本由服务端把用户 query 转成一组可 OR 的 trigram phrase。

规则：

1. query trim；
2. 按 Unicode whitespace 切成 lexical atoms；
3. 每个 atom 使用 Unicode code point（不是 JS UTF-16 code unit）生成连续 3 字符窗口；
4. 去重；
5. 每个 trigram 作为 FTS5 quoted phrase，统一转义；
6. 用 `OR` 连接；
7. 总 trigram 数设置固定上限，防止 8000 字符 query 生成超大 MATCH 表达式；
8. 超过上限时在完整 trigram 序列中等距采样，并保留首尾，避免只偏向 query 开头。

建议初值：

- `MAX_LEXICAL_TRIGRAMS = 128`

例：

```text
no-negative-echo
```

转换后逻辑等价于：

```text
"no-" OR "o-n" OR "-ne" OR "neg" OR ...
```

中文连续文本同样自然生成 Unicode trigram，无需中文分词器。

### 短查询

不足 3 个 Unicode code point 的 atom 不产生 trigram。

如果整个 query 最终没有 lexical term：

- lexical 通道返回空列表；
- dense 通道照常工作；
- `GET /v1/grep` 仍可处理 1～2 字符的精确查询。

### 本版不做词级 tokenizer

本版本不增加 jieba / ICU / 自定义中文词典。
原因是当前确定性缺口首先是 identifier / error / path / 中英文混合字面召回；trigram 不依赖语言分词，且与 dense 通道互补。

后续 benchmark 若证明自然语言 lexical ranking 仍明显不足，再单独评估 word-level BM25。

---

## 3. Lexical chunk 检索

新增 lexical retrieval 函数，职责只到「lexical chunk candidates」。

核心 SQL 形态：

```sql
SELECT rowid AS chunk_id, bm25(message_chunks_fts) AS lexical_score
FROM message_chunks_fts
WHERE message_chunks_fts MATCH ?
ORDER BY bm25(message_chunks_fts)
LIMIT ?
```

FTS5 的 `bm25()` 数值越小表示 lexical match 越好。
融合阶段**不直接比较 BM25 与向量 distance 数值**，只使用各自的 rank。

lexical chunk candidates JOIN：

`message_chunks → messages → sessions`

并复用现有 `buildSessionFilter()`。

候选 chunk 数建议与 dense 保持同量级：

- multiplier：50
- max：1024

具体常量集中定义，不散落在 SQL/route 中。

---

## 4. 两路都先聚合为 Session ranking

RRF 的输入不是 chunk ranking，而是 **session ranking**。

### Dense session ranking

沿用当前原则：

- 一个 session 可能命中多个 dense chunks；
- session dense rank 由其最佳 dense chunk 决定；
- 保留该 session 的若干 dense snippets。

### Lexical session ranking

同样：

- 一个 session 可能命中多个 FTS chunks；
- session lexical rank 由其最佳 BM25 chunk 决定；
- 保留该 session 的若干 lexical snippets。

本版本不在 lexical 内部解决“长 session / reasoning chunks 更多，拥有更多抽签机会”的问题；
该问题与第三步的 source 拆分统一讨论，避免 0.21.0 同时改变多个变量。

### Fusion depth

最终请求 `top_k` 不能直接作为每路 candidate session 数，否则一条通道稍有排序误差就无法被另一条通道救回。

建议：

```text
fusion_depth = min(max(top_k * 5, 50), 200)
```

dense 与 lexical 都最多向融合层提供 `fusion_depth` 个 session。

dense 内部 sqlite-vec chunk KNN 仍受 1024 上限约束。

---

## 5. Session-level RRF

两路 session ranking 使用标准 Reciprocal Rank Fusion：

```text
rrf(session) =
  dense 命中   ? 1 / (RRF_K + dense_rank)   : 0
+ lexical 命中 ? 1 / (RRF_K + lexical_rank) : 0
```

初值：

```text
RRF_K = 60
dense weight   = 1
lexical weight = 1
```

rank 从 1 开始。

本版本不学习权重，也不根据 query 类型动态调权。
原因：

- 当前没有训练数据；
- RRF 的核心价值就是避免 cosine/L2/BM25 分数校准；
- 先用简单稳定 baseline，后续由 probe/benchmark 决定是否需要 weighted RRF。

排序：

1. RRF score 降序；
2. 最佳单路 rank 升序；
3. session id 做稳定 tie-break。

最后截取 `top_k`。

---

## 6. Snippet 合并

dense 和 lexical 可能命中同一 chunk，也可能分别命中不同 chunk。

内部 candidate 必须携带 `chunk_id`，融合后：

1. 按 `chunk_id` 去重；
2. 同一 chunk 同时被 dense/lexical 命中时合并 channel 标记；
3. dense-only / lexical-only snippet 都允许返回；
4. 两路 snippet 交错取证据，避免某一路先塞满 5 条导致另一条通道的有效证据完全不可见；
5. 每 session 仍最多 5 条 snippet；
6. 文本仍截断到 500 字符。

本版本不尝试把 L2 distance 和 BM25 score 归一化成统一 snippet score。

---

## 7. Search API 契约调整

`POST /v1/search` 请求体保持：

```json
{
  "query": "...",
  "top_k": 10,
  "filters": {}
}
```

顶层 `model` / `provider` 保留。

结果排序从“distance 升序”改为“RRF score 降序”。

建议 shared 类型增加：

```ts
type SearchChannel = "dense" | "lexical";

interface SearchHit {
  session: SessionRecord;
  score: number;              // RRF，越大越相关
  distance: number | null;    // 最佳 dense distance；lexical-only session 为 null
  matched_by: SearchChannel[];
  snippets: SearchSnippet[];
}

interface SearchSnippet {
  message_idx: number;
  role: string;
  text: string;
  ts: number | null;
  source: MessageSource;
  distance: number | null;    // dense 命中才有
  matched_by: SearchChannel[];
}
```

`distance` 暂保留，避免完全丢失现有 dense 调试信息；
但它不再是最终排序依据，help/Skill/Web 必须同步改写。

本版本 `POST /v1/search` 仍然需要 embedding provider：

- embedding 全部不可用时保持 HTTP 503；
- lexical-only 降级不在本版本改变；
- 现有 `GET /v1/grep` 继续作为不依赖 embedding 的 fallback。

这样可避免本次同时改变检索 ranking 与错误/降级语义。

---

## 8. /v1/grep 保持独立

`GET /v1/grep` 不纳入 RRF，也不替换为 FTS。

保留理由：

- grep 表达的是“这个字面串确实出现过”；
- FTS/BM25 表达的是 lexical relevance ranking；
- 两者语义不同；
- grep 支持 1～2 字符查询，而 trigram 天然至少需要 3 字符；
- grep 当前只搜正文，行为已经被 Agent Skill 和 help 明确定义。

未来若要把 exact match 变成 search 的强 boost，应单独设计，不在 0.21.0 隐式改变。

---

## 9. 代码结构建议

### DB / migration

- `server/apps/server/src/db/migrate.ts`
  - 新增 `0007_chunk_fts`
  - 创建 external-content FTS5
  - 创建同步 triggers
  - 对已有 chunks rebuild

- 新增 `server/apps/server/src/db/lexical.ts`
  - query → trigram MATCH expression
  - lexical chunk retrieval
  - lexical session aggregation

- `server/apps/server/src/db/search.ts`
  - 将当前 dense 检索拆成明确的 dense candidate/session ranking
  - 新增 RRF fusion
  - 不在此文件塞 FTS query parser 细节

### API / shared

- `packages/shared/src/session.ts`
  - `SearchChannel`
  - hybrid search response 字段

- `server/apps/server/src/routes/search.ts`
  - query embedding
  - dense + lexical
  - RRF
  - 返回 hybrid results

- `server/apps/server/src/routes/help.ts`
  - /search 文案改为 hybrid
  - 说明 RRF score、nullable distance、matched_by
  - grep 定位继续明确

### Web / Skill

- `server/apps/web/src/routes/search.tsx`
  - 结果不再按/展示“distance = 最终排名”
  - 可展示来源：语义 / 词法 / 双路
  - dense distance 仅作为辅助信息

- `skills/session-hub/SKILL.md`
  - /search 从“向量语义搜索”更新为“混合搜索”
  - 示例返回补 `score` / `matched_by`

---

## 10. 测试

### Migration / FTS 同步

新增覆盖：

1. 新库迁移后存在 `message_chunks_fts`；
2. 迁移已有 `message_chunks` 时 rebuild 后可检索；
3. 新 session 索引产生 chunk 后 FTS 自动可查；
4. session upsert 清旧 chunks 后旧 lexical term 消失、新 term 出现；
5. session 删除/重建路径不会留下 FTS orphan；
6. FTS table rowid 与 `message_chunks.id` 对齐。

### Query builder

覆盖：

- 中文连续文本；
- ASCII identifier；
- kebab-case；
- snake_case；
- Windows path；
- 引号与 FTS 特殊字符；
- emoji / surrogate pair；
- 重复 trigram 去重；
- <3 字符无 lexical query；
- 超上限等距采样。

### Hybrid ranking

至少覆盖：

1. dense 与 lexical 都命中同一 session；
2. dense 不召回但 lexical 命中的 identifier session 能进入最终 top-k；
3. lexical 弱但 dense 强的自然语言 session 不回退；
4. 两路命中不同 session 时 RRF 排序符合公式；
5. 同一 chunk 双路命中只返回一条 snippet；
6. lexical-only result 的 `distance=null`；
7. `matched_by` 正确；
8. filters 对 lexical 路径生效；
9. 原 reasoning snippet 的 `source=reasoning` 行为不丢失；
10. embedding 全不可用仍保持 503；
11. `GET /v1/grep` 行为不变。

### 回归

- 根目录 `npm test`
- 根目录 `npm run build`

本版本不要求把 0.17.0 probe 扩展成完整 hybrid benchmark；该工作按讨论独立推进。

---

## 11. 验收重点

使用真实库至少人工验证以下查询：

### 精确 / 稀有标识符

例如：

```text
no-negative-echo
0.15.0-server-0.2.0-collector-dev
```

预期：

- lexical 通道能召回实际包含相关 trigram 的 session；
- 即使 dense rank 很差/没有进入 dense session candidates，最终 hybrid top-k 仍可出现目标 session。

### 自然语言语义查询

例如：

```text
之前讨论怎么避免 AI 把否定约束写进输出
```

预期：

- dense 优势保留；
- lexical 不应把明显无关的字面重叠 session 大量顶到前面。

### 混合查询

例如：

```text
no-negative-echo 这个约束回显方案
```

预期：

- lexical 提供 identifier 证据；
- dense 提供语义证据；
- 两路都命中的 session 通过 RRF 获得稳定提升。

人工验收记录目标 session 的：

- dense rank
- lexical rank
- fused rank
- matched_by

只作为本版本验收记录，不在 0.21.0 内扩建正式 benchmark 框架。

---

## 12. 风险与取舍

### FTS 索引体积

trigram postings 会比普通 word tokenizer 大。
当前目标规模是个人单用户、十万级 chunks，优先换取跨中文/英文/code/identifier 的稳定 lexical recall。
0.20.0 已提供数据库占用空间展示，可在真实部署中直接观察引入 FTS 后的体积变化。

### Trigram BM25 不是中文语言学分词

接受。
本通道首先解决的是 dense 的字面缺口，不承担全部语义检索职责。

### 短查询

trigram 对 <3 字符无能为力。
dense + 独立 grep 保持现有覆盖。

### 长 session / reasoning 数量偏置

本版不解决。
dense 和 lexical 都仍可能受“更多 chunks = 更多进入候选机会”影响。
下一阶段结合 text/reasoning/tool 分路统一设计。

### Filtered KNN recall

dense 仍是全局 KNN 后 JOIN session filters。
严格的“在过滤集合内做 KNN”另立问题处理，本版不和 hybrid 改造绑定。

---

## 任务清单

- [ ] 新建 `0007_chunk_fts` migration
- [ ] 建 external-content FTS5 trigram 表与同步 triggers
- [ ] 为已有 chunks 执行 FTS rebuild
- [ ] 实现安全 trigram query builder
- [ ] 实现 lexical chunk/session retrieval
- [ ] dense retrieval 重构为 session candidate ranking
- [ ] 实现 session-level RRF
- [ ] 合并/去重 dense + lexical snippets
- [ ] shared search response 增加 hybrid 字段
- [ ] Web 搜索结果适配 hybrid score/channel
- [ ] help 文档同步
- [ ] Session Hub Skill 文档同步
- [ ] migration/query/ranking/filter 回归测试
- [ ] 根目录 `npm test` 全绿
- [ ] 根目录 `npm run build` 全绿
- [ ] 写 `server/develop-doc/0.21.0/summary.md`
- [ ] 提交实现改动

---

## 验收标准

1. `POST /v1/search` 同时使用 dense 与 FTS5 lexical 两路 session ranking，并通过 RRF 返回最终结果。
2. 罕见 identifier / error / path 类 query 可由 lexical 通道补召回，不再完全依赖 embedding。
3. 自然语言语义 query 保留 dense 检索能力。
4. lexical-only 命中的 session 可以进入最终 top-k。
5. 相同 session 在两路中只返回一个融合结果，snippet 去重且能体现命中通道。
6. `GET /v1/grep` 行为保持不变。
7. 升级不要求重新计算 embedding。
8. FTS 与 `message_chunks` 在 upsert/reindex 后保持一致。
9. `npm test` 与 `npm run build` 全部通过。

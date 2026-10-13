# 0.21.0 验收记录

运行方式（worktree 内）：

```text
npx tsx server/develop-doc/0.21.0/acceptance/run.tsx
```

数据集：4 个会话（S1 仅含 identifier `no-negative-echo`；S2 纯中文自然语言讨论"否定约束回显"；
S3 混合两者；S4 无关菜谱）。dense 通道用确定性 hash 向量（无语义意义，仅演示融合数学），
lexical 通道走真实 FTS5 trigram/BM25。

## 查询 1：`no-negative-echo`（精确标识符，14 个 trigram）

| # | session | fused score | matched_by | snippets |
|---|---|---|---|---|
| 1 | S1-identifier-only | 0.03279 | dense,lexical | dense+lexical |
| 2 | S3-mixed | 0.03200 | dense,lexical | dense+lexical |
| 3 | S4-unrelated | 0.01613 | dense | dense |
| 4 | S2-nl-only | 0.01563 | dense | dense |

identifier 会话由 lexical 通道召回并排前，双路命中 fused≈2× 单路，符合 RRF 公式。

## 查询 2：`之前讨论怎么避免 AI 把否定约束写进输出`（自然语言，13 个 trigram）

| # | session | fused score | matched_by |
|---|---|---|---|
| 1 | S2-nl-only | 0.03227 | dense,lexical |
| 2 | S4-unrelated | 0.01639 | dense |
| 3 | S3-mixed | 0.01613 | dense |
| 4 | S1-identifier-only | 0.01563 | dense |

自然语言目标会话双路命中排第一；lexical 未把字面弱重叠的会话顶到前面。

## 查询 3：`no-negative-echo 这个约束回显方案`（混合，20 个 trigram）

| # | session | fused score | matched_by |
|---|---|---|---|
| 1 | S2-nl-only | 0.03202 | dense,lexical |
| 2 | S1-identifier-only | 0.03200 | dense,lexical |
| 3 | S3-mixed | 0.03200 | dense,lexical |
| 4 | S4-unrelated | 0.01639 | dense |

三个相关会话全部双路命中且明显高于无关会话，排序稳定。

## 结论

- lexical 通道可独立召回 identifier / 中文 / 混合文本，trigram 均按 Unicode code point 切分；
- 双路命中分数稳定约为单路两倍，RRF（k=60、等权）数学正确；
- `matched_by` / `distance=null`（lexical-only）语义在结果中表现正确。

生产真实库（WSL2）验收留待部署 0.21.0 后补充：重点观察 §11 的三个真实查询、
FTS 引入后的数据库体积变化（0.20.0 的系统页可直接查看）。

# 0.19.1 按验收反馈完善接口 help 描述

## 需求

0.19.0 L1 help 描述验收通过，但部分端点文案需按验收意见修订（用户反馈）：

1. GET /v1/sessions/:id：不要出现"轻量""仅返回"措辞——该级别的信息一般已够用；
   描述改为"对话视图：返回每条消息的 idx/role/text/ts"。
2. GET /v1/sessions/:id/full："长会话响应可能很大"改为"会话响应会很大"，
   并补充"如无必要请勿直接读取返回的所有内容，建议写脚本按需解析"。
3. POST /v1/search：补充建库与检索执行逻辑（索引内容、切片方式、元数据头、聚合与距离含义），
   让使用者能据此构建搜索词；并给出参数建议（如 top_k 默认 10 偏小，实测建议 20~30）。
4. GET /v1/grep：给出检索内容范围（只扫消息正文，raw/思考不参与）。

## 实测依据（线上库，599 会话 / 23814 消息，qwen3-embedding:8b）

- 相关结果距离 0.46~0.72，其后进入 ~0.78+ 噪声平台期，相关与噪声间断层明显；
  top_k=30 时第 11~30 名（0.79~0.82）对具体查询无增益，模糊查询结果整体发散。
- 首次查询 ~15s（embedding 提供商模型冷启动），预热后 <1s；耗时与库规模基本无关。
- grep"深色模式"仅 2 个会话字面命中，验证语义检索 #1（d=0.459）即正确会话。

## 方案

只改 `routes/help.ts` 内 4 个端点的 summary/description/参数描述文案，不动任何业务逻辑；
`test/help.test.ts:107` 断言 summary 含"仅 idx/role/text/ts"同步去掉"仅"。

## 涉及文件

- `server/apps/server/src/routes/help.ts`
- `server/apps/server/test/help.test.ts`
- `server/package.json`（version 0.19.0 → 0.19.1）

## 任务清单

1. 改 4 个端点 help 文案（含 /v1/search 的 query、top_k 参数描述与 returns 描述）
2. 同步修改 help.test.ts 中"仅 idx/role/text/ts"断言
3. 升 server/package.json version
4. `npm test` + `npm run build` 全绿

## 验收标准

- 4 个端点文案符合验收意见；/v1/search 描述覆盖建库逻辑、检索执行、搜索词构建、参数建议四部分
- `npm test`、`npm run build` 全绿

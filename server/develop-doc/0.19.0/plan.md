# 0.19.0 L1 help 增加 description 详细描述

## 需求描述

用户要求：每个 API 的 help（`?help=1` 的 L1 详情文档）在 `summary`（一句话标题）之外，
再提供一段**更详细的 `description`**，让外部 Agent / 用户不看实现代码就能理解接口语义。
当前 L1 doc 只有 summary + params/returns/example/errors：summary 是单行标题，
承载不了"什么时候选它、行为细节、与其他接口怎么取舍"这类信息。

## 现状（侦察结论）

- `server/apps/server/src/routes/help.ts`：`EndpointHelp` 接口
  （method/path/summary/params/returns/example/errors），`endpoints[]` 注册表共 **14 个端点**；
  `helpInterceptor` 对 `?help=1` 直接序列化整个 doc 对象返回——**新增字段自动随 L1 下发，无需改 interceptor**；
  `listEndpoints()`（L0 `GET /v1/help`）显式投影只含 method/path/summary。
- 消费方：`skills/session-hub/SKILL.md` 第 2 节文档化了两级结构（含 L1 字段清单，需同步）；
  `test/help.test.ts` 断言 L0/L1 结构（新增字段是纯增量，现有断言不受影响）。
- Web 前端不消费 help 数据（无引用），无前端改动；0.18.0/0.18.1 只动了检索页与样式，与本版无交集。
- 各路由语义已核对（description 措辞依据）：
  - `PUT /v1/sessions`：三元组幂等 upsert；已存在则**整会话替换**（消息全量重建、向量作废、
    `deleted_at` 复位）返回 200，新建返回 201；索引异步补齐
  - `DELETE /v1/sessions/:id`：软删除（`deleted_at` 置位）；列表/详情/搜索/grep/统计全部按
    `deleted_at IS NULL` 过滤，立即不可见；同三元组重新上传即恢复
  - `GET /v1/sessions`：除 `title` 为子串包含外，其余过滤字段均为精确匹配
  - `PUT /v1/settings/providers`：整体替换式保存；`apiKey` 留空保留旧密钥；保存后
    `onProvidersSaved → autoIndexer.kick()` 触发后台补索引
  - `POST /v1/settings/reindex`：同步取未索引会话执行**一批**（≤200），返回 indexed/failed/remaining

## 方案

### 决策

- `EndpointHelp` 增加必填字段 `description: string`，置于 `summary` 之后；14 个端点逐一补齐。
- **L0 保持只含 method/path/summary 不变**：L0 是发现层索引，保持轻量；
  详细描述由 hint 引导到 L1 查看。
- description 内容口径：每端点 2~4 句中文，覆盖"做什么、什么时候选它（与其他接口的取舍）、
  关键行为语义与坑"；**不重复** params/returns 已有的字段级说明。

### 逐端点 description 要点

1. `GET /v1/help`：接入起点；返回全部 /v1 端点索引；先发现、再对目标端点 `?help=1` 取详情；自身也支持 `?help=1`。
2. `PUT /v1/sessions`：写入唯一入口；幂等 upsert——同三元组重复上传是**覆盖**（整会话替换，
   非追加），已删除会话同三元组上传即恢复；时间戳取源数据时间；上传成功即返回，向量索引异步。
3. `GET /v1/sessions`：元数据分页列表，不含消息正文；适合浏览/翻页/按来源圈选；
   过滤除 title 子串外均精确匹配；要正文走 `:id` 系列接口。
4. `GET /v1/sessions/:id`：轻量对话视图（仅 idx/role/text/ts）；只看对话流不关心 raw 与元数据时用它；响应体远小于 /full。
5. `GET /v1/sessions/:id/full`：全量详情（会话记录 + 全部消息含 raw 原始结构）；审计/回放原始消息形态用；响应可能很大，先用 full_length 探大小。
6. `GET /v1/sessions/:id/full_length`：只返回 /full 响应体序列化后的 UTF-8 字节数，不含内容；用于决定是否直接拉 /full。
7. `DELETE /v1/sessions/:id`：软删除，所有读路径立即不可见；物理行保留，同三元组重新上传即恢复。
8. `POST /v1/search`：语义检索主入口；在活跃 embedding 模型向量空间对消息切片（正文 + raw 抽取的 reasoning）检索，
   返回会话级结果 + 命中切片，按距离升序；可用 filters 缩小范围；无可用提供商返回 503，此时可退回 /v1/grep。
9. `GET /v1/grep`：关键词字面子串检索（LIKE 扫描），不依赖 embedding；适合精确词（错误码/函数名/路径）；
   `%`/`_`/`\` 按字面；默认仅 ASCII 大小写折叠；结果按会话分组，分页按命中消息行计。
10. `GET /v1/stats`：只读统计总览（会话/消息数、indexed/unindexed 索引进度、按 agent/machine 分布、首末会话时间）；健康巡检看这里。
11. `GET /v1/settings/providers`：读当前提供商链配置（顺序/模型/权重/启用状态/密钥掩码）；只读诊断，修改走 PUT。
12. `PUT /v1/settings/providers`：**整体替换**式保存提供商链（非增量合并）；apiKey 留空保留该提供商旧密钥；
    保存成功自动触发一轮后台补索引（活跃模型变化时全库重建）。
13. `POST /v1/settings/providers/test`：对指定提供商真实调用一次 embeddings 接口验证连通性
    （延迟/维度/模型或错误原因）；保存前验证用，不改变链路状态。
14. `POST /v1/settings/reindex`：同步补索引一批（≤200）未索引会话；返回本轮成功/失败/剩余；
    `remaining > 0` 时可反复调用直到归零；依赖可用 embedding 提供商。

### 文档与测试

- `skills/session-hub/SKILL.md` 第 2 节 L1 响应字段清单补 `description`（保持"接口动态查询、不固化"原则，只同步字段名）。
- `test/help.test.ts`：注册表一致性新增用例"全部端点 description 非空"；L1 详情用例断言 doc 含 description 字段。

## 涉及文件

| 文件 | 动作 |
|---|---|
| `server/package.json` | version 0.18.1 → 0.19.0（已完成） |
| `server/apps/server/src/routes/help.ts` | `EndpointHelp` 加 `description`；14 个端点补详细描述 |
| `server/apps/server/test/help.test.ts` | 新增 description 断言 |
| `skills/session-hub/SKILL.md` | 第 2 节 L1 字段清单补 description |
| 本档 `plan.md` / `summary.md` | 规划 / 完成记录 |

## 任务清单

1. `help.ts`：接口加字段 + 14 条 description（按上述要点成文）
2. `help.test.ts`：全端点 description 非空用例 + L1 断言
3. `SKILL.md` 第 2 节同步
4. 根目录 `npm test` + `npm run build` 全绿，写 summary.md，提交

## 验收标准

- 任意 /v1 端点 `?help=1` 返回的文档含非空 `description`，与 summary、params/returns 互补不重复。
- L0 `GET /v1/help` 响应结构不变（仍只有 method/path/summary）。
- 根目录 `npm test` + `npm run build` 全绿。

## 非目标

- L0 索引不加 description（保持轻量）
- 不做 OpenAPI/Swagger 导出、不引入文档生成框架
- 不改任何业务路由行为、无 DB 迁移

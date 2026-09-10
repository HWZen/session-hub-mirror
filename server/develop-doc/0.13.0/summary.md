# 0.13.0 会话详情接口拆分：实际改动记录

## 实际改动

- `packages/shared/src/api.ts`：新增 `SessionMessagesResponse { messages }`、`SessionFullLengthResponse { full_length }`；/full 复用既有 `SessionDetail`
- `server/apps/server/src/db/sessions.ts`：新增 `getMessages(id)`（存在性 + 软删除校验 → 仅查 messages 按 idx 升序）；消息行映射抽为模块级 `mapMessageRows`，`get()` 复用，行为不变
- `server/apps/server/src/routes/sessions.ts`：
  - `GET /:id` → `{ messages }`（null → 404），响应体不含任何元数据字段
  - `GET /:id/full` → 原 SessionDetail 逻辑原样迁移
  - `GET /:id/full_length` → `{ full_length: Buffer.byteLength(JSON.stringify(detail)) }`
- `server/apps/server/src/routes/help.ts`：`:id` summary 改为"仅 messages"；新增 `/full`、`/full_length` 两条端点元数据
- `server/apps/web/src/lib/api.ts`：`getSession(id)` 改调 `/v1/sessions/:id/full`；`session-detail.tsx` 零改动
- 根 `plan.md` §7：`:id` 行改为"对话消息（仅 messages）"，新增 `/full`、`/full_length` 两行
- `skills/session-hub/SKILL.md`：接口列表同步三条
- 测试：
  - `sessions.test.ts`：既有 detail 断言改走 `/full`（2 处）；"unknown detail 404"扩为三接口；新增 `session detail split (0.13.0)` 组 4 例（仅 messages 无元数据 / full 完整结构 / full_length 与 /full 响应体字节数严格相等（含中文样本验证 UTF-8）/ 不存在与软删除均 404）
  - `help.test.ts`：L0 索引含三条路径；新增拆分端点 `?help=1` 命中且不与 `:id` 误匹配用例；`findEndpoint` 断言扩为三段路径

## 与计划的偏差

- 无实质性偏差。计划中"抽小函数或直接复制同款映射"采用了抽 `mapMessageRows` 方案
- 开发中发现 worktree 依赖不完整（node_modules 仅含 workspace 链接，此前靠目录树向上借用主工作区依赖；`@vitejs/plugin-react` 嵌套在主工作区 `server/apps/web/node_modules` 导致 web 构建失败）。修复方式：完整复制主工作区根 `node_modules` 与 `server/apps/web/node_modules` 到 worktree（绕开 better-sqlite3 原生编译，直接复用已构建产物）。属环境问题，不影响本版本代码

## 测试 / 验收结果

- `npm test`：24 文件 190 用例全绿（新增 8 例：sessions 4 + help 2 扩展 + 2 处既有改造）
- `npm run build`：tsc -b + 三插件 typecheck + web 构建（tsr generate / tsc / vite）全绿
- 验收标准逐条核对：
  - `/:id` 返回 `{ messages }` 且仅此一个键 ✓（`Object.keys(body)` 断言）
  - `/full` 返回完整 SessionDetail，与 0.12.0 行为一致（原断言原样迁移）✓
  - `/full_length` = `Buffer.byteLength(JSON.stringify(full))` ✓（样本含中文，覆盖 UTF-8 多字节）
  - 三接口对不存在 / 软删除均 404 ✓
  - `?help=1` 可发现三端点且文档准确 ✓
  - Web 详情页零回退（内部改走 /full，数据结构不变）✓

## 遗留事项

- messages 分页/裁剪、full_length 的 DB 存储字节口径或缓存：维持非目标，按需后续立项
- worktree 依赖补全方式为复制主工作区产物；若主工作区依赖升级，需重新复制或解决 better-sqlite3 编译环境（node-gyp 缺 Python）

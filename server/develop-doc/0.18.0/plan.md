# 0.18.0 检索页筛选补全

## 需求描述

Web 检索页（`/search`）的语义与关键词两种模式当前只暴露 **Agent、Machine** 两个过滤，且 Agent 取值硬编码、Machine 只能回显当前值无法切换。而后端早已支持完整过滤集：

- `POST /v1/search` 的 `filters` 走 `sessionFilterSchema`（`packages/shared/src/session.ts:26-41`）：`agent` / `machine` / `source_id` / `title` / `created_from` / `created_to` / `updated_from` / `updated_to`。
- `GET /v1/grep` 走 `grepRequestSchema`（`session.ts:52-57`），同样复用 `buildSessionFilter`。

即：**检索页少了一大截筛选，后端能力已经就绪，缺口纯在前端**。本版把检索页过滤补到与后端对齐，语义/关键词共用同一套过滤表单。

## 现状（侦察结论，基于 0.16.0 master）

- `server/apps/web/src/routes/search.tsx`：
  - `validateSearch` 只解析 `q` / `mode` / `top_k` / `agent` / `machine`。
  - `submit()` → `navigateWith({ q, top_k, agent, machine })`；`switchMode` 透传 `agent`/`machine`。
  - 语义分支 `api.search({ query, top_k, filters: { agent, machine } })`；关键词分支 `api.grep({ q, limit, agent, machine })`。
  - Agent `<Select>` 硬编码 `opencode` / `workbuddy` / `doubao`；Machine `<Select>` 仅当 URL 有值时才渲染一个当前项 `<option>`（切换不了，只能整体清除）。
  - 「清除过滤」只在已提交时出现，且只清 `agent` / `machine`。
  - 过滤以 URL 为事实源：`queryKey` 用 `search.agent` / `search.machine`，改选择不 submit 不重跑。
- 后端过滤链路（无需改动）：
  - `routes/search.ts:43` 把 `parsed.data.filters` 原样传给 `searchSessions`；`db/search.ts:49` 经 `buildSessionFilter` 生效（KNN 后 JOIN sessions 过滤）。
  - `routes/grep.ts` 收集 `PARAM_KEYS` 后走 `grepRequestSchema`，`db/grep.ts` 复用 `buildSessionFilter`。
  - `help.ts:196` / `help.ts:224-229` 已文档化这些过滤参数。
- `lib/api.ts` 类型已含全部字段：`SessionSearchBody.filters`（`api.ts:42-49`）、`GrepParams`（`api.ts:65-78`）；`buildQuery` 会跳过 `undefined` 与空串。
- `/v1/stats` 返回 `by_agent` / `by_machine`，`session-list.tsx:102,118` 已用它动态填下拉——检索页可直接复用同一数据源。
- 时间过滤：`sessionFilterSchema` 的 time 值接受毫秒数或可解析日期串；会话列表页用 `<input type="date">` → `new Date(\`${d}T00:00:00\`).getTime()` 作 `created_from`（`session-list.tsx:28`）。
- 测试基建：根 `vitest.config.ts` include 覆盖 `server/apps/**/*.test.ts`，但 `environment: "node"`、无 jsdom/RTL，Web 组件当前无测试。纯 TS 函数可直接被该配置覆盖。
- 构建：根 `npm run build` 末尾含 `npm run build -w @session-hub/web`（`tsr generate && tsc --noEmit && vite build`）。

## 方案

### 1. 过滤维度（与后端 `sessionFilterSchema` 对齐）

| 维度 | 控件 | 参数 | 生效模式 |
|---|---|---|---|
| Agent | Select（`/v1/stats` by_agent） | `agent` | 语义 + 关键词 |
| Machine | Select（by_machine） | `machine` | 语义 + 关键词 |
| 标题 | 文本（子串） | `title` | 语义 + 关键词 |
| 来源会话 ID | 文本（精确） | `source_id` | 语义 + 关键词 |
| 创建时间 | `date` from / to | `created_from` / `created_to` | 语义 + 关键词 |
| 更新时间 | `date` from / to | `updated_from` / `updated_to` | 语义 + 关键词 |

日期边界：`from` = 当日 `T00:00:00.000`，`to` = 当日 `T23:59:59.999`（**本地时区**），转毫秒数提交。

### 2. 新增 `server/apps/web/src/lib/search-filters.ts`（纯函数）

- `dateToMs(date: string, edge: "start" | "end"): number | undefined`：空串返回 `undefined`；按本地日边界转毫秒。
- `toApiFilters(input): SessionFilters`：把表单值映射为 `@session-hub/shared` 的 `SessionFilters`（空值剔除）。
- `toSearchParams(input): Record<string, string | number | undefined>`：映射为 URL search 参数（日期保持 `YYYY-MM-DD` 字符串）。
- `hasAnyFilter(input): boolean`：是否有任一过滤生效（供「清除筛选」按钮显隐）。
- **约束**：不 import `@/`（根 vitest 未配 `@` 别名），只用相对路径与 `@session-hub/shared`，保证纯函数可在 node 环境单测。

### 3. `routes/search.tsx` 改造

- `validateSearch` 增 `title` / `source_id` / `created_from` / `created_to` / `updated_from` / `updated_to`（`YYYY-MM-DD` 字符串，空忽略）。
- 本地 state 同步 URL：新增上述 6 项 state，初值取 `Route.useSearch()`。
- 动态下拉：`useQuery(["stats"], api.stats)` 取 `by_agent` / `by_machine` 填充 Agent/Machine（保留「全部 Agent」「全部机器」空选项）。
- 布局：保留「模式切换 + Top + Agent + Machine」行；新增一行 `flex-wrap` 放 标题 / source_id / 创建 from–to / 更新 from–to / 清除筛选，控件沿用 `Input`/`Select` 的 `h-8 text-xs` 小尺寸（与 session-list 一致），窄屏自动换行。
- 取值/联动：
  - `submit()` 一次性写入 q + 全部过滤（沿用「点检索生效」）。
  - 已有查询（`search.q` 非空）时：下拉/日期变更**立即** `navigate`（保留 q）重跑；文本类（title/source_id）在提交/回车时生效，避免逐字抖动。
  - `switchMode` 透传全部过滤；`queryKey` 纳入全部过滤值。
  - 「清除筛选」：重置全部过滤 state 并 `navigate` 去掉过滤参数（保留 `q` / `mode` / `top_k`）；仅当 `hasAnyFilter` 为真时显示。
- `queryFn`：
  - 语义：`api.search({ query, top_k, filters: toApiFilters(input) })`。
  - 关键词：`api.grep({ q, limit, ...toSearchParams(input) })`（含 `source_id`/`title`/四个时间）。
- 结果区、文案、距离 Badge 等不变。

### 4. 文档

- 根 `plan.md`：无全局决策变化（过滤是既有只读能力，Web 对齐不改 API 契约），**不改**。
- `help.ts` / `SKILL.md`：无 API/响应变化，**不改**。
- 本档 `plan.md` / `summary.md`。

### 明确出界

- 不改后端路由 / zod schema / 响应结构。
- 不加 `cwd` 过滤（`sessionFilterSchema` 与列表接口均无 `cwd`）。
- 不做组合条件（AND/OR）、筛选方案保存、检索结果分页。
- 不引入 jsdom/RTL 或 Web 组件测试基建。

## 涉及文件

- `server/package.json`：0.16.0 → 0.18.0（规划阶段已完成）
- `server/apps/web/src/routes/search.tsx`（主要）
- `server/apps/web/src/lib/search-filters.ts`（新，纯函数）
- `server/apps/web/src/lib/search-filters.test.ts`（新，node 纯函数单测）
- 本档 `plan.md` / `summary.md`

## 任务清单

1. 建 worktree `.worktrees/0.18.0-server-dev` + 分支 `0.18.0-server-dev`、`server/package.json` 升 0.18.0、拷贝 `.env`（PORT=7429）/ `providers.local.json` / DB。（规划阶段已完成）
2. 新增 `lib/search-filters.ts` + `search-filters.test.ts`（日期边界、空值剔除、URL 参数映射）。
3. 改 `routes/search.tsx`：`validateSearch` / state / 动态下拉 / 表单行 / 联动 / `queryFn` / `queryKey` / 清除筛选。
4. 本地联调（worktree 起服务 + `SH_API_PORT` dev:web）：语义与关键词各过滤组合生效，URL 可复现。
5. `npm test` + `npm run build` 全绿。
6. 写 `summary.md`；提交（中文，只含本版本文件）。

## 验收标准

- 检索页提供 `agent` / `machine` / `source_id` / `title` / `created_from` / `created_to` / `updated_from` / `updated_to` 全部 8 维过滤，语义与关键词模式一致生效。
- Agent / Machine 下拉选项来自 `/v1/stats`（`by_agent` / `by_machine`），不再硬编码、不再只能回显。
- 过滤条件写入 URL，刷新/分享可复现；「清除筛选」一键清空且只在有过滤时出现。
- 日期过滤按本地日边界（from 00:00:00.000、to 23:59:59.999）转毫秒。
- 新增纯函数单测通过；根目录 `npm test` + `npm run build` 全绿。

## 风险与未知

| 风险 / 未知 | 处置 |
|---|---|
| 过滤变多使表单拥挤 | `flex-wrap` 两行布局 + `h-8` 小控件；实测过挤再折叠为「更多筛选」 |
| 语义 KNN 候选池（`k = min(topK*50, 1024)`）被过滤后命中变少 | 后端既有行为（非本版引入）；联调确认可接受，必要时在 summary 记录 |
| 过滤即时联动导致请求频繁 | 下拉/日期即时，文本类仅提交/回车时生效 |
| 纯函数测试踩到 `@` 别名 | `search-filters.ts` 不 import `@/`，只用相对路径与 `@session-hub/shared` |
| 前端无既有测试，新增用例需自证 node 环境可跑 | 先跑 `npm test` 确认根 vitest 能 include `server/apps/web/**/*.test.ts` |

## 非目标

- 后端过滤能力 / 契约变更；`cwd` 过滤
- 检索结果分页 / 排序 / 组合条件逻辑
- Web 组件级测试基建（jsdom / testing-library）

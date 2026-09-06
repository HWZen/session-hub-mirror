# 0.11.0 Summary — 关键词 grep 检索（LIKE 子串）

## 实际改动

- 根 `plan.md`：§3"查询能力"补关键词子串检索、§7 API 草案表补 `GET /v1/grep`（规划阶段完成）
- `server/package.json`：version 0.10.0 → 0.11.0（规划阶段完成）
- `packages/shared/src/session.ts`：`sessionFilterSchema` 增可选 `title`；新增 `grepRequestSchema`（`q` 1..256 必填、`case_sensitive`、`limit` 1..200、`offset` ≥0，filters 复用 `sessionFilterSchema`，数字/布尔查询参数按 string|number 联合类型转换）；新增 `GrepSnippet` / `GrepHit` / `GrepResponse` 类型
- `server/apps/server/src/db/grep.ts`（新）：`grepMessages`——不敏感模式 LIKE 过滤（`escapeLike` 转义 `\` `%` `_` + `ESCAPE '\'`）+ `instr(lower(m.text), lower(?))` 定位；敏感模式过滤与定位均用 `instr(m.text, ?)` 原样；JOIN sessions 复用 `buildSessionFilter`；`ORDER BY s.updated_at DESC, s.id, m.idx`；LIMIT/OFFSET 按命中消息行计，`COUNT(*)` 同条件得 total；JS 按会话分组、每会话最多 5 条片段；片段 ≤500 字符窗口（命中前保留约 120 字符），`match_start` 为命中在片段内偏移
- `server/apps/server/src/db/sessions.ts`：`buildSessionFilter` 增 `title` LIKE 条件；LIKE 转义抽为共享导出 `escapeLike`
- `server/apps/server/src/routes/grep.ts`（新）+ `app.ts`：`GET /v1/grep` 挂载于 `/v1/search` 旁，自动获得 bearerAuth + helpInterceptor；query 参数收集后 zod 校验，400 带 issues
- `server/apps/server/src/routes/help.ts`：`endpoints` 登记 `GET /v1/grep`（queryParams 从 schema 生成）；`GET /v1/sessions` 参数表补 `title` 描述
- `server/apps/server/src/routes/sessions.ts`：`FILTER_KEYS` 增 `title`
- Web `lib/api.ts`：`grep()` 方法 + `GrepParams`；`buildQuery` 泛化接受任意对象（支持布尔参数）；`SessionListParams` 增 `source_id`/`title`
- Web `routes/search.tsx`：URL 增 `mode`（semantic | keyword）；表单加语义/关键词分段切换按钮；queryFn 按 mode 分派 `api.search` / `api.grep` 并归一化为统一结果结构（按 kind 守卫 placeholder 数据）；结果卡复用——关键词模式隐藏距离 Badge 与提供商摘要行；页头/占位符/空态文案按模式切换
- Web `routes/sessions/-components/session-list.tsx`：过滤行加标题过滤输入框（300ms 防抖，`col-span-2`）
- `skills/session-hub/SKILL.md`：补"关键词检索（grep 式子串匹配）"示例小节；语义搜索小节的 filters 说明补 `title`
- 测试：`test/grep.test.ts`（新，12 用例）、`test/sessions.test.ts` 增补标题过滤用例（含 LIKE 通配符字面匹配）

## 与计划的偏差及原因

1. **敏感模式（`case_sensitive=1`）的过滤条件用 `instr(m.text, ?) > 0` 而非 LIKE**：SQLite LIKE 默认 ASCII 大小写不敏感，敏感模式需 `PRAGMA case_sensitive_like`（连接级、会污染共享 DB 模块的统一配置），故过滤与定位都用 `instr` 原样。不敏感模式仍按计划：LIKE 过滤 + `instr(lower(...), lower(...))` 定位。
2. **命中定位在 SQL 侧求值（SELECT 列 `AS match_at`），不在 JS**：JS `toLowerCase()` 折叠域比 SQLite `lower()`（仅 ASCII）宽，非 ASCII 大小写对（如 Ä/ä）会得到与 LIKE 语义不一致的偏移；SQL 侧与过滤同域。注意随之而来的绑定顺序：SELECT 中的 `?` 在 SQL 文本上先于 WHERE 的 `?`，`q` 须排在参数表首位。
3. **开发中修复两处路由遗漏**（由新增测试暴露）：`routes/sessions.ts` 的 `FILTER_KEYS` 漏 `title`（title 过滤全不生效）、`routes/grep.ts` 的 `PARAM_KEYS` 漏 `limit`/`offset`（参数被静默丢弃、非法值不报 400）。
4. **检索页顺带修复一个既有渲染问题**：query 失败分支被"placeholder 数据 kind 守卫"的 `!data` 分支遮蔽，语义检索 503 时永远显示加载态；调整条件顺序让 error 优先。属同页同一处逻辑，未单列版本。
5. **环境事项**：worktree 内 `npm install` 会对 better-sqlite3 触发 node-gyp 源码编译（npm 对含 `binding.gyp` 的包默认 rebuild），本机 Python 损坏导致失败并破坏半成品 node_modules。better-sqlite3 v13 自带 prebuilds 且无 install 脚本，`npm ci --ignore-scripts` 安装后 `better-sqlite3` / `sqlite-vec` 直接可用。后续 worktree 初始化遇同问题可照此处理。

## 测试 / 验收结果

- `npm test`：19 文件 / 139 用例全部通过（新增 grep 12 例 + sessions 标题过滤 1 例）✅
- `npm run build`：全绿（tsc -b + 两个插件 typecheck + web vite build）✅
- 本地起真实服务冒烟（无 embedding 提供商配置）：`PUT /v1/sessions` 201 → `GET /v1/grep` 中文子串命中且 `match_start` 正确；`q=100%_`、`%`、`\` 字面匹配；`title` 过滤组合与排除；`?help=1` 参数表含 `q`（required）/`case_sensitive`/`limit`；对照 `POST /v1/search` 返回 503（grep 不依赖 embedding）✅
- 浏览器实测（vite dev + 代理到冒烟服务）：检索页语义/关键词切换，页头、输入占位符、空态文案随模式变化；关键词模式返回"命中 N 个会话 · N 条命中消息"且无距离 Badge；语义模式失败正确显示错误卡；会话列表标题过滤生效（"登录"保留、不匹配标题进空态）✅
- 验收标准逐条核对：子串命中分组/片段、通配符字面、大小写两模式、过滤组合、软删除排除、分页 limit/offset 与 total 语义、无 embedding 依赖、Web 两处交互、`npm test`/`npm run build` 全绿 —— 均满足 ✅

## 遗留事项

- 前端命中高亮渲染未做（计划内非目标，`match_start` 已预留）
- FTS5 升级路径（数据量上涨后，接口不变）留待后续
- AGENTS.md 的 worktree 初始化一节未写 `npm ci --ignore-scripts` 的环境提示（见偏差 5），是否补进文档由用户决定

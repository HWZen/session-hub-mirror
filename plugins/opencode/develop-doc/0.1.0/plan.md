# 0.1.0 — opencode 插件：实时采集 + 历史回填（P2）

> 全局决策见根 `plan.md`；本档是其 §8 P2 的实施计划。删除镜像属"镜像语义"决策的细化，不推翻全局决策。

## 需求描述

把 opencode 会话接入 Session Hub：

1. **实时采集**：opencode 运行期间，会话每轮对话结束即同步到服务端（准实时，全量快照）
2. **删除镜像**：本地删除会话 → 服务端对应记录删除
3. **历史回填**：把本机存量 opencode 会话（当前 123 个）一次性补传

已确认的三个决策（2026-09-05）：
- 删除镜像纳入本期（服务端列表过滤加 `source_id`，见 `server/develop-doc/0.4.0/`）
- 索引 text 口径：只留对话正文，工具产出/推理等全量进 `raw` 不进索引
- 分发方式：构建单文件拷入 `~/.config/opencode/plugins/`，不做 npm 包

## 侦察事实（2026-09-05，机器 WORKSTATION-A 实测）

### opencode 本地 DB
- 路径 `~/.local/share/opencode/opencode.db`，**3.6GB**——986MB 是 opencode 自身 `event` 表 + 大量空闲页，业务表很小（part 53MB / message 23MB）⇒ **回填必须只读直连，禁止整库拷贝**
- 运行中也可 `readonly: true` 直连（已实测）
- `session` 列：`id, project_id, parent_id, slug, directory, title, version, ..., time_created, time_updated(ms), ..., agent, model, ...`
  - `parent_id` 非空 = 子 agent 会话（本机 14 个），照常同步（全量存）
  - `agent` 列是 opencode 模式名（build/plan），**与我们数据模型的 agent 维度无关**
- `message` 列：`id, session_id, time_created, time_updated, data(JSON)`；`data.role` 仅 `user(526)/assistant(3554)`；`data.time.created`(ms)
- `part` 列：`id, message_id, session_id, time_created, time_updated, data(JSON)`
- part `data.type` 全景：`text 2184 / tool 4248 / reasoning 2703 / step-start 3539 / step-finish 3504 / patch 439 / file 24 / compaction 5`
- `text` part 有 `synthetic: boolean` 标记（注入上下文，全库 32 条）；真实用户输入 = 不带该标记的 text part
- `tool` part 结构：`data.state.{status, input, output, metadata, title, time}`

### opencode 插件系统（官方文档 2026-09-05）
- TS 插件导出 `async ({ project, client, $, directory, worktree }) => ({ hooks })`
- `event` 钩子收所有事件：`session.idle`（每轮对话结束）、`session.deleted` 等
- `client.session.get()` / `client.session.messages()` 返回 `{info, parts}` 结构，可与 DB 等价取数
- 全局插件目录 `~/.config/opencode/plugins/` 直接加载 TS/JS 单文件（Bun 运行时，类型擦除执行）；零运行时 import 即单文件可用
- 日志：`client.app.log({ body: { service, level, message } })`

### 服务端现状（0.3.0）
- `PUT /v1/sessions` 幂等 upsert（键 `agent+machine+source_id`），payload 见 `packages/shared/src/session.ts`
- 列表过滤无 `source_id`；DELETE 只认服务端 UUID ⇒ 本期 server 0.4.0 补 `source_id` 过滤

## 方案

### 总体

```
opencode(Bun) 内插件 plugin.ts
  event 钩子 ─ session.idle ── debounce(~3s) ── client.session.get/messages
             │                                    │ 变换（共享 transform）
             │                                    ▼
             └ session.deleted ── GET ?source_id → DELETE    PUT /v1/sessions ──► Session Hub 服务端

backfill.ts（tsx，仓库内直跑）── better-sqlite3 readonly 直连 opencode.db ── 同一 transform ──► 同上
```

- 每次上传**全量快照**：upsert 幂等，失败仅记日志、下轮 idle 自愈 ⇒ 插件零本地状态、无重试队列
- 插件 async fire-and-forget，绝不阻塞 opencode

### 变换口径（核心，测试锚点）

| 目标字段 | 来源 |
|---|---|
| `agent` | 常量 `"opencode"` |
| `machine` | `os.hostname()` |
| `source_id` | `session.id` |
| `title` | `session.title`（可空） |
| `cwd` | `session.directory` |
| `created_at` / `updated_at` | `session.time_created` / `time_updated`（ms，源时间） |
| 每条 opencode message → MessageInput | `role = info.role`；`ts = info.time?.created`；`text` = 该消息内**非 synthetic** 的 `type === "text"` parts 的 text 以 `\n\n` 连接（reasoning/tool/step-*/patch/file/compaction 一律不进 text）；`raw` = 该消息全部 parts 的 JSON 数组（全量原文，含工具产出 state.output） |

防御性规则（SDK 类型演进快，按宽防御实现）：
- 单条 `text` >1MB 截断（尾部加省略标记）；消息数 >5000 截断保留最近 5000
- 未知 part 类型跳过不报错；parts 非数组/字段缺失容错

### 插件配置

- 文件 `~/.config/session-hub/config.json`：`{ "baseUrl": "...", "token": "...", "timeoutMs?": 15000 }`
- 环境变量 `SESSION_HUB_URL` / `SESSION_HUB_TOKEN` 覆盖文件值
- 未配置或缺失 token ⇒ 插件不注册钩子，`client.app.log` 提示一次即停用
- 日志只记元数据与统计，禁止打印会话正文（全局安全约束）

### 分发与安装

- `src/plugin.ts` 单文件自包含（仅 type-only import `@opencode-ai/plugin`），tsc 擦除类型后零依赖
- 根脚本 `install:plugin`：拷贝到 `~/.config/opencode/plugins/session-hub.js`
- 回填脚本共用 `plugin.ts` 内导出的 transform/upload（type-only 链，tsx 直跑无碍）

### 回填脚本 `src/backfill.ts`

- better-sqlite3 `readonly: true` 直连（默认 `~/.local/share/opencode/opencode.db`，`--db` 可改）——不拷贝、不写源库
- 按 session → message → part 组装成与 SDK 等价结构，走同一 transform + upload
- 参数：`--url --token --db --since <ms> --dry-run`；输出仅统计（各阶段成功/失败计数）
- 子 agent 会话（parent_id 非空）一并回填；重复执行幂等

## 涉及文件

```
plugins/opencode/
  package.json          # @session-hub/opencode-plugin，version 0.1.0（本档新增）
  tsconfig.json         # 独立 typecheck（不进 tsc -b；root build 链显式调用）
  develop-doc/0.1.0/    # 本档
  src/plugin.ts         # 入口 + config + transform + upload + sync（单文件）
  src/backfill.ts       # 回填脚本
  test/transform.test.ts
  test/upload.test.ts   # 本地 Hono stub 断言请求头/路径/payload
  test/backfill.test.ts # fixture sqlite 库 → 组装与变换断言
根 package.json         # build 链加插件 typecheck；新增 install:plugin
vitest.config.ts        # include 加 plugins/**/*.test.ts
packages/shared/src/session.ts        # sessionFilterSchema 加 source_id（server 0.4.0）
server/...（见 server/develop-doc/0.4.0/plan.md）
```

## 任务清单

- [ ] server 0.4.0：`source_id` 过滤 + 测试（先行，插件删除镜像依赖它）
- [ ] 插件骨架：package.json / tsconfig / 根编排接线
- [ ] transform + 单测（synthetic 过滤、类型路由、截断防御）
- [ ] upload + 单测（stub server）
- [ ] plugin 入口：config 加载、event 钩子、debounce、删除镜像
- [ ] backfill + 单测（fixture db）
- [ ] install:plugin 脚本 + 真机安装
- [ ] 联调验收 + summary.md

## 验收标准

1. 根 `npm test` + `npm run build` 全绿（含插件 typecheck）
2. 配置后启动 opencode 新会话 → 服务端 `GET /v1/sessions?agent=opencode` 可见；text 无 synthetic 注入；`raw` 含工具产出原文；轮次推进后 updated_at 前进
3. 本地删除该会话 → 服务端记录消失
4. 回填 `--dry-run` 输出统计；实跑后 opencode 会话数 ≈ 123（含子 agent），重跑幂等（total 不变）
5. `POST /v1/search` 以最近会话中的关键词能命中
6. 全程日志无会话正文

## 风险与对策

| 风险 | 对策 |
|---|---|
| opencode SDK/事件字段随版本演进 | 宽防御变换（未知类型跳过、缺字段容错），联调时以实机为准 |
| `session.idle` 事件属性名与预期不符（文档未列全） | 开发期先打点确认 `properties` 结构，再写死映射 |
| 单会话消息/文本超服务端上限（5000 条 / 1MB 条） | 插件侧截断 + 统计日志，不阻断上传 |
| 回填期间 opencode 正在写库 | readonly 直连已验证可行；如遇锁冲突重试该会话 |
| token 落盘明文 | 与服务端 .env 同级风险，私人部署可接受；文件在用户目录不入库 |

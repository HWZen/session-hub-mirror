# 0.1.0 — DSH Cordis 会话采集钩子

> 全局边界与决策见根 `plan.md`。本版新增 DSH 信息源，不修改服务端 API、数据库或索引语义。
> 插件版本事实源为 `plugins/dsh/package.json`，当前版本 `0.1.0`；版本线工作区为 `.worktrees/0.1.x-dsh-plugin-dev`。

## 需求描述

把当前 DSH profile 中由持久化后端保存的普通会话、fork 会话和 subagent 会话上传到 Session Hub：

1. 每个持久回合完成后准实时全量 upsert，DSH 对话或 Session Hub 网络失败时互不阻塞。
2. DSH Host 启动时对持久会话做可恢复的历史补传，实时与补传共用同一读取、转换和串行上传路径。
3. 全量保留 DSH 的持久 `SessionEvent`，只把用户/助手对话正文和明文 reasoning 放入可索引字段；工具及控制事件只保存在 `raw`。
4. 仅调用现有 `PUT /v1/sessions`，不修改服务端。DSH 当前 JSONL persistence 没有删除/保留接口且不会删除会话文件，因此本版没有可验证的源删除信号可镜像；archive 不等于删除，不调用 Session Hub DELETE。若 DSH 后续提供持久删除信号，再单独规划 PATCH 跟随全局删除策略。
5. 通过 DSH 官方 Cordis bundle 安装、禁用和移除，不直接修改 profile 文件。

## 侦察事实（2026-10-08，本机安装版静态源码核对）

### 官方插件与安装机制

- DSH 的持久扩展是 Cordis bundle。Host-only bundle 的 `package.json` 声明 `dsh.bundle.patch` 和 `exports["."]`，`cordis.patch.yml` 插入插件行；入口导出 `apply(ctx, config)`，资源通过 `ctx.on` / `ctx.effect` 注册并随 fiber 卸载清理。
- 开发产物应位于普通工作区，通过 `plugin_manager install_bundle` 安装到当前 profile。禁止手改 profile 的 `package.json`、`cordis.patch.yml` 或在 profile 内运行包管理器。
- `ctx.on` 属于当前 fiber，卸载时自动移除。普通 `session/event` 是观察通知，不等待监听器返回的 Promise，因此监听器必须同步置 dirty/入队，异步任务自行捕获错误，不能把失败传播给 DSH 会话。
- Host 动态包在 VM 沙箱中运行：没有 Node `require`、`process`、全局 `fetch` 和 Node timers。安装版源码进一步确认 `ctx.web.fetch()` 是 GET-only 页面抓取 seam，不能发送 `PUT /v1/sessions`。上传必须声明 `inject = ["sessions", "sessionPersistence", "subprocess", "timer"]`：通过 `ctx.subprocess.resolveExecutable("node")` 与 `spawn()` 启动 `node -e` sidecar，完整配置/payload 只经 stdin 传入，由 sidecar 使用 Node fetch；重试延时使用 Cordis timer。具体 service 方法和 Event mode仍以当前安装版静态源码与 `cordis_inspect_query` 双重核对。

依据（安装版 ASAR 静态源码，仅用于侦察，不入库）：

- `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:6-14,28-38`
- `.../references/host-plugin.md:1-27,47-60`
- `@deepseek-ai/cordis/src/events.ts:90-97,277-301`
- `@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.js:51-80`
- `@deepseek-ai/dsh-web/lib/index.js:88-116` 与 `dsh-web-fetch-http/lib/index.js`（fetch provider 固定 GET）
- `@deepseek-ai/dsh-subprocess/README.zh.md:28-53,78-84`（resolveExecutable/spawn/stdin/collected output）
- `@deepseek-ai/cordis-plugin-timer/README.md:24-33`（`ctx.timeout(delay): Promise<void>` 与 disposer-aware callback overload）

### 会话生命周期与权威读取路径

- DSH 会话是 append-only `SessionEvent` 日志，事件信封包含 `type`、连续 `seq`、源 `time` 和 `data`。核心词汇包括 `user/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`turn/start`、`turn/end`、`session/title`、subagent/team/todo/goal 等事件。
- `session/event(session, event)` 在事件写入内存日志后同步通知；持久化后端异步缓冲，收到事件不等于磁盘已刷新。`ctx.sessions.flush(session)` 是唯一受支持的 awaitable 持久屏障，会等待所有 `session/flush` listener。
- 权威正文必须经 `ctx.sessionPersistence.open(id, "read")` 与 `handle.read()` 读取。当前 JSONL 后端默认 Zstandard 压缩、支持多 generation 迁移与崩溃尾部恢复；不得直读/解析物理 `.jsonl.zstd` 文件。
- read handle 不取得写所有权，可与活动写 handle 并存；用后必须 close。header 提供稳定 `id`、`createdAt`、`cwd`、parent/subagent 等来源信息；`createdAt` 与事件 `time` 都是由 `Date.now()` 产生的 Unix epoch 毫秒安全整数，最后事件 `time` 是 `updated_at` 的来源。
- `session/event` listener 只同步更新 dirty/requiredSeq，不能在该调用栈中进入 flush。listener 返回后通过 `Promise.resolve().then(...)` 建立明确的 microtask dispatch 边界，再唤醒 runner；runner 执行时才先 `await ctx.sessions.flush(session)`，再 open/read 当前完整快照，并核对读到的末尾 seq 不早于触发 `turn/end`。这避免重入 observer dispatch，也避免观察通知早于持久化造成缺尾。

依据：

- `@deepseek-ai/dsh-session/lib/types/index.js:526-615,997-1028`
- `@deepseek-ai/dsh-session/lib/types/known-event-types.js:21-81`
- `@deepseek-ai/dsh-session-persistence/README.zh.md:28-57,81-103`
- `@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:28-82`

### Session Hub 契约与已知限制

- 复用 `PUT /v1/sessions`：`agent="dsh"`、`machine=<插件必填配置>`、`source_id=<DSH session id>`；幂等键为三元组。`created_at=header.createdAt`，`updated_at=最后一条持久事件.time`（空日志回退 `createdAt`），二者按 Unix epoch 毫秒原样传递并校验为非负安全整数，绝不用上传时间；`cwd=header.cwd`，title 取最后一个有效 `session/title` 投影，找不到时使用稳定兜底标题。
- 服务端 upsert 是整会话替换，且不拒绝较旧的 `updated_at`。因此实时触发、启动补传和失败重试必须进入同一个 per-session single-flight 队列；锁覆盖“取得序列权 → flush（活动会话）→ 读取最新快照 → transform → 上传”。不允许预先排队旧 payload。
- `messages` 最多 5000 条、单条 `text` 最多 1,000,000 字符。插件不得截掉旧消息或伪装成功；超限会话应拒绝上传、只记录会话 id/计数/限制类型，并保持 dirty，等待后续服务端契约升级或人工处置。
- 日志只允许 session id、事件数、耗时、HTTP 状态和错误类别，不得记录正文、raw、token 或 Authorization。

依据：

- `packages/shared/src/session.ts:3-19`
- `server/apps/server/src/db/sessions.ts:135-169`
- `server/apps/server/src/indexing/raw-extract.ts:1-39`

## 方案

### 数据流与并发模型

```text
Host apply
  ├─ startup reconciliation: sessionPersistence.list() → 每个 id 标 dirty
  └─ ctx.on("session/event")
       └─ event.type ∈ {"turn/end", "session/title"} → 只同步记录 {session, requiredSeq}
            → listener 返回后经 Promise microtask 唤醒/合并 per-session runner

per-session runner（当前 observer dispatch 已结束；同一 id 永远 single-flight）
  ├─ 若 session 当前 live：await ctx.sessions.flush(session)
  ├─ sessionPersistence.open(id, "read") → handle.read() → handle.close()
  ├─ 校验末尾 seq >= requiredSeq；否则保留 dirty 并经 Cordis timer 重试
  ├─ transform 当前最新完整快照（此时才生成 payload）
  ├─ subprocess sidecar：node -e <由 TypeScript uploaderMain.toString() 生成的固定代码>，stdin 写入 config JSON + 换行 + raw payload JSON；Host 按 UTF-8 byteLength 限制 payload 为 16 MiB
  │    └─ sidecar fetch PUT /v1/sessions；stdout 只回 {ok,status}，stderr 禁止正文/token
  └─ 若执行期间又到达更大 requiredSeq，立即再循环；否则清 dirty
```

- 启动补传与实时事件在同一 Host 进程、同一队列内完成，不提供另一个读取数据库的独立 CLI，避免跨进程旧快照覆盖新快照。
- listener 内不得直接调用 async runner；`turn/end` 保证正文按轮次上传，`session/title` 额外触发保证回合外的标题变化不会滞留。测试必须断言 listener 返回前 flush spy 尚未调用、microtask 边界后才按 `flush → open/read → transform → upload` 执行。
- 启动补传从 `sessionPersistence.list()` 获取 ids；list 暂时失败时复用同一个 Cordis timer scheduler，按 250/1000/4000 ms 有限重试 3 次。成功后每 id 限制并发（默认 2，可配置 1–4），但同一 id 仍严格串行。冷会话无需激活 Agent，直接只读 open。
- 活动会话才调用 `ctx.sessions.flush(session)`；冷会话直接读取已经持久化的快照。开发时通过 inspection 确认 `ctx.sessions.get(id)` 的返回语义。
- 网络失败采用有限退避并保持 dirty；不阻塞/抛错到 DSH。插件卸载时停止接受新任务并取消 timer，不把正文写入临时文件。下一次 Host 启动的 reconciliation 负责最终补偿。

### 事件到 Session Hub 的映射

1. 按 `seq` 保持原始顺序，拒绝不连续或 envelope 非法的快照。
2. 以持久的 surface message 事件形成 Session Hub message；不同 event envelope 必须显式分支，禁止用一个猜测路径取 message：
   - `user/message`：message 就是 `event.data` → `role="user"`
   - `assistant/message`：message 是 `event.data.message` → `role="assistant"`，外围 `event.data.stream` / usage / settlement 仍完整保留在 raw
   - `developer/message` / `system/message`：message 是 `event.data.message` → 保留对应 role
   - `tool/result`：message 是 `event.data.message` → `role="tool"`，`text` 留空；外围 error/meta 与完整 result 保留在 raw
   - `tool/call`：不是 message-bearing envelope，不单独取 message；按原始控制事件附着到 raw
3. `text` 只拼接上述 message content 中明确的用户/助手可见 text block；附件和图片不转写为文本。fixture 必须分别覆盖 `event.data` 和 `event.data.message` 两种 envelope，防止正文静默漏采。
4. 每条消息的 `ts` 使用该源事件 `time`。所有相邻控制事件、工具调用、attempt stream、团队/子代理/目标/todo 等原始事件均无损附着到相邻消息的 `raw`；开头或结尾没有相邻消息的事件放入合成 `role="event"`、空 text 的 message。不得丢弃未知但合法且 `ignorable` 的事件。
5. 助手明文 reasoning 从 `assistant/message` / `assistant/attempt` 的已持久 provider stream 中抽取。每段统一生成 raw 顶层数组项 `{type:"reasoning", text}`；完整 DSH 原始事件另以 `{type:"dsh-event", event}` 保存。加密、摘要占位或无明文时不生成 reasoning part。安装版静态源码 `@deepseek-ai/dsh-llm/lib/index.js:964-1004` 的 stream chunks 为 `{type:"block-start",index,blockType}`、`{type:"reasoning-delta",index,text}`、`{type:"block-end",index,block}`；assembler 在 `1020-1030` 生成 `{type:"reasoning",text}`。其 durable `AssistantStreamAccumulator.snapshot()` 在 `1150-1248` 将增量压为 `{type:"reasoning-chunks",time0,index,dt,texts}`，并将 block-start/end 保存为 `{type:"chunk",time,chunk}`。decoder 遍历 snapshot records、校验 packed record 的 index/texts、解包 chunk；delta 可无 block-start，reasoning block-end 的完整 text 覆盖同 index 累积 delta。回归 fixture `test/fixtures/dsh-llm-provider-reasoning.fixture.ts` 覆盖 durable packed+wrapped、delta-only/interrupted、block-end override 与未封装 raw chunks。以上仅依据安装版静态源码和合成 fixture，未读取私人会话内容。
6. fork/subagent 是独立 DSH session id，分别 upsert；其 parent/origin/descriptor 只保存在 raw，不拼接父子会话，也不新造服务端字段。
7. title、cwd、created/updated 均来自源 header/event，不使用上传时间；machine 由插件 Config 显式提供，因为沙箱没有 `os.hostname()`。

### 配置与安全

Cordis `Config` 至少包含：

- `baseUrl`：仅允许 `http:` / `https:`，去掉末尾 `/`
- `token`：必填，只写入 profile 的本地配置，不写 package patch、仓库、日志或测试快照
- `machine`：必填，稳定主机名
- `timeoutMs`：默认 15000
- `workerCwd`：必填绝对路径，仅作为 subprocess 的显式 cwd（sidecar 使用 `node -e`，不依赖该目录中的代码）
- `reconcileOnStart`：默认 true
- `concurrency`：默认 2，范围 1–4

默认 bundle patch 只放非敏感默认值并保持插件 disabled 或缺少必填配置时 fail-open、不注册采集 listener。安装器不复制 token、不编辑 profile 文件；安装后由用户通过 DSH Plugin Manager 配置并启用。卸载/禁用后 listener、timer 与队列都释放，DSH 会话功能不受影响。

## 目录与涉及文件

```text
plugins/dsh/
  package.json
  tsconfig.json
  cordis.patch.yml
  locale/{zh,en}.json
  src/
    index.ts             # apply、Config、listener、生命周期
    queue.ts             # per-session single-flight、dirty/retry/reconciliation
    reader.ts            # persistence list/open/read/close 与快照检查
    transform.ts         # SessionEvent → Session Hub payload 纯函数
    upload.ts            # ctx.subprocess adapter、16 MiB payload limit 与结果分类
    uploader-sidecar.ts  # node -e 固定代码的自包含 TypeScript 主体
  test/
    fixtures/dsh-llm-provider-reasoning.fixture.ts
    transform.test.ts
    queue.test.ts
    reader.test.ts
    upload.test.ts
    index.test.ts
    bundle.test.ts
  scripts/build.mjs
  dist/index.js          # esbuild 生成的单文件 ESM Host 入口（gitignored）
  develop-doc/0.1.0/{plan.md,summary.md}
```

- 插件 `package.json` 固定 `type: "module"`、`exports["."]="./dist/index.js"`、`dsh.bundle.patch="./cordis.patch.yml"`；`files` 必须覆盖 `dist/index.js`、patch 与 locale。安装前先 build，再把 `plugins/dsh` 绝对目录交给 `plugin_manager install_bundle`，不得把 TypeScript 源文件直接作为运行入口。
- 根 `package.json`：build 链加入 DSH 插件 typecheck/build（以最终交付形态为准）。
- 根 `plan.md`：新增 DSH 信息源与侦察事实（规划阶段已更新）。
- 根 `AGENTS.md`：开发完成时补 `plugins/dsh` 及 DSH raw 规则速查。
- 不改：`server/**`、`packages/shared/**`、其他插件。

## 任务清单

- [ ] 用安装版静态源码 fixture 与 `cordis_inspect_query` 固化 `sessions`、`sessionPersistence`、`subprocess`、`timer` 的精确 API 和 `session/event` dispatch mode；同时核验 `plugin_manager` 的 `set_bundle` 禁用与 `remove_bundle` 移除参数。若与本计划假设冲突，先修订计划，不猜 API。
- [x] 建立 Host-only bundle、Config、locale、TypeScript 构建与根 npm 编排；`exports["."]` 指向实际 `dist/index.js`，构建产物不得依赖 Node globals/require/fetch。
- [x] 实现 reader 与 source fixture：live flush、cold read、handle close、连续 seq、requiredSeq 检查。
- [x] 实现 transform：事件顺序、角色、可见 text、完整 raw、tool、title、时间戳、fork/subagent、reasoning 归一化、上限显式失败。
- [x] 实现 per-session single-flight queue、启动 reconciliation、有限并发和 Cordis timer 重试；覆盖实时/补传竞态，确保旧快照不能最后覆盖新快照。
- [x] 实现 subprocess 上传 adapter：`resolveExecutable("node")` 后以 `src/uploader-sidecar.ts` 自包含 TypeScript `uploaderMain()` 生成 `node -e` 代码；Host 对 payload 单次 `JSON.stringify` 并用 `TextEncoder` 校验 16 MiB 上限，stdin 以 config JSON + 换行 + 原始 payload JSON 传输，argv/env 不含秘密；bounded stdout/stderr，只解析 sidecar 状态 JSON；覆盖 Bearer、超时、失败协议、2xx 判断、非零退出、超限与错误分类，日志脱敏且 fail-open。
- [ ] 使用 `plugin_manager install_bundle` 安装并读取 application/warnings；通过 inspection 确认插件和 listener 已激活，不手改 profile。
- [ ] 真机验证普通会话续轮、fork、subagent、工具调用及有明文 reasoning 的模型；再验证重启补传，并用 inspection 核验后的 `set_bundle` 禁用、`remove_bundle` 移除流程验证 cleanup。
- [x] 根目录 `npm test` 与 `npm run build` 全绿；写 `summary.md` 并提交本版本文件。

## 验收标准

1. 根目录 `npm test`、`npm run build` 全绿；`plugins/dsh` 单测覆盖纯 transform、reader、queue、HTTP adapter 和 bundle manifest。
2. DSH 正常完成一轮后 30 秒内出现 `agent="dsh"` 会话；续轮仍是同一 `agent+machine+source_id`，服务端总会话数不增加，`updated_at` 与消息数前进。
3. 真机抽查服务端 `/full`：用户/助手正文、工具与控制事件、顺序、source timestamps 与 DSH persistence snapshot 一致；工具正文不进入 message text。
4. 使用含明文 reasoning 的 fixture/真机会话，`raw` 顶层出现 `{type:"reasoning", text}` 且搜索片段 source 可为 reasoning；无明文时不伪造。
5. 单测断言 `session/event` listener 返回前没有调用 flush；microtask dispatch 边界之后才进入 `flush → open/read → transform → upload`。在旧 snapshot 上传被延迟时触发新一轮，最终服务端必须是较新的 seq/updated_at；启动补传与实时同时发生也不得回滚。
6. subprocess fixture 断言 argv/env 不含 token、payload 或正文，stdin 以 config JSON + 换行 + 原始 payload JSON 携带请求；生成的 TypeScript sidecar 代码可 `new Function` 解析且错误时只输出状态协议。模拟 HTTP 失败/超时/非零退出、read/flush 失败和插件未配置时，DSH 回合正常结束，错误日志不含正文/token，恢复网络或重启后 reconciliation 能补传。
7. 5001 条 surface message、单条 text 超限或 serialized raw payload 超过 16 MiB 时，不截断、不上传部分 payload；payload 超限抛 nonretryable `payload_too_large`，queue 保留 dirty 并 parked，日志仅含 id 与错误类别。
8. `plugin_manager install_bundle` 返回 applied（或明确记录 restart-required 后重启验证），inspection 可见已注册 listener；按 inspection 确认的 `set_bundle` 禁用和 `remove_bundle` 移除操作后，listener/timer 消失且 DSH 对话正常。
9. fork 与 subagent 各自以稳定 source_id 成为独立会话，重复 reconciliation 不产生重复记录。
10. 验证 archive 不触发 Session Hub DELETE；当前 DSH persistence 没有持久删除信号，计划记录该能力边界，不把“未出现在一次 list”误判为删除。

## 风险与计划内对策

- **DSH API 随版本变化**：开发第一步运行 inspection 并以 fixture 锁定；只使用公开 Cordis service，不导入 DSH 内部包或解析物理文件。
- **flush 与 hook 时序**：不在并行的 `session/flush` listener 中读取；turn/end 后由异步 runner 主动 `ctx.sessions.flush(session)`，再 read 并校验 requiredSeq。
- **旧请求覆盖新请求**：payload 只在取得 per-session 序列权后从最新 snapshot 生成；执行期间的新 seq 置 dirty 并循环。
- **沙箱缺少 Node/通用 HTTP 能力**：上传走注入的 subprocess + 固定 Node sidecar，timer 走 Cordis service；token/payload 只走 stdin，sidecar 不打印响应正文；machine/workerCwd 由 Config 提供。构建后必须在实际 DSH Host runtime 加载验证，不以 typecheck 代替。
- **schema 无法承载超大会话**：0.1.0 显式失败且不丢数据；不通过截断、拆 source_id 或静默部分成功改变会话语义。若真实数据触发，再单独规划服务端契约升级。
- **reasoning provider stream 多形态**：仅抽取已证明为明文的类型，原 stream 始终保存在 raw；未知/加密形态跳过索引并由测试记录。

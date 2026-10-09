# 0.1.1 — DSH 插件可配置性修复（PATCH）

> 版本线：`.worktrees/0.1.x-dsh-plugin-dev`（同一 MINOR 线，不新建分支）。
> 插件版本事实源：`plugins/dsh/package.json` → 本版 `0.1.1`。
> 上游依据：`develop-doc/0.1.0/acceptance.md`（2026-10-09 首次真机安装验收）与根 `plan.md` 的 DSH 段。

## 背景：0.1.0 的配置假设与实机不符（代码问题，不是"没填配置"）

2026-10-09 真机验收结论：bundle 安装 `applied`、条目 `fiberPhase=active`，但**DSH 0.2.0-rc.2 没有任何界面能填写该插件的 Config**，因此插件停在"已启用未配置 → fail-open 不注册 listener"。证据：

1. `cordis_inspect_query host/Config listConfigs {entry:"include:session-hub-dsh"}` → `status:"unsupported"`（对照 `include:llm-pi-ai` → `status:"schema"`）。
   根因：`@deepseek-ai/dsh-app-boot` 的 `isNativeConfigSchema()` 要求 `Symbol.for("schemastery")` 标记 + `type`/`meta`；0.1.0 导出的是 **zod** `Config`。
2. client `plugins.row.config` 的 `occupants = []`——插件页的行只有在**插件自带 client 半**注册 `key = "<包名>#<rowId>"` 时才出现「配置 …」按钮；本插件是 Host-only。
3. `settings.plugins.tab` 现存唯一贡献 `id=all` 来自 `dsh-client-ui-settings-plugin-inventory`（自述 "Read-only Host plugin inventory"）；`dsh-settings` README：表单只展示 **volatile** 字段，且 `autoGenerate` "没有已发布的客户端"消费。
4. `dsh plugin --profile <profile>` 只把参数转发给 pnpm（包管理），**没有**配置编辑子命令；`dsh` 根命令只有 `web` / `plugin`。
5. `@deepseek-ai/dsh-client-ui-cordis` 是动态定义（`cordis_define`/`cordis_run`）面板，不是配置编辑器。

→ 0.1.0 plan「安装后由用户通过 DSH Plugin Manager 配置并启用」不可执行。本版把"配置从哪来"改成不依赖 DSH UI 的路径。

## 需求

让插件**装上并启用即可工作**，不要求任何 DSH 界面或 profile 手工编辑：

1. `baseUrl` / `token` / `machine` 未在 Cordis Config 中给出时，从本机共享配置 `~/.config/session-hub/config.json` 读取（与 opencode / zcode / hermes 插件同源同文件）。
2. `machine` 两级兜底之外，再用一次性 node sidecar 取 `os.hostname()`，使同一台机器上与其他 Source 的 `machine` 天然一致。
3. `workerCwd` 改为可选（缺省不传 cwd），不再阻塞激活。
4. 配置仍可由 Cordis Config 显式覆盖（供未来 profile patch 或 UI 使用），优先级最高。
5. 缺配置时保持 fail-open：DSH 对话不受影响，日志只记错误类别、不含秘密。

## 侦察事实（本机安装版，2026-10-09）

- Host 服务目录中 `fs` 可用：`resolve(path, {cwd}) → FsTarget`、`readText(target, signal?) → string`、`stat`、`listDir` 等（`cordis_inspect_query host/Service listService` 实测）。
- 宿主沙箱自述（`@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.js`）：Node 的 `require`/`fetch`/timers 被 trap 掉，并明确把文件、网络、进程、定时器分别指向 `ctx.fs` / `ctx.web` / `ctx.bash` / Cordis timer——`inject: ["fs"]` 是被认可的取文件方式。
- `subprocess`（`resolveExecutable` / `spawn` 带 stdin/stdout 捕获）已在 0.1.0 使用且真机加载成功，可作文件读取与 hostname 探测的兜底通道。
- 服务端 `by_machine = {WORKSTATION-B: 548, WORKSTATION-A: 201}`，本机既有来源都用 `WORKSTATION-B`。

## 方案

### 配置解析链（新 `src/shared-config.ts`）

对每个字段独立解析，先到先用：

| 字段 | 来源顺序 | 缺省行为 |
|---|---|---|
| `baseUrl` | Cordis Config → 共享配置 `baseUrl` | 无则视为未配置 |
| `token` | Cordis Config → 共享配置 `token` | 无则视为未配置 |
| `machine` | Cordis Config → 共享配置 `machine` → 一次性 node sidecar `os.hostname()` | 全失败则视为未配置 |
| `timeoutMs` | Cordis Config | 15000 |
| `reconcileOnStart` | Cordis Config | true |
| `concurrency` | Cordis Config | 2，范围 1–4 |
| `workerCwd` | Cordis Config，可选 | 不传 cwd（用 subprocess 默认）；给了必须是绝对路径 |

- 共享配置路径固定 `~/.config/session-hub/config.json`（`os.homedir()` 语义）；文件不存在、JSON 非法、字段类型不对都只降级不报错。
- 三个必填项（`baseUrl`/`token`/`machine`）缺任一个 → 不注册 listener，仍打一行 `dsh-session-hub: inactive category=configuration_required`。
- 解析在 `apply()` 里异步完成；解析完成前不注册采集 listener（不产生半启用状态）。

### 读取通道（两级）

1. 首选 `ctx.fs`：`resolve(path)` + `readText(target)`，`inject` 增加 `"fs"`。
2. 兜底：一次性 `node -e` sidecar（复用 `subprocess` seam）读同一路径并把 JSON 打到 stdout；stdin 传路径，不在 argv/env 放任何秘密，输出只解析结构、不落日志。
3. `machine` 的 hostname 探测同样走 sidecar（`process.stdout.write(require("node:os").hostname())`），成功后在进程内缓存，不重复 spawn。

### 安全

- token 只存在于内存与 sidecar stdin；**不写** profile patch、仓库、日志、测试快照。
- 失败日志只含错误类别与字段名，不含取值。
- 共享配置文件读取是唯一新增的外部数据源，路径固定、不外泄。

## 涉及文件

```text
plugins/dsh/
  package.json                        # 0.1.0 → 0.1.1
  cordis.patch.yml                    # 默认值调整：去掉必填语义，保留 timeoutMs/reconcileOnStart/concurrency 默认
  src/config.ts                       # 拆成「显式 Config 校验」与「最终解析结果」两部分
  src/shared-config.ts                # 新增：共享配置文件读取、字段解析链、hostname 缓存
  src/sidecar.ts                      # 新增：一次性 node sidecar（读文件 / 取 hostname）的自包含源码
  src/index.ts                        # apply 改为异步解析后再注册 listener/queue；inject 增加 fs
  src/types.ts                        # 增加 DshFsService 接口
  test/shared-config.test.ts          # 新增：优先级、缺项、坏 JSON、无文件、hostname 失败
  test/index.test.ts                  # 调整：未配置 → 不注册；配置齐 → 注册
  develop-doc/0.1.1/{plan.md,summary.md}
plan.md                               # DSH 段补一条「配置来源」事实
```

不改：`server/**`、`packages/shared/**`、其他插件、根 `package.json`。

## 任务清单

- [ ] **真机确认读取通道**：写最小探针（或先落 `shared-config.ts`）验证 `ctx.fs` 能否读到 `C:\Users\<user>\.config\session-hub\config.json`；能否注入 `fs`；不行则确认 sidecar 兜底路径可用。任一结论先记录再继续。
- [ ] 实现 `shared-config.ts`：文件读取（fs → sidecar）、三字段解析链、hostname 缓存、错误分类。
- [ ] `config.ts` 拆分：显式 Config 只做类型/范围校验；`workerCwd` 可选且仍校验绝对路径。
- [ ] `index.ts`：`apply` 异步解析后再注册；缺项 fail-open；`inject` 增加 `fs`；卸载路径不变。
- [ ] `cordis.patch.yml` 默认值同步（不引入秘密）。
- [ ] 单测覆盖：Config 优先、共享配置回落、hostname 兜底、坏 JSON/缺文件/缺字段、fail-open、绝对路径校验。
- [ ] 根 `npm test` + `npm run build` 全绿。
- [ ] 真机：`install_bundle` 安装 → 启用 → **不做任何 DSH 配置**，确认自动激活并跑完 `0.1.0/acceptance.md` 4.1–4.7（续轮幂等、重启回填不重复、工具只进 `raw`、reasoning 可搜、fork/subagent 独立会话、禁用后停止上传）。
- [ ] 写 `summary.md`（含与计划的偏差）并提交本版文件（中文提交信息）。

## 验收标准

1. profile 的 `cordis.patch.yml` **不含**任何 baseUrl/token/machine 的前提下：启用插件后 30 秒内 `GET /v1/sessions?agent=dsh` 出现会话，`machine` = 本机既有来源一致的 `WORKSTATION-B`。
2. 同一会话续轮：Hub 会话总数不变、消息数增加、`updated_at` 前进。
3. 重启 DSH：`reconcileOnStart` 回填历史会话且不产生重复（`agent+machine+source_id` 唯一）。
4. 无共享配置/无 hostname 时：不注册 listener、无上传、DSH 对话正常，日志只有类别。
5. Cordis Config 显式值覆盖共享配置（单测 + 真机各一）。
6. 工具调用内容只出现在消息 `raw`；明文 reasoning 以 `{type:"reasoning", text}` 进入 `raw` 且可被 reasoning 检索命中；fork 与 subagent 各自独立会话。
7. 禁用插件后继续对话：不再上传，DSH 正常。
8. 根 `npm test`、`npm run build` 全绿；`install_bundle` 结果 `applied` 且 `list_plugins` 无 activation failure。

## 风险与对策

- **`ctx.fs` 读用户主目录可能被沙箱策略拒绝**：任务清单第 1 条先做真机确认；兜底为一次性 node sidecar（`subprocess` 已在用，必然可用）。
- **hostname 探测依赖 `subprocess.resolveExecutable("node")`**：失败时降级为"需要共享配置显式给 `machine`"，仍可工作。
- **与 0.1.0 plan"token 只写入 profile 的本地配置"的表述冲突**：本版把 token 来源改为本机共享配置（同样不入库、不进日志），需在根 `plan.md` DSH 段记录，避免后续按旧表述实现。
- **异步解析改变激活时序**：解析失败/慢时不得阻塞 DSH 会话；listener 注册必须发生在解析成功之后，卸载时仍释放 queue/timer。

## 本版不做（记为 0.1.2 候选）

- DSH 原生配置面：`Config` 换原生 schemastery Schema（`status:"schema"`）+ 补 client 半注册 `plugins.row.config`（key `@session-hub/dsh-plugin#session-hub-dsh`）→ 插件页"配置"按钮 + 表单。工作量与风险独立，单独一轮规划。
- 每轮增量上传（当前整会话全量 upsert 语义保持不变）。

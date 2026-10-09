# 0.1.1 完成记录 — DSH 插件配置来源改为不依赖 DSH UI

> 版本线：`.worktrees/0.1.x-dsh-plugin-dev`（PATCH，未新建分支/worktree）。
> 计划依据：`develop-doc/0.1.1/plan.md`；问题背景：`develop-doc/0.1.0/acceptance.md`。
> 插件版本事实源：`plugins/dsh/package.json` → `0.1.1`。

## 1. 实际改动

| 文件 | 改动 |
|---|---|
| `src/config.ts` | `Config` 三字段（`baseUrl`/`token`/`machine`）由"必填"改为可选；`workerCwd` 可选；新增 `parseExplicitConfig()` 只做类型/范围校验与规范化（非法显式值 → `configuration_invalid`，空串视为缺省）；`normalizeBaseUrl` 改为导出 |
| `src/shared-config.ts` | 新增。共享配置路径解析（`resolveSharedConfigPath(home)`）、`~/.config/session-hub/config.json` 读取（`ctx.fs` 优先、一次性 node sidecar 兜底）、`parseSharedConfigText()` 逐字段容错、`createMemoizedProbe()`（成功才缓存、并发合并）、`resolveDerivedWorkerCwd()`、`resolvePluginConfig()` 三字段独立解析链 |
| `src/sidecar.ts` | 新增。自包含 `node -e` 探针（`hostname` / `home` / `read-text`），请求只走 stdin、输出只回结构 JSON（`{ok,text}` 或 `{ok:false,category}`），失败分类为 `sidecar_start` / `sidecar_exit` / `sidecar_output` |
| `src/index.ts` | `inject` 增加 `"fs"`；`apply()` 先同步注册 cleanup effect（标记 disposed），再异步 `activate()` 解析配置；解析成功且未被卸载才注册 listener/queue；缺项日志 `inactive category=configuration_required`（非法显式值 = `configuration_invalid`），共享配置降级只记类别；`workerCwd` 缺省时用派生默认目录，派生失败才完全省略 cwd |
| `src/types.ts` | `DshSubprocessService.spawn` 的 `cwd` 改为可选；新增 `DshFsTarget` / `DshFsService`（`resolve` / `processPath` / `readText`） |
| `src/upload.ts` | spawn spec 仅在 `workerCwd` 存在时带 `cwd` |
| `test/config.test.ts` | 重写：显式字段保留与空白处理、缺省可空、非法 baseUrl/相对 workerCwd/越界调优值、URL 规范化 |
| `test/shared-config.test.ts` | 新增 22 例：逐字段优先级、共享配置短路（显式齐全时不读文件）、坏 JSON/非对象/字段类型错/非法 URL、hostname 兜底与缓存、`ctx.fs` 优先与绝对路径、sidecar 兜底、两通道皆失败、reader/probe 抛错仍 fail-open |
| `test/sidecar.test.ts` | 新增 8 例：真跑生成的 `node -e` 代码（hostname / 读文件 / 读不到 / 未知 op），`runSidecar` 的 stdin 传参、不传 cwd、协议严格性、失败分类、产物不含 `__require` |
| `test/index.test.ts` | 适配异步激活（`vi.waitFor`）；未配置 → 不注册 listener；解析期间被卸载 → 不注册；既有 listener/queue 用例保持不变 |
| `test/upload.test.ts` | 直接用 `DshPluginConfig` 字面量；新增"未配置 workerCwd 时 spawn spec 不含 cwd" |
| `test/bundle.test.ts` | 版本断言 0.1.1；新增"bundle patch 不含 baseUrl/machine/URL"断言 |
| `cordis.patch.yml` | **未改动**：其中只有 `timeoutMs` / `reconcileOnStart` / `concurrency` 三个非敏感默认值，与新语义一致；不写入任何 baseUrl/token/machine |

### 配置解析链（最终形态）

| 字段 | 顺序 | 缺省 |
|---|---|---|
| `baseUrl` | Cordis Config → 共享配置 `baseUrl` | 视为未配置 |
| `token` | Cordis Config → 共享配置 `token` | 视为未配置 |
| `machine` | Cordis Config → 共享配置 `machine` → 一次性 sidecar `os.hostname()` | 视为未配置 |
| `timeoutMs` / `reconcileOnStart` / `concurrency` | Cordis Config（默认 15000 / true / 2） | — |
| `workerCwd` | Cordis Config（必须绝对路径） | 派生默认目录（见偏差 2） |

- 三项齐全前不注册 listener；缺项日志只有类别（`configuration_required` / `shared_config_unreadable` / `shared_config_invalid_json` / `shared_config_invalid_field:<name>`），不含任何取值。
- 显式 Config 三项齐全时不读共享配置（短路，少一次 fs/sidecar 动作）。
- `baseUrl`/`token` 缺失时提前返回，不再触发 hostname 探测（避免无谓 spawn）。

### 读取通道（两级 + 绝对路径修正）

1. `probeHome`（一次性 sidecar `op:"home"`，成功后进程内缓存）→ `resolveSharedConfigPath(home)` 拼出绝对路径（如 `C:\Users\<user>/.config/session-hub/config.json`）。
2. 绝对路径交给 `ctx.fs.resolve(path)` + `readText(target)` —— token 只落在 Host 内存。
3. 仅当 home 探测失败或 `ctx.fs` 读取失败时，才退回一次性 node sidecar（stdin 传路径；home 未知时用 `~/…` + `expandHome: true`）。

## 2. 与计划的偏差及原因

1. **`~` 不能直接给 `ctx.fs`**（计划原文写"路径固定 `~/.config/…`"）。安装版 `@deepseek-ai/dsh-fs-local/lib/index.js:155-156` 对非绝对路径按 `process.cwd()` 拼接、不展开 `~`，直接 resolve 必然 ENOENT。改为先用 sidecar 取 home 拼绝对路径再走 `ctx.fs`（Lead 评审指出并给出证据）。`SHARED_CONFIG_PATH` 保留为文档/兜底用的可移植写法。
2. **`workerCwd` 缺省时并非完全不传 cwd**（计划原文"缺省不传给 subprocess"）。宿主契约 `SubprocessSpawnSpec.cwd` 是必填（`@deepseek-ai/dsh-subprocess`：`cwd: string`，"this seam applies no defaults"，且 cwd 非法会在创建句柄前同步抛错）。因此缺省时按「`ctx.fs.processPath(resolve("."))` → sidecar home」派生一个已存在的绝对目录；两者都失败才省略 `cwd`（`spawn` spec 中不带该键）。真机若仍报 `worker_start`，下一步应改为直接省略/改用显式 `workerCwd`。
3. **`apply()` 无条件注册一个 cleanup effect**（计划只说"解析成功前不注册采集 listener"）。异步解析期间若 fiber 被卸载，需要一个已登记的 effect 才能感知并阻止随后注册 listener/queue；未配置时该 effect 为空操作，不采集、不上传。
4. **`src/sidecar.ts` 增加 `home` op**（计划只列"读文件 / 取 hostname"）。偏差 2 需要一个可用的默认 cwd 来源，复用同一探针；ops 相互独立、各自缓存。
5. **`resolvePluginConfig()` 增加防御性 try/catch**：reader/probe 自身抛错时也降级为 `configuration_required`，不把异常抛回 Cordis。

## 3. 测试与验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 插件类型检查 | `npx tsc -p plugins/dsh/tsconfig.json --noEmit` | 通过（exit 0，无输出） |
| 插件单测（9 文件 81 例） | 见下方"沙箱受限说明"的替代运行方式 | **81 passed / 0 failed**（其中 `sidecar.test.ts` 10 例） |
| 插件构建 | `node node_modules/esbuild/bin/esbuild plugins/dsh/src/index.ts --bundle --format=esm --platform=node --target=node20 --packages=bundle --outfile=plugins/dsh/dist/index.js`（与 `scripts/build.mjs` 同参数） | 成功，`dist/index.js` 743.0 kB |
| 构建产物自检 | `.verify/dist-check.mjs`（临时脚本，已删除） | exports `Config,apply,inject`；`inject=["sessions","sessionPersistence","subprocess","timer","fs"]`；产物无 `__require`；保留 `import("node:os")`；从产物里抽出的 `sidecarMain` 实跑返回 `{"ok":true,"text":"WORKSTATION-B"}` |
| 官方 `npm run build`（Lead 复跑） | worktree 根 | **退出码 0，全绿** |
| 官方 `npm test`（Lead 复跑） | worktree 根，47 文件 / 337 例 | 首轮 **2 例失败**（均在 `sidecar.test.ts`，见下）；修复后本地 shim 81/81，**官方 337/337 待 Lead 复跑确认** |
| 官方 `npm test` / `npm run build`（本会话沙箱内） | worktree 根 | `Error: spawn EPERM`（vitest 加载 `vitest.config.ts` 时 esbuild 服务子进程被沙箱拦截；build 前序 typecheck 全过、卡在 dsh 插件构建）。仅记录，未改任何配置 |

### 首轮官方 `npm test` 的 2 例失败与修复（shim 未暴露，官方 vitest 才是权威判据）

- 现象：`generated sidecar code > answers a hostname probe…` 断言 `parsed.ok === true` 实为 `false`；`…reads a text file handed over on stdin` 实为 `{"ok":false,"category":"sidecar_failed"}`。
- 根因：这两例用 `new Function("return " + SIDECAR_CODE)()` 在**当前进程内**求值生成代码，而 0.1.1 的探针用 `await import("node:os")` / `await import("node:fs")`（为避开 esbuild 把 `require` 改写成 `__require`）；vitest 的模块运行器里，`new Function` 造出来的代码**没有动态 import 回调** → 抛错 → 被自己的 catch 归为 `sidecar_failed`。**生产路径无 bug**：Lead 用 `'{"op":"hostname"}' | node -e "<生成代码>"` 实测返回 `{"ok":true,"text":"WORKSTATION-B"}`、`home` 返回 `C:\Users\example-user`。
- 修复（只改测试，未动生产代码的 import 策略）：删掉 `new Function` 求值，行为用例改为 `import { sidecarMain } from "../src/sidecar.js"` + `vi.spyOn(process, "stdin", "get")`（喂 async generator）+ `vi.spyOn(process.stdout, "write")`，直接对同一份源码断言 hostname / home / read-text / 错误分类；保留静态断言（`new Function` 可解析、自包含、含 `node:os`/`node:fs`、不含 `__require` / `console.` / `process.stderr`）。
- 未采用"真实子进程跑生成代码"（Lead 的首选 A）：本会话沙箱下 `execFileSync(process.execPath, …, {input})` 与 `spawnSync` 实测均 `EPERM`（已复现），本地无法验证该写法；且真实 `node -e` 契约已由 Lead 实测确认。若需补 A，可在能启动子进程的环境外加。
- 顺带加固：`~` 展开用例改为 "文件存在则断言读取成功且长度一致、否则断言 fail-open 分类"，且**不比较也不打印文件正文**（该文件含 token，避免失败时把密钥打进测试输出）。

### 沙箱受限说明（如实记录，未改测试配置绕过）

本会话的文件沙箱禁止 Node 以管道 stdio 创建子进程（`child_process.spawn` 默认 `stdio:'pipe'` 直接 `EPERM`）。esbuild 的 JS API（`ensureServiceIsRunning`）和 vite/vitest 的配置打包都走这条路径，因此官方 `npm test` / `npm run build` 在本沙箱内无法启动；只有 esbuild 原生 CLI（bin shim 用 `execFileSync(..., {stdio:'inherit'})`）可用。**没有修改 `vitest.config.ts`、`scripts/build.mjs` 或任何测试配置**。

替代验证方式（临时目录 `plugins/dsh/.verify/`，验证后已删除，未入库）：用一个最小 `describe/it/expect/vi` 兼容层（`--alias:vitest=…`）把**仓库里真实的 9 个 `*.test.ts`** 用 esbuild CLI 打包后逐个 `node` 执行，结果如上表（81/81）。该方式与官方 vitest 的求值环境不同（首选轮已证明），**只作本地回归证据，最终判定以官方 `npm test` 为准**。

## 4. `ctx.fs` 可见性结论

- **未做真机探针**（Lead 已从安装版文档确认读取通道可行，真机验证由 Lead 在重启 DSH 后执行）。依据：`@deepseek-ai/dsh-fs-sandbox/README.zh.md` —— 该沙箱只限制模型对文件的**写入/编辑**，"读取、列出、元数据操作与只读监听均与 `fs-local` 完全一致；变更围栏不限制观察"；即 `ctx.fs.readText` 读 `C:\Users\<user>\.config\session-hub\config.json` 不在围栏内。
- 契约侧已按 `cordis_inspect_query host/Service listService{service:"fs"}` 实测签名实现：`resolve(path, {cwd?}) → Promise<FsTarget>`、`readText(target, signal?) → Promise<string>`、`processPath(target) → string`（本次 Host 确实注册了 `fs` 服务，`inject` 增加 `"fs"` 不会导致插件整体不激活）。
- 仍保留 `ctx.fs === undefined` / 方法缺失 / 抛错时的 sidecar 降级分支，并有单测。
- **待真机确认两点**：① `ctx.fs` 能否读到用户主目录（预期能，见上）；② `resolve(".")` + `processPath` 派生出的默认 `cwd` 能否被 `subprocess.spawn` 接受（若不接受，日志会出现 `worker_start`，按偏差 2 的下一步处理）。

## 5. 验收标准对照（`plan.md` 1–8）

- **8（我的部分）**：单测 81/81 通过（含首轮官方 `npm test` 暴露的 2 例修复）、typecheck 通过、构建产物有效；官方 `npm run build` 已由 Lead 复跑为**退出码 0**；官方 `npm test` 首轮 2 例失败已修复、**337/337 待 Lead 复跑确认**（见 §3），`install_bundle` / `list_plugins` 由 Lead 执行。
- **1–7**：均为真机项，由 Lead 在重装 bundle 并重启 DSH 后执行：不做任何 DSH 配置即激活并上传（`machine` 应为 `WORKSTATION-B`）、续轮幂等、重启回填不重复、无配置时 fail-open、显式 Config 覆盖共享配置、工具只进 `raw` / reasoning 可搜 / fork 与 subagent 独立会话、禁用后停止上传。

## 6. 遗留事项

1. **真机验证 `ctx.fs` 读取与默认 cwd**（见 §4 两点）；若默认 cwd 被拒，改为"省略 cwd"或要求显式 `workerCwd`。
2. **DSH 原生配置面**（0.1.2 候选，本版不做）：`Config` 换原生 schemastery Schema + 补 client 半注册 `plugins.row.config`。
3. **每次激活最多 2 次 node 探针 spawn**（home + hostname；共享配置给了 `machine` 时只剩 home）。若嫌激活延迟，可合并成一个 `op:"env"` 探针。
4. 本机共享配置目前只有 `baseUrl` / `token` / `timeoutMs`，`machine` 走 `os.hostname()`；若要显式固定，可在该文件加 `machine` 字段（无需改插件）。
5. `dist/index.js` 已用与 `scripts/build.mjs` 完全相同的参数重建，可供 Lead 直接重装；但**正式产物仍应以能跑 esbuild 服务的环境执行 `npm run build` 为准**。
6. `sidecar.test.ts` 现采用进程内打桩（Lead 选项 B）；若要再覆盖"生成代码在真实子进程 `node -e` 中跑通"（选项 A），可另加 `execFileSync(process.execPath, ["-e", SIDECAR_CODE], { input })` 用例——本会话沙箱对 `execFileSync(..., {input})` 实测 `EPERM`，本地无法验证该写法。

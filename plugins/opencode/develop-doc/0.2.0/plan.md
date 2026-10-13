# opencode-plugin 0.2.0 开发计划：OpenCode V1 / V2 单产物兼容

## 1. 阶段、工作区与事实源

- 当前为开发阶段，用户已明确指令“开始开发”：按本计划实现业务代码、受控依赖、构建、测试、summary及限定范围的本地提交。现役安装/替换仍需独立验收及用户另行批准。
- 分支：`0.2.x-opencode-plugin-dev`。
- 工作区：`D:/Github/session-hub/.worktrees/0.2.x-opencode-plugin-dev/`。
- 基线：主工作区 `master`，commit `441c9a4`；规划前主工作区干净。
- 版本事实源：`plugins/opencode/package.json`，`0.1.1 → 0.2.0`；根 `package-lock.json` 同步插件 workspace 版本。
- 全局事实源仍为根 `plan.md`，遵循根 `AGENTS.md` 的 TypeScript、npm、全量存档、源时间、镜像删除和 raw 归一化约束。
- 不变更服务端 API / 数据库、其他采集插件或全局架构决策。

## 2. 需求及完成边界

一份纯 JS ESM bundle 同时支持本机 V1 fork / 桌面端（目标 1.18.30，对象入口最低 1.18.29）与官方 V2 2.0.26。V1 既有配置、会话数据转换、同步触发、去重键和删除行为保持兼容；V2 恢复会话同步并能证明事件来自真实宿主。

本次不替换 `~/.config/opencode/plugins/session-hub.js`，不更改共享 OpenCode 配置，不读取真实 Session Hub 凭据，不访问真实服务端，不改变 `D:/Github/opencode` 或 OpenCode 本体。

开发完成交付：源代码及测试、单文件 JS、双端 mock E2E 证据、summary、限定本需求的中文提交。安装待 Leader 独立验收、用户确认后另行执行，替换前备份现役文件。

## 3. 已复核的侦察事实

1. `opencode` 解析到 npm 全局入口，实测 `opencode --version` 为 `opencode v2.0.26`。
2. V2 `opencode --help` / `serve --help` 确认有长驻 `serve`；`plugin list`、`api --server` 可用于隔离服务诊断。规划阶段仅运行 help / version，没有启动现役服务或插件。
3. V1 文件 `D:/opencode/opencode-fork.exe` 的实际版本输出为 `0.0.0-project-background-202609200141`。1.18.30 是用户已提供的基线来源，不能把该版本字符串当作官方版本号；开发验收必须以该二进制的加载行为实测。
4. `plugins/opencode/src/entry.ts` 当前 named/default 导出同一 V1 函数；`src/plugin.ts` 使用 `event.properties`、`client.session.get/messages`、`client.app.log` 和返回的 `dispose`。
5. idle 同步是每会话 3000ms debounce；deleted 用服务端列表过滤三元组后 DELETE 镜像。文本过滤 synthetic，raw 保留全部 parts；上限为 5000 条消息、文本 1000000 字符，标题 2000 字符。
6. `scripts/install.mjs` 当前直接 esbuild 输出到用户现役插件目录，无安全的仅构建入口。根 `npm run build` 当前不构建该插件 JS，只执行其 typecheck。
7. 已读 `develop-doc/0.1.1/summary.md`：桌面 Node 加载器不转译；legacy 加载器遍历导出；短命 run 会在 idle 后 debounce 前退出。该遗留不通过改变 V1 默认触发语义顺带修复；双端 E2E 使用长驻实例。
8. 官方标签 `v2.0.26` 的 `migrate-v1.mdx`、`index.mdx` 已完整阅读，与本地 `upstream/v2` 字节一致；本地参考 ref commit `4617210822bdbb31e5749751afbfb4584ccedac8`。参考仓库已有用户修改，保持只读。
9. 官方双支持形态是 default 对象：展开 `Plugin.define({ id, setup })`，另提供 `server(input, options)`；V1 调 server，V2 读 id/setup，不自动翻译钩子。
10. 官方上下文明确 `ctx.location` 是插件加载位置，不一定是事件对应会话的位置。会话 cwd 应取源会话自身；跨目录事件不得错误归到当前实例。

参考：
- `https://raw.githubusercontent.com/anomalyco/opencode/v2.0.26/services/www/src/docs/content/build/plugins/migrate-v1.mdx`
- 同目录 `index.mdx`
- `git -C D:/Github/opencode show upstream/v2:services/www/src/docs/content/build/plugins/migrate-v1.mdx`
- 根 `AGENTS.md` / `plan.md`、`plugins/opencode/develop-doc/0.1.1/summary.md`
- `server/apps/server/src/routes/sessions.ts`、`packages/shared/src/session.ts`

## 4. 方案

### 4.1 单入口、双宿主适配、共享业务核心

- 唯一产物 `session-hub.js`，稳定插件 id 为 `session-hub`。
- 入口仅 default 导出双支持定义，避免 helper / 常量被 V1 加载器当插件工厂调用；保留源码层 helper 接口及 backfill 使用方式。
- `server(...)` 包装 V1 当前插件能力；`setup(ctx)` 独立实现 V2 Promise API 适配。
- V1/V2 只负责事件、源快照读取、日志和生命周期桥接；共用现有转换、上传、删除镜像、配置和 debounce 规则。重构以 V1 回归测试约束，避免一份“万能 SDK”掩盖语义差异。
- 使用与 V2 2.0.26 兼容的 `@opencode/plugin`，开发时确认实际包版本与 exports，锁定依赖。V1 的 `@opencode-ai/plugin` 仅用于必要的类型校验。
- esbuild 把入口及新增运行时代码打入同一 JS；只按目标运行时允许的 Node 内建依赖 external，不留下要求宿主安装的裸包 import 或 TS 文件。

### 4.2 API 与事件适配

| 事项 | V1 保持 | V2 实现要求 |
|---|---|---|
| 入口 | server 返回既有 event/dispose hooks | setup 注册订阅并返回清理函数 |
| 事件 | properties 解析 | public event stream 的 data 解析，按 2.0.26 schema 逐事件核查 |
| 元信息 | session.get 的 data/time/directory | session.get({sessionID}) 的直接响应，字段映射经真实样本验证 |
| 历史消息 | session.messages + info/parts | 使用完整持久消息历史 API，处理分页、游标、顺序与完整内容 |
| 日志 | client.app.log | console 级别日志，仅状态/数量/源ID，无会话正文或敏感配置 |
| 结束 | 当前 pending timers 清理 | AbortController 终止订阅，清理 timers/队列/在途工作，防止卸载后继续同步 |
| 删除 | GET 三元组过滤 → DELETE | 等价源删除事件与源ID读取；不把 archive / move 当作删除 |

历史读取必须与模型上下文读取区分。`ctx.session.context` 的模型可见上下文不得未经证明就替代完整历史，否则压缩、工具产出、历史分页可能丢失。确切历史 API、数据形态与事件对照表属于开发前必须关闭的契约门，补充核查结果记录在本计划附录。

### 4.3 无损转换与并发

- 标识固定 agent=`opencode`，machine 仍按当前 hostname 规则，source_id 为宿主原始会话 ID；不因 API 代际修改幂等键。
- created_at / updated_at / message.ts 使用源数据时间；明确单位，禁止以上传时刻补齐源时间。
- V2 text、reasoning、工具调用/结果、文件、系统/压缩等原始信息按源消息关系保存到 raw；明文 reasoning 归一成 `{type:"reasoning",text}`。无明文必须说明，而非合成正文。
- 保持 V1 文本抽取、synthetic 过滤与既有限制；分页后的上限行为与 baseline 对照。未知 part 原文保留，不以 text 扁平化代替 raw。
- 同会话 debounce、同步在途合并/串行及删除竞争必须明确。删除后不得因旧 timer/旧读取又把已删除会话上传；多会话不得互串。
- 配置仍为环境变量覆盖共享 Session Hub 配置文件；默认值与禁用行为不变。V2 options 如作为补充入口，优先级需先明确，不能改变现有配置链。

### 4.4 安全构建与部署分离

新增仅构建命令和 `dist/session-hub.js` 输出；安装脚本复用相同构建函数并支持显式临时目标。根 build 验收必须覆盖插件最终 JS（增加 workspace build 编排或显式执行插件 build，并留证据），不运行默认安装命令。

安装功能与现役替换保持独立：开发期目标目录只能为测试沙箱；生产默认路径不得由 test/build 隐式访问。部署阶段另行授权，先备份现役文件，再替换、读回校验摘要，并保留恢复步骤。

## 5. 涉及文件

| 文件 | 计划改动 |
|---|---|
| `plugins/opencode/package.json`、根 `package-lock.json` | 规划版本已递增；开发时加入受控 v2 SDK / build 脚本及 lock |
| `plugins/opencode/src/entry.ts` | 唯一 default 双支持定义 |
| `plugins/opencode/src/plugin.ts` | 保留或抽出共享业务核心、V1 桥接 |
| `plugins/opencode/src/adapter-v1.ts`、`adapter-v2.ts`（按实际拆分） | 代际上下文/事件/快照适配 |
| `plugins/opencode/src/runtime.ts`（如需要） | per-session 调度及 cleanup |
| `plugins/opencode/scripts/build.mjs`（新增）、`install.mjs` | 单文件构建及隔离安装 |
| 根 `package.json` | 必要时将插件 bundle 纳入 build；不得带来安装副作用 |
| `plugins/opencode/test/*.test.ts` | V1 基线、V2 适配、raw、历史分页、生命周期、构建入口 |
| `plugins/opencode/test/e2e/` 或 `scripts/e2e*.mjs` | 两代真实宿主 + loopback mock harness |
| `plugins/opencode/tsconfig.json` | SDK/类型设置确有必要时调整 |
| `plugins/opencode/develop-doc/0.2.0/summary.md` | 开发阶段记录证据、偏差、遗留 |

文件最终拆分可在 summary 说明；范围限定当前插件及必要根构建编排。

## 6. Mock-only 双端验收设计

### 6.1 隔离前置门

用户已授权临时测试专用防火墙规则。Leader已配置测试副本专用规则及禁止子进程逃逸的Job启动器；设施与证据见 `C:/Users/example-user/AppData/Local/hermes/profiles/default/cache/scratch/opencode-network-isolation/HANDOFF.md`。只能经其中指定的 `launch_isolated.py` 启动V1/V2副本，仍须独立配置沙箱HOME/auth/日志并通过实际宿主内部网络资格验证，才能运行业务E2E。Node探针及版本命令通过不代表宿主E2E通过；若宿主需要被Job禁止的子进程，应停止并给方案，不得绕过启动器。最终规则清理由Leader在测试及独立验收结束后执行。本交接已落盘；消息投递曾返回target_busy，不能假定dev已读。

- 在 workspace 的独立临时目录或 Hermes scratch 中建立 HOME/USERPROFILE、XDG config/data/cache/state、临时 OpenCode 配置、插件目录、源数据库与日志目录。不要复制真实 `.env`、providers.local.json、数据库、auth 存储或 AdminExec 配置。
- 配置发现路径、全局插件自动发现、用户 home 读取方式需源码核查并通过探针证明隔离；仅设置 cwd 或单个 config 文件不足以声称隔离。
- 环境变量完整覆盖 Session Hub URL 与测试鉴权配置，且指向 loopback mock；所有可能真实远端的继承环境变量清理。
- 模型请求若必需，使用本地最小模型协议 mock，禁用联网 provider / 自动模型发现；不是只 mock Session Hub 而仍调用真实模型。
- 网络只允许 loopback；对未预期外连 fail closed。记录端口、进程、配置目录与 sandbox marker，安全失败后清场。
- 不直接运行现役 `opencode plugin list` 或对共享后台发请求；通过隔离环境 + 显式测试 server 参数/操作路径验证。

### 6.2 本地 Session Hub mock 契约

使用仓库的 `sessionUpsertSchema` 验证真实收到的 PUT：
- `PUT /v1/sessions`：按 agent+machine+source_id 幂等；首次 201 `{id,created:true}`，更新 200 `{id,created:false}`。
- `GET /v1/sessions`：支持当前 mirrorDelete 使用的 agent/machine/source_id 过滤，返回 `{total,limit,offset,items}`。
- `DELETE /v1/sessions/:id`：删除成功 `{ok:true}`，不存在 404。
- 测试鉴权仅临时生成，校验存在但不存入日志或证据；请求记录删除敏感头，不输出会话之外真实数据。

### 6.3 矩阵与证据

分别在 V2 2.0.26 `opencode serve --hostname 127.0.0.1 --port <沙箱端口>` 和指定 V1 fork 长驻 serve 中加载同一产物（记录 SHA256 相同）。V1 命令旗标以其 help 为准；不使用短命 run 做成功判据。

1. 等 ready、初始化临时 location；bounded retry 查询 plugin list，记录稳定 id/source/加载状态；V2 同时加载两个候选插件，检查互不干扰。
2. 创建合成会话，通过真实宿主提交合成消息，模型 mock 完成一轮产生真实 idle，等待超过 3s debounce；assert mock 收到正确 PUT。
3. 对比标题、cwd、源时间、角色、文本、reasoning/raw、工具结果、messages 数量和三元组。长历史覆盖多页与压缩后数据，不只测两条纯文本。
4. 多轮 / 多会话 / 重复 idle：对应快照更新，不串会话、不意外改变 V1 行为。
5. 删除源会话：对应 mock 记录删去；验证 debounce/在途删除竞争不会复活。
6. reload/unload 后订阅和 timers 释放，重复加载无重复订阅；订阅中断或上传失败日志可诊断，不阻塞 agent。
7. 收集本次隔离日志，无 failed-to-load / SchemaError / LoadError；共享日志路径仅作为用户提供的排障背景，不读取或混入本次验收。
8. finally 关闭本次实例与 mock、清理临时配置/数据/目录，核实现役两个文件摘要不变。

## 7. 开发任务清单

- [x] 读 SOP、全局 plan、0.1.1 summary、官方两份指南，复核版本/CLI。
- [x] 建独立 worktree，递增 package 与 lock 元数据，写规划。
- [x] 核查 V2 历史 API / 插件 ctx 差异、事件及数据映射，附录 A 留出完整历史读取通道决策门。
- [x] 用户确认用官方客户端显式连接同一宿主本地OpenCode服务，分页读取完整历史。
- [ ] 开发时验证实际V1加载器、V2同实例连接/认证/分页和完整快照一致性。
- [ ] 先实现安全 build-only / 临时安装目标，并测试默认 build 不写用户现役目录。
- [ ] 以现有用例固定 V1 baseline；增加双支持入口与 V2 adapter。
- [ ] 补消息 raw/分页、idle/delete、目录隔离、cleanup、异常用例。
- [ ] 单产物 Node ESM import 验证 + 两代长驻 mock E2E + 两插件共同加载验证。
- [ ] worktree 根 `npm test`、`npm run build` 全绿；明确插件 bundle 也已生成并测到。
- [ ] summary + 中文限定范围提交；Leader 独立验收与用户确认后另做部署。

## 8. 验收标准

- SH-01：同一 JS 摘要在目标 V1 与 V2 真正加载，稳定 id，唯一正确 default 定义，无 helper 误加载。
- SH-02：V1 现有配置链、默认 3s debounce、转换/上限、原始时间、删除镜像及 backfill 回归全绿。
- SH-03：V2 真 idle 导致 mock PUT；全历史/分页/raw/text/reasoning/tool 语义与源数据核对通过。
- SH-04：重复/跨目录/多实例事件不错误归属，删除不复活，卸载不遗留 timers/subscriptions。
- SH-05：故障/缺配置不阻塞宿主且可诊断，日志与提交无敏感配置值。
- SH-06：全程 loopback mock、无真实模型/Session Hub 凭据与请求，结束清场，现役部署摘要不变。
- SH-07：根 npm test/build 全绿，单文件 JS 可 Node 直接 import，无 TS/外部 SDK 安装要求。
- SH-08：与 agent-remote-auth 同时加载通过；双端证据、版本/产物摘要、命令、用例计数、日志摘要、清场记录写入 summary。

## 9. 暂停门与遗留边界

若 V2 公共 API 无法取得与 V1 等价的完整历史、reasoning 明文或工具结果，或关键事件无法等价迁移，停止对应功能实现并报 Leader：列出“公开 API 方案 / 受控只读持久源方案 / 分版本支持”的收益、限制与证据，待用户选择。禁止只上传模型上下文、删掉 raw 或取消删除镜像而宣称兼容。

短命 run 尾拍遗留不列入本版已修复目标；不改变 V1 既有触发策略来掩盖 E2E 失败。卸载清理与进程强杀后的最终同步保证不是同一件事。

## 附录 A：源码契约核查与开发决策门

### A.1 完整历史通道（用户已确认）

V2 2.0.26 的 `packages/plugin/src/promise/plugin.ts:26–54` 没有 message 域；`promise/session.ts:153–172` 只选取 get/context 等方法，没有 messages/message/export。官方上下文是客户端的子集，而非完整客户端。

完整历史可通过 **`@opencode/client` Promise 客户端**：
- `client.session.get({sessionID})`：直接返回源 session。
- `client.message.list({sessionID,limit,order?,cursor?,type?})`：返回 `{data,cursor:{previous?,next?}}`；列表消息已经带完整 projected 内容。
- `client.session.message.get({sessionID,messageID})`：单条 projected 消息详情。
- `client.session.export({sessionID,sanitize?})`：实验导出 API，不选作默认权威源。

不能调用不存在的 `ctx.message`，不能断言 SDK 引入后就能从 ctx 获得 server URL。`ctx.app` 仅 name/version/channel，没有 server URL。

已定方案与边界：
- 用户确认：插件使用官方客户端SDK显式连接运行该插件的同一个本地OpenCode服务，分页读取完整会话；只读，不创建会话/提交提示词/调用模型，不启动第二个服务或额外常驻进程。
- 增加endpoint/安全连接配置，以能力检查验证所连实例与会话归属；测试只用loopback与临时鉴权。生产接入配置待部署批准时设置，开发不得读取现役认证、猜测现役地址或改变服务配置。SDK内联进同一产物，V1不要求新增连接配置。
- V2缺连接配置时明确报未就绪，不上传部分历史、不覆盖已有完整镜像；active context不能作为后备权威源。
- 此方案授权只关闭规划决策门；仍按两段式在后续开发会话实现与验证。

### A.2 分页、快照及归一化

- `packages/server/src/handlers/message.ts:9–62`：默认50条，协议 limit 1–200；首请求 asc/200，后续只传 cursor，不与 order 同传。省略 type 以保留全部消息种类。
- 非空页总有 next；需取到空页结束，不以 next 存在判断 has_more。按持久化 seq 保持源序，不按 ID/时间重新排序。
- 游标锚点消失可能返回空页；分页非事务快照，读取前后检查源版本/时间并做有限重读，检测更改时不可把半份历史 PUT 覆盖全份镜像。无法建立可接受一致性则暂停给方案。
- `source_id=session.id`、`cwd=session.location.directory`、`created_at/updated_at=session.time.created/updated`；JSON时间为epoch ms。subpath独立，不能擅自改变 cwd 语义。
- V2 消息没有统一 parts：user 使用 text/files/agents/skills，assistant 使用原序 content[]，还包括 synthetic/system/skill/shell/compaction/idle/agent/model/location切换等种类。必须有显式 role 映射表与 fixture，完整源 type 保留在 raw，不过滤非 user/assistant 历史。
- assistant content 的 text/reasoning/tool 原结构顶层进入 raw，再附版本标识的完整源消息 envelope；明文 reasoning 仍为顶层 `{type:"reasoning",text}`，以兼容现有 raw 索引扫描。仅用 `{sourceMessage:...}` envelope 会丢 reasoning 索引，不可采用。
- tool.state 在 completed 时为 input+content[]，error 时为 error+可选content[]，内容包括 text/file(uri/mime/name)；不可直接按 V1 state.output 改名。完整保存 providerState、metadata、tokens/cost、error/finish 等源字段。
- 无损范围为 API 已持久化的 projected JSON；不保证未持久化流式碎片、provider 隐藏推理或文件 URI 的二进制内容。服务端没有 session级raw容器，本版保证既有会话元数据字段及每条 projected message，不扩充会话级存储契约。
- mock应提供 `GET /v1/sessions/:id/full` 并按真实服务端形态返回 raw，以读回核验无损保存；普通详情接口不返回 raw。

### A.3 事件与上限

- `session.idle → data.sessionID`；该事件 deprecated，兼容 `session.status` 中 `data.status.type="idle"`，统一归一并 debounce。
- `session.deleted → data.sessionID`；不是 V1 properties.info.id。取消对应pending，并以 per-session generation/tombstone防止在途旧上传复活；仅取消timer不足够。
- 服务端约束5000消息、text 1000000字符、title/cwd 2000字符；PUT是整体替换，不能逐页PUT。V1限额行为保持baseline；V2超限不能默默截尾却声称全量，需告警暂停该会话同步并请求扩容/分片契约决定。
- 现有截断后追加mark可能超过服务端上限，是已知独立风险；开发记录边界用例，不暗中改变V1截断契约。若导致本版验收失败，报告明确修复选项与范围。

### A.4 证据与版本范围

路径均以官方 `v2.0.26` 为准：`packages/client/src/promise/generated/client.ts`、`packages/protocol/src/groups/{message,session}.ts`、`packages/core/src/session/{store,history,model-request}.ts`、`packages/schema/src/{session,session-message,session-status-event,session-event,event}.ts`。根服务端参考 `indexing/raw-extract.ts`、`db/sessions.ts`、共享 session schema。

父级已独立复核 tagged plugin Context/SessionDomain 与消息分页 handler；两份迁移指南虽与upstream一致，所有运行时schema仍须绑定tagged版本，不把分支新增字段当2.0.26能力。开发验收必须以实际宿主结果验证静态契约。

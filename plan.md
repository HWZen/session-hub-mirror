# Session Hub — 跨端跨 Agent 会话中心（需求与方案定稿）

> 状态：需求与方案已定稿（2026-09-05）。本文档是唯一事实源，后续实施以此为准。
> 修订决策必须更新本文档。

---

## 1. 定位

**一句话**：只属于个人的"全量会话档案库 + 检索层"。把散落在多台机器、多个 AI Agent 上的会话原样聚合一处，并提供查询能力。

**系统只做两件事**：
1. **存得全**——接收各端上报的会话（内容 + 元数据），存储
2. **找得到**——提供 CRUD 列表/详情 + 对话内容的语义检索

**系统明确"不是"什么**（边界）：
- 不是记忆系统：不总结、不画像、不梳理、不产出结论
- 不是同步系统："跨机器找回产出"场景中，系统只负责"找"，同步动作由当前机器的 Agent 执行
- 不是给人看的产品：主要消费者是各 Agent，本人基本不直接访问
- 不是会话续聊：不追求"A 端继续 B 端的对话"，会话本体留在各 Agent，系统只要副本

**解决的根问题**：用户的"一整天工作全貌"只存在于自己脑中；任何单个 Agent 的视野都是碎片。本系统把碎片聚合，供任何 Agent 取用。

## 2. 核心场景（校准用例）

1. **跨机器/跨 Agent 的每日总结**——WorkBuddy 定时任务查询"某段时间有哪些会话（跨机器跨 Agent）"，基于全量原料做总结
2. **跨机器找回产出**——"昨天在机器 A 上让某 Agent 写了个 skill，找出来"：语义检索定位会话 → 拉取全文提取产出 → 当前 Agent 执行同步
3. **历史回溯**（系统无"天"概念，只有时间戳）——"三个月前这个报错怎么解决的"之类查询天然支持

## 3. 决策记录（已定，不再讨论）

| 决策项 | 结论 | 备注 |
|---|---|---|
| 存储范围 | 全量存：消息 + 工具产出/原文；**索引只做对话内容** | 原文全量落库 ⇒ 索引范围随时可推倒重建 |
| 系统加工 | 零加工；**否决"消费者写回批注"** | 批注混入检索结果会污染消费者上下文 |
| 总结/画像 | 消费者的职责，不在本系统 | |
| 查询能力 | 正常 CRUD + 语义搜索 + 关键词子串检索（grep，读侧能力，零加工不变，2026-09-06 增）；**否决专用增量/游标 API** | "取哪些 session"是消费者提示词的事；按时间过滤靠 CRUD 自然覆盖 |
| 时间戳 | 每会话存**创建时间 + 最后修改时间**（取源数据时间，非上传时间） | |
| 元数据 | agent、machine（主机名）、title、cwd/项目路径（可选，有就传） | opencode 自带 directory；WorkBuddy JSONL 自带 cwd |
| 消费粒度 | 检索定位（对话索引）+ 全量下载提取（skill 代码在工具产出里，靠详情接口拿） | 查找与提取分离 |
| 部署/隐私 | 单人自托管、明文存储、固定 token；代码以 MIT 许可证公开，个人生产实例与真实会话数据保持私有；公开前审查完整 Git 历史及发布资产 | 开源入口为 `https://github.com/HWZen/session-hub-mirror`，保留已脱敏的提交历史与原始时间。公开准备见 `server/develop-doc/0.23.0/plan.md` |
| 数据存放 | 自托管服务器本地盘；每个实例使用独立数据库路径。网络文件系统须验证锁可靠性，禁止 WAL | |
| 向量模型 | 模型不再全局锁死，**按提供商配置**（provider 级 `model` 字段，默认 `bge-m3`）；**活跃模型** = weight 最高的已启用 provider 的模型；索引与语义检索只使用活跃模型的向量空间；failover 候选**仅限与活跃模型相同的 provider**（"降级只换谁在算，不换算什么"沿用）；切换模型 = 切换向量空间，旧空间数据保留但检索不可见，需对活跃模型重新索引；**不引入"最大上下文"配置**（切片级 embedding，超限由提供商报错自然暴露） | 向量表按模型分表；维度为运行时事实，不再全局常量；2026-09-05 变更（起因：本地 Ollama 透 qwen3-embedding 服务，模型需可配） |
| 索引粒度 | **切片（chunk）级**：对消息 `text` 与从 `raw` 抽取的 `reasoning` 分别切片建向量（默认 ~1200 字符、重叠 15%），检索片段标注来源 `text`/`reasoning`；重建入口不变（删旧向量表全量重算）；**仅 `title`** 并入会话**首个切片**的 embedding 输入（`message_chunks.text` 存储仍为原始切片文本）；`cwd`/`agent`/`machine`/`source_id` 仅作 `sessions` 结构化过滤维度，不入向量 | 向量表按模型分表，前缀 `chunk_embeddings_<slug>`（切片表 `message_chunks`）；2026-09-10 变更（起因：一消息一向量稀释稀有条目，且 reasoning 未入索引）；2026-09-11 变更（元数据可被语义召回）；2026-09-12 变更（全字段 header 无区分度，探针量化后收窄为仅 title，见 `server/develop-doc/0.17.0/probe/result.md`） |
| 向量提供商 | 配置文件驱动，weight 决定优先级；本地与远程 OpenAI 兼容 embedding 服务均按 provider 配置 | 健康检查、同模型自动降级、恢复回升；无可用提供商时显式警告。Web 设置页保存 local 配置并热更新 |
| 技术栈 | TypeScript / Node.js + Hono + SQLite + sqlite-vec | 源码自托管，按部署环境使用 systemd 或 NSSM |
| 端范围 | 多台 Windows PC；手机不做；网页端/非 Agent 数据不做 | |
| v1 信息源 | OpenCode、ZCode、WorkBuddy、Hermes、DSH、Claude Code、Codex；豆包为实验方向 | 各来源能力见安装文档 |
| OpenCode 历史回填 | V1 SQLite CLI；V2 插件启动扫描 | |
| 更新/删除策略 | 跟随本地：本地改动/删除即同步（镜像语义），待实现时再细化 | |
| 时效性 | 钩子源准实时；轮询源分钟级 | |

## 4. 来源接口与适配事实

### opencode ✅
- 存储：`~/.local/share/opencode/opencode.db`（SQLite）
- 表：`session` / `message`（`data` JSON）/ `part`（工具产出，`data` JSON）等
- `session` 表自带 `directory`（工作目录）、`title`、`time_created`、`time_updated`、`model`、tokens 等
- 采集路线：**官方 TS 插件事件系统**（实时）；直读 DB 作兜底/回填

### WorkBuddy ✅
- 存储：`~/.workbuddy/projects/*/*.jsonl`（Claude Code 式 JSONL）
- 记录字段：`type`（`message`/`ai-title`）、`sessionId`、`timestamp`(ms)、`role`、`content[]`（`input_text`/`output_text`/`text`）、`cwd`；role/content/timestamp 位于行顶层
- 注意：用户真实输入在 `<user_query>` 标签内，需过滤 `<system-reminder` 注入；`type:"ai-title"` 行带 `aiTitle`，做 title 首选
- 兜底：`~/.workbuddy/workbuddy.db`（SQLite，`sessions` 表）
- 采集路线：Stop + SessionEnd 配置在 `~/.workbuddy/settings.json`；适配器在 `apps/collector`，JSONL 直读回填

### 豆包 ⚠️（实验性）
- 存储：`%LOCALAPPDATA%\Doubao\User Data\Default\IndexedDB\chrome_doubao-chat_0.indexeddb.leveldb`（~2.1MB）+ 同名 `.blob`（~1.15MB）
- 已确认含 UTF-16 中文消息内容与请求元数据（sessionId/conversation_id 等）
- 限制：运行时文件被锁 → **必须 copy-then-read**；仅最近会话的本地缓存，完整历史在云端；Chromium IndexedDB 私有序列化，解析脆弱
- 采集路线：独立适配器，copy-then-read + 尽力解析；坏了就停用，不阻塞主线

### ZCode ✅
- 存储：`~/.zcode/cli/db/db.sqlite`（SQLite，WAL 模式；ZCode 运行中即实时写入，readonly 连接可安全读取）
- 表：`session`（directory/title/time_created/time_updated，ms）/ `message`（data JSON：role、agent、time、semantics）/ `part`（data JSON：text/tool/reasoning 等，工具产出在 tool part 的 state.output）
- `message.data.semantics.kind` 需过滤：只取 `user_prompt` / `assistant_response`，丢弃 todo_reminder / background_notification / timeline_event 注入物；subagent 是独立 session 行（parent_id 非空）
- hook：声明式插件（`.zcode-plugin/plugin.json` + hooks/hooks.json，本地目录 marketplace 注册，插件 hook 自动启用）；7 个事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop），无 SessionEnd；hook 同步内联执行，上报必须 spawn detached 后立即 exit 0
- **实测教训**：hook payload 的 `transcript_path` 临时文件不可靠（仅 UserPromptSubmit 时刻有内容，其余 0 字节且用后即清）——实时采集数据源用 db.sqlite 直读，不依赖 transcript
- 采集路线：**Stop hook 逐轮全量 upsert**（服务端 upsert 本就是整体替换语义）+ 直读 db.sqlite 的历史回填；插件档 `plugins/zcode/develop-doc/0.1.0/plan.md`

### DSH ✅
- 会话权威数据源是 `ctx.sessionPersistence` 暴露的逻辑 `SessionEvent` 流；当前 JSONL 后端默认使用 Zstandard 压缩且支持格式迁移，采集插件不得绕过服务直读物理文件
- 官方持久扩展方式是 Cordis Host bundle：工作区内编写包，通过 `plugin_manager install_bundle` 安装到 profile；不得手改 profile 的 `package.json` / `cordis.patch.yml`
- `session/event` 在事件进入内存日志后同步通知，但持久化异步；每轮 `turn/end` 后由异步队列调用 `ctx.sessions.flush(session)` 建立持久屏障，再以 `ctx.sessionPersistence.open(id, "read")` 读取完整快照并上报
- Host 动态包沙箱无 Node `require`、全局 `fetch` 与 Node timers；`ctx.web.fetch` 仅支持 GET，不能上传会话。插件通过已启用的 `ctx.subprocess` seam 启动 `node -e` sidecar，payload/token 只走 stdin，由 sidecar 执行 HTTP PUT；所有具体方法在开发时以安装版静态源码与运行时 inspection 双重确认
- 采集路线：`plugins/dsh` Host-only 插件实时全量 upsert；会话事件全量保存在消息 `raw`，明文 reasoning 归一为顶层 `{type:"reasoning", text}` part
- 配置来源（2026-10-09 定）：DSH 0.2.0-rc.2 没有能填写第三方插件 Config 的界面（Host 投影 `unsupported`；插件无 client 半则插件页行无「配置」按钮；Settings 插件页只读；`dsh plugin` 只转发 pnpm）→ Cordis Config 仅作显式覆盖，`baseUrl`/`token`/`machine` 缺省从本机共享配置 `~/.config/session-hub/config.json` 读取，`machine` 再以 `os.hostname()` 兜底；token 不入库、不进日志、不写 profile patch
- 当前 DSH JSONL persistence 无删除/保留接口且不会删除会话文件，archive 不等于源删除；0.1.0 无可靠删除信号可镜像，若后续 DSH 暴露持久删除事件再补 DELETE 同步

### Claude Code ✅
- 存储：`~/.claude/projects/<cwd 转义>/<sessionId>.jsonl`（运行时实时追加，边跑边写）；subagent **不写主转写**，落在
  `<project>/<主会话 id>/subagents/agent-<agentId>.jsonl`（`isSidechain:true`，带 `.meta.json`）
- 记录字段：entry `type ∈ {user, assistant, attachment, ai-title, last-prompt, system, queue-operation, mode, permission-mode, atis-latch, file-history-snapshot, cost-state}`；
  assistant content 块 ∈ `{text, thinking, tool_use}`；user 真人输入 = content **字符串**，tool_result 载体 = content **块数组**（须区分）；
  同一次 API 调用拆多条 entry（`apiBlockIndex` 递增，`message.id` 相同）
- hook（2.1.295 本机实测，无头 `claude -p` 探针）：`UserPromptSubmit`/`Stop`/`SessionEnd`/`SessionStart` payload 均带
  `session_id` + **`transcript_path`（真实绝对路径，可靠——与 zcode 的临时文件教训相反）** + `cwd`；Stop 带
  `last_assistant_message`/`stop_hook_active`；SessionEnd 带 `reason`；Stop 时刻转写已含最终 assistant 消息
- title 首选 `ai-title` 条目的 `aiTitle`（同 WorkBuddy）；插件形态：`.claude-plugin/plugin.json` + `hooks/hooks.json`
  （包装格式）+ 本地目录 marketplace（`.claude-plugin/marketplace.json`）；hooks 启动时加载，改动需重启
- 采集路线：**插件 hook（UserPromptSubmit/Stop/SessionEnd）触发 + `transcript_path` 直读全量 upsert**；无 db、无节流；
  subagent 0.1.0 不采集；插件档 `plugins/claude-code/develop-doc/0.1.0/plan.md`

### Codex ✅
- 本地会话：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（默认 `$CODEX_HOME=~/.codex`）；标题索引为 `$CODEX_HOME/session_index.jsonl`
- 官方 hook：`Stop` 每轮主线程完成触发，stdin 提供 `session_id`、`transcript_path`、`cwd`、`turn_id` 等；插件可随 `hooks/hooks.json` 分发生命周期 hook，但安装/变更后需用户审阅信任
- 当前桌面端 rollout 的高层 `event_msg/item_completed` 可区分 `UserMessage`、`AgentMessage`、`Reasoning`、`CommandExecution`、`Extension`；底层 `response_item` 含 developer 注入与加密 reasoning，不能直接全量当对话正文
- 官方声明 transcript 格式不是稳定 hook 接口，适配器必须用 fixture 覆盖当前格式并保留兼容 fallback
- 采集路线：插件 `Stop` hook 触发 detached worker，对 `transcript_path` 做逐轮全量 upsert；扫描 sessions JSONL 做历史回填；插件档 `plugins/codex/develop-doc/0.1.0/plan.md`

### 自托管
- 服务和数据库由用户自行部署，生产实例与个人会话保持私有。
- Node 服务默认绑定 loopback；远程访问使用 HTTPS 反向代理。
- 本地或远程 embedding 都通过 provider 配置接入；各实例数据目录隔离。
- 可复用安装、启动、备份与验证步骤见 `server/README.md`。

## 5. 系统架构

```text
Agent plugins / hooks → Hono API → SQLite + sqlite-vec + FTS5
                            │
                     embedding provider 链
                            │
                     Web / 消费 Agent
```

## 6. 数据模型（草案）

```
sessions
  id              TEXT PK        -- 服务端生成 UUID
  agent           TEXT NOT NULL  -- opencode | workbuddy | doubao | zcode | codex
  machine         TEXT NOT NULL  -- 主机名
  source_id       TEXT NOT NULL  -- 源会话 ID
  title           TEXT
  cwd             TEXT           -- 可选，有就传
  created_at      INTEGER NOT NULL  -- 源创建时间(ms)
  updated_at      INTEGER NOT NULL  -- 源最后修改时间(ms)
  deleted_at      INTEGER           -- 本地删除镜像
  indexed_at      INTEGER
  indexed_model   TEXT
  UNIQUE(agent, machine, source_id)  -- 幂等 upsert 键

messages / parts                -- 全量原文（JSON 存储或子表，实施时定）
  role, text, ts, raw(JSON)
```

## 7. API 草案（v1）

| 方法/路径 | 说明 |
|---|---|
| `PUT /v1/sessions` | upsert（幂等键 agent+machine+source_id） |
| `GET /v1/sessions` | 列表；过滤：`agent` `machine` `created_from/to` `updated_from/to`、分页 |
| `GET /v1/sessions/:id` | 对话消息（仅 idx/role/text/ts，不含元数据与消息 raw；2026-09-10 拆分） |
| `GET /v1/sessions/:id/full` | 全量详情（会话记录 + 消息 + 工具产出原文 raw） |
| `GET /v1/sessions/:id/full_length` | full 响应体字节数（UTF-8） |
| `DELETE /v1/sessions/:id` | 删除 |
| `POST /v1/search` | `{query, top_k, filters?}` → 命中会话 + 片段（对话索引） |
| `GET /v1/grep` | 关键词子串检索（2026-09-06 增）：`?q=` + 过滤参数同 sessions + `case_sensitive` → 命中消息按会话分组 + 片段 |
| `GET/PUT /v1/settings/providers` | 提供商链读取/保存（含每提供商 `model`；密钥掩码返回；留空=保留旧密钥），保存即热更新 |
| `POST /v1/settings/providers/test` | 单提供商探针：`{name}` → `{ok, latencyMs, dim, model, error}`（用该 provider 自己的 model 发请求） |
| `POST /v1/settings/reindex` | 为未索引会话补建向量（每批 ≤200） |
| `GET /health` | 存活 + 当前 embedding 提供商 + 服务版本号 |

鉴权：`Authorization: Bearer <token>`，单一固定 token。

## 8. 实施阶段

1. **P1 服务端核心**：Hono + SQLite(禁 WAL) + sqlite-vec + 本地 CPU bge-m3 兜底 + CRUD/搜索 API + token 鉴权 —— 用 CPU 先跑通全链路
2. **P2 opencode 插件**：TS 插件钩子实时上传 + 历史回填脚本（117 会话）
3. **P3 WorkBuddy 采集**：hook 推送式采集（原轮询方案，2026-09-08 升级）；`apps/collector` 0.1.0 已落地
4. **P4 公网化 + 提供商链（暂缓，2026-09-06：先局域网 HTTP:5328 + token）**：Caddy(HTTPS/DDNS) + frps/frpc + GPU 机 bge-m3 服务 + 提供商配置文件（5070Ti→4070Ti→云端）
5. **P5 豆包实验适配器**：copy-then-read + LevelDB/IndexedDB 尽力解析
6. **P6 收尾**：消费端验证（WorkBuddy 每日总结任务改走本 API）、文档、运行手册
7. **P7 Codex 插件**：Stop hook 逐轮全量上报 + rollout JSONL 历史回填

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| SQLite WAL 在 SMB 上有损坏风险（文件锁不可靠） | **禁用 WAL**：`journal_mode=TRUNCATE`（或 DELETE）+ `synchronous=FULL`；单人低写入量可接受；出现锁问题再回退本地盘 |
| 豆包解析随版本更新失效 | 定位为实验性，独立模块、可整体停用；能采多少是多少 |
| Codex rollout transcript 格式变更 | 官方已声明格式不稳定；适配器用真实 fixture、主/兼容双路径、未知事件宽容与解析统计隔离变化 |
| WorkBuddy 格式受宿主版本影响 | 解析器通过 fixture 锁定已知格式，其他机器与版本以实机样本为准 |
| 提供商切换导致向量空间不一致 | 向量表按模型分表；failover 候选仅限同模型 provider；会话记录 `indexed_model`，检索只查活跃模型空间；切换后旧空间会话自动进入待索引队列（`indexed_model != 活跃模型` 即视为未索引） |
| 档案库成为"历史秘密集中地" | 现在不做；后期可在**采集端**加脱敏（客户端职责，不违反系统零加工原则） |
| 数据只有 NAS 一份（用户决定不备份） | 接受；SQLite `integrity_check` 可作为日常健康检查项 |

## 10. 被否决的备选（留档，避免重新踩坑）

- **消费者写回批注**：否决——批注混入检索结果污染消费者上下文
- **专用增量/游标 API**：否决——CRUD + 时间戳足够，取数逻辑归消费者提示词
- **环境级采集（录屏/全局活动流）**：否决——重、噪声大、保真度低
- **数据本地 + NAS 备份**：否决——用户选择直接存 NAS
- **Docker 部署**：否决——老机器，直接 Windows 服务（NSSM）
- **检索结果做会话级摘要加工**：否决——系统零加工原则

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
| 部署/隐私 | 私人服务器、明文存储、固定 token；单人使用；无开源计划；HTTPS/Caddy 属 P4 公网化（暂缓），当前阶段 HTTP + token 仅局域网 | |
| 数据存放 | **服务器本地盘**（2026-09-06 变更：部署进服务器 WSL，数据落 Windows D 盘 NTFS；2026-09-17 从 WSL1 Ubuntu-20.04 迁移至 WSL2 Ubuntu-26.04，数据仍在 D 盘原地）；NAS SMB 方案暂缓，恢复 NAS 时仍须禁用 WAL（见 §9 风险） | |
| 向量模型 | 模型不再全局锁死，**按提供商配置**（provider 级 `model` 字段，默认 `bge-m3`）；**活跃模型** = weight 最高的已启用 provider 的模型；索引与语义检索只使用活跃模型的向量空间；failover 候选**仅限与活跃模型相同的 provider**（"降级只换谁在算，不换算什么"沿用）；切换模型 = 切换向量空间，旧空间数据保留但检索不可见，需对活跃模型重新索引；**不引入"最大上下文"配置**（切片级 embedding，超限由提供商报错自然暴露） | 向量表按模型分表；维度为运行时事实，不再全局常量；2026-09-05 变更（起因：本地 Ollama 透 qwen3-embedding 服务，模型需可配） |
| 索引粒度 | **切片（chunk）级**：对消息 `text` 与从 `raw` 抽取的 `reasoning` 分别切片建向量（默认 ~1200 字符、重叠 15%），检索片段标注来源 `text`/`reasoning`；重建入口不变（删旧向量表全量重算）；会话元数据（title/machine/agent/source_id/cwd）并入会话**首个切片**的 embedding 输入（`message_chunks.text` 存储仍为原始切片文本） | 向量表按模型分表，前缀 `chunk_embeddings_<slug>`（切片表 `message_chunks`）；2026-09-10 变更（起因：一消息一向量稀释稀有条目，且 reasoning 未入索引）；2026-09-11 变更（元数据可被语义召回） |
| 向量提供商 | **配置文件驱动**；优先级链：5070Ti(frp) → 4070Ti(frp) → 云端(待填，可走 new-api 网关)；**不再内置本地 CPU 兜底**（2026-09-05 变更：服务器 i3+16G 跑不动 fp32 bge-m3，实测峰值 20G+ 内存）；本地推理服务（Ollama/llama.cpp 等）如需要，按普通 OpenAI 兼容 provider 配置即可 | 健康检查 + 自动降级；降级只换"谁在算"，不换"算什么"（候选集限同模型，见"向量模型"行）；未配置任何可用提供商时 health 返回警告、索引/搜索报错，不静默兜底；Web 设置页可编辑（配地址/密钥/模型/权重/开关/超时），写 `config/providers.local.json`（gitignore，优先于样例文件），保存即热更新 |
| 技术栈 | TypeScript / Node.js（唯一语言）+ Hono + SQLite + sqlite-vec | **不用 Docker**；Caddy + NSSM 属 P4 公网化（暂缓），当前 WSL2 内 systemd 托管（`session-hub.service`，Windows 登录计划任务拉起 distro） |
| 端范围 | 多台 Windows PC；手机不做；网页端/非 Agent 数据不做 | |
| v1 信息源 | opencode（钩子）、WorkBuddy（hook 实时推送，2026-09-08 变更）、豆包（实验性）、zcode（钩子+回填，2026-09-06 增） | |
| opencode 历史回填 | 做（本机已有 117 会话） | |
| 更新/删除策略 | 跟随本地：本地改动/删除即同步（镜像语义），待实现时再细化 | |
| 时效性 | 钩子源准实时；轮询源分钟级 | |

## 4. 侦察事实（2026-09-05，机器 WORKSTATION-A）

### opencode ✅
- 存储：`~/.local/share/opencode/opencode.db`（SQLite）
- 表：`session` / `message`（`data` JSON）/ `part`（工具产出，`data` JSON）等
- 本机数据量：117 会话 / 3574 消息 / 14406 part
- `session` 表自带 `directory`（工作目录）、`title`、`time_created`、`time_updated`、`model`、tokens 等
- 采集路线：**官方 TS 插件事件系统**（实时）；直读 DB 作兜底/回填

### WorkBuddy ✅
- 存储：`~/.workbuddy/projects/*/*.jsonl`（Claude Code 式 JSONL）
- 记录字段：`type`（`message`/`ai-title`）、`sessionId`、`timestamp`(ms)、`role`、`content[]`（`input_text`/`output_text`/`text`）、`cwd`；行结构扁平（role/content/timestamp 在行顶层，2026-09-08 WORKSTATION-B 实测）
- 注意：用户真实输入在 `<user_query>` 标签内，需过滤 `<system-reminder` 注入（参考 `D:\temp\session_daily.py`）；`type:"ai-title"` 行带 `aiTitle`（官方 AI 标题），做 title 首选
- 兜底：`~/.workbuddy/workbuddy.db`（SQLite，`sessions` 表）
- 采集路线：**hook 实时推送为主**（Stop + SessionEnd 挂 `~/.workbuddy/settings.json`，适配器在 `apps/collector`，0.1.0 已落地并本机实测）；文件直读作兜底/回填

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

### 自托管环境

用户自行部署服务、数据库与 embedding provider；实例数据目录独立，远程访问使用 HTTPS。

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
  agent           TEXT NOT NULL  -- opencode | workbuddy | doubao
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

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| SQLite WAL 在 SMB 上有损坏风险（文件锁不可靠） | **禁用 WAL**：`journal_mode=TRUNCATE`（或 DELETE）+ `synchronous=FULL`；单人低写入量可接受；出现锁问题再回退本地盘 |
| 豆包解析随版本更新失效 | 定位为实验性，独立模块、可整体停用；能采多少是多少 |
| WorkBuddy 格式未经另一台机器实测 | 2026-09-08 已在本机（WORKSTATION-B）实测并修正解析器；其他机器/版本以实机样本为准，采集器做好格式容错 |
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

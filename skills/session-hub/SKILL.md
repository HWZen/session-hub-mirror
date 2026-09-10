---
name: session-hub
description: 操作 Session Hub 个人会话档案库：上传/更新会话、语义搜索历史会话、查看统计与索引进度。当需要把会话存入档案库、从历史会话里找东西、或管理会话索引时使用。通过 HTTP 请求即可完成全部操作（不限 curl，任何能发起 HTTP 请求的方式均可），零 SDK 依赖。只需本文件 + 服务端地址 + Token。
---

# Session Hub · AI Agent Skill

> 本 Skill 用于操作 Session Hub（跨端跨 Agent 的个人会话档案库 + 检索层）。
> 接口信息**动态查询，不固化**——本文档示例仅供参考，实际调用前先按第 2 节实时发现接口。

---

## 0. 基础信息

| 项 | 值 |
|----|------|
| API 基址 | 默认 `http://127.0.0.1:7428`；NAS/远程部署时以用户提供为准 |
| 认证头 | `Authorization: Bearer <token>`（`/v1/*` 全部需要；`/health` 免认证） |
| 内容类型 | `Content-Type: application/json` |

所有请求/响应均为 JSON。

---

## 1. 连接信息（config.json 缓存）

首次调用前，先查看本 Skill 同目录下的 `config.json` 是否已保存连接信息：

```json
{
  "base_url": "http://127.0.0.1:7428",
  "token": "..."
}
```

- **已有 base_url 和 token**：先用 `GET /health` 探活；`200` 即可用，跳到第 2 节。
- **收到 401**：token 失效（服务端 `SH_AUTH_TOKEN` 已更换），向用户重新索取。
- **没有 config.json**：向用户索取两样东西——服务端地址（IP:端口）和 Token（服务端 `.env` 里的 `SH_AUTH_TOKEN`）。**不要猜、不要编造**。拿到后写入 `config.json` 供下次复用。

`GET /health` 返回示例（免认证，可用于探活与诊断）：

```json
{
  "ok": true,
  "version": "0.9.0",
  "warnings": [],
  "db": { "ok": true, "journal_mode": "truncate" },
  "embedding": { "...": "提供商链状态" },
  "now": 1757100000000
}
```

- `ok: false` / HTTP 500：数据库异常，需用户介入。
- `warnings` 非空：索引与语义检索当前不可用（如未配置 embedding 提供商），上传仍可用。

---

## 2. 接口发现（动态查询，不固化）

> 本文档中的接口示例仅供参考，**接口、参数、返回值后续可能变更**。实际调用前，请实时查询接口信息。

### L0 索引：获取全量接口列表

```
GET /v1/help
Authorization: Bearer <token>
```

**响应：**

```json
{
  "total": 11,
  "endpoints": [
    {"method": "PUT", "path": "/v1/sessions", "summary": "上传/更新会话（按 agent/machine/source_id 三元组幂等 upsert）"},
    {"method": "POST", "path": "/v1/search", "summary": "向量语义搜索会话（活跃 embedding 模型的向量空间）"},
    ...
  ],
  "hint": "对任意接口附加 ?help=1 查看该接口的详细说明（参数/返回/示例/错误）"
}
```

### L1 详情：单个接口的参数表

对任意 `/v1` 接口附加 `?help=1`，返回结构化说明（**不执行业务逻辑**）：

```
PUT /v1/sessions?help=1
Authorization: Bearer <token>
```

**响应字段：** `method` / `path` / `summary` / `params[]`（name、in（query/body/path）、type、required、desc）/
`returns[]` / `example` / `errors[]`（status、message、recoverable）。

**使用流程**：先 `GET /v1/help` 找目标接口 → 再 `?help=1` 看 L1 详情 → 按 `params` 构造请求执行。

---

## 3. 统一响应与错误处理

### 成功

各接口返回自有业务字段（**没有统一 `{ok}` 包装**）。如 `PUT /v1/sessions` 成功返回
`{"id": "...", "created": true}`，新建时 HTTP 201，更新时 200。

### 失败

```json
{"error": "invalid body", "issues": [{"path": ["agent"], "message": "..."}]}
```

语义以 **HTTP 状态码**为准：

| status | 含义 | 可恢复 |
|--------|------|--------|
| 400 | 参数缺失/格式错误（`issues` 为字段级校验错误） | 是：按 issues 修正后重试 |
| 401 | Token 缺失或错误 | 是：向用户重新索取 token |
| 404 | 资源不存在（或接口路径错误） | 是：核对 `GET /v1/help` |
| 503 | embedding 不可用（无可用提供商） | 是：稍后重试或提示用户配置 |
| 500 | 服务内部错误 | 否：需用户介入 |

**`recoverable` 语义**：`true` 表示可自行修正后重试；`false` 表示需用户介入。

---

## 4. 完整调用示例

### 场景：上传会话（幂等）

```text
# 1. 查用法
PUT /v1/sessions?help=1 → params/returns/example/errors

# 2. 执行（新建返回 201；同三元组再次上传为更新，返回 200）
PUT /v1/sessions
{
  "agent": "opencode",
  "machine": "MY-PC",
  "source_id": "ses_abc123",
  "title": "修复登录超时",
  "created_at": 1757100000000,
  "updated_at": 1757100600000,
  "messages": [
    {"role": "user", "text": "登录接口经常超时，帮我看看", "ts": 1757100000000},
    {"role": "assistant", "text": "排查发现是连接池配置问题", "ts": 1757100060000}
  ]
}
→ {"id": "…", "created": true}
```

要点：

- `agent` + `machine` + `source_id` 三元组唯一，决定幂等 upsert——重复上传会**覆盖**旧内容。
- `created_at`/`updated_at`/`ts` 均为毫秒时间戳，**取源数据时间**，不要用上传时刻。
- 索引是异步的：上传成功即返回，向量稍后在后台补齐（见 `GET /v1/stats` 的 `unindexed`）。

### 场景：语义搜索历史会话

```text
# 1. 查用法
POST /v1/search?help=1

# 2. 执行
POST /v1/search
{"query": "上周修的那个登录超时问题", "top_k": 5}
→ {"model": "bge-m3", "provider": "…", "results": [{"session": {…}, "distance": 0.18, "snippets": […]}]}
```

`results` 按距离升序；`snippets` 是命中消息片段，可快速定位上下文。可带 `filters`
（agent/machine/source_id/时间范围/title）缩小范围，字段同 `GET /v1/sessions`。

### 场景：关键词检索（grep 式子串匹配）

```text
# 1. 查用法
GET /v1/grep?help=1

# 2. 执行（q 必填 1..256 字符，需 URL 编码）
GET /v1/grep?q=E_ROLLBACK&agent=opencode&limit=20
→ {"total": 12, "limit": 20, "offset": 0, "items": [{"session": {…}, "hits": [{"message_idx": 3, "role": "user", "ts": …, "snippet": "…", "match_start": 42}]}]}
```

按**字面子串**匹配消息正文，不依赖 embedding 提供商——语义检索 503 时仍可用；适合精确词
（错误码、函数名、文件路径）。默认大小写不敏感（仅 ASCII 折叠），`case_sensitive=1` 敏感；
`%`/`_`/`\` 按字面匹配而非通配符。可与 agent/machine/source_id/时间范围/title 过滤组合；
`total` 为命中消息总数（分页按消息行计），`hits[].match_start` 是命中在 snippet 内的偏移。

### 场景：列出会话 / 查看详情

```text
GET /v1/sessions?agent=opencode&limit=20&offset=0
GET /v1/sessions/:id             # 对话消息（idx/role/text/ts，不含元数据与 raw）
GET /v1/sessions/:id/full        # 全量详情（会话记录 + 全部消息含 raw）
GET /v1/sessions/:id/full_length # full 响应体字节数
DELETE /v1/sessions/:id          # 软删除
```

### 场景：统计与补索引

```text
GET /v1/stats               # 会话/消息数、indexed/unindexed、按 agent/machine 分布
POST /v1/settings/reindex   # 手动补一轮索引（同步，批量 ≤200）
```

---

## 5. 约束提醒

- 会话正文含用户密钥/内网信息等敏感内容：**不要**把会话正文打印到日志或发送到本系统之外的服务。
- 对各来源的本地会话文件**只读**；写入一律走本 API。
- 上传前不必查重：三元组幂等 upsert 已处理重复。

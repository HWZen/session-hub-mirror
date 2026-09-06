# Session Hub

跨端跨 Agent 的个人会话档案库 + 检索层。只做"存得全、找得到"，零加工。

opencode / ZCode / WorkBuddy / 豆包等各 Agent 的会话全量归档到一处（SQLite 单库，当前部署在远程服务器），支持语义检索定位 + 全量下载提取。

- **采集**：各客户端插件经事件钩子准实时上传（全量快照，按 `agent+machine+source_id` 三元组幂等 upsert），存量会话用 backfill CLI 一次性回填
- **检索**：向量语义搜索（embedding 提供商链，模型按提供商配置，默认 bge-m3）+ 列表 / 详情
- **消费**：Web 前端，或任意 Agent 直调 HTTP API（见 Agent Skill）

## 仓库结构

```
packages/shared/          跨子系统契约（会话数据模型、类型、配置 schema）
server/                   服务端子系统（API + Web 前端，版本号与 develop-doc 在此）
plugins/opencode/         opencode 插件（实时采集 + 删除镜像 + 历史回填）
plugins/zcode/            ZCode 插件（UserPromptSubmit/Stop 钩子实时采集 + 历史回填）
plugins/marketplace.json  本地目录 marketplace 清单（ZCode 插件安装用）
skills/session-hub/       Agent Skill（教外部 Agent 直调 HTTP API 操作档案库）
apps/collector/           采集器守护进程（规划中：WorkBuddy 轮询、豆包适配器）
plan.md                   全局需求与决策（唯一事实源）
AGENTS.md                 AI 协作规范与开发 SOP
```

## 快速开始（服务端）

```sh
npm install
cp server/.env.example server/.env   # 必改：PORT、SH_AUTH_TOKEN、SH_DB_PATH
npm run dev        # 本地开发实例 http://127.0.0.1:7428（生产部署见下节）
npm run dev:web    # 前端开发（可选，Vite 代理默认 7428）
npm test
```

- embedding 提供商在 Web 设置页或 `server/config/providers.local.json` 配置（模型按提供商配置，默认 bge-m3）；未配置时上传仍可用，仅语义检索不可用
- 验证：`GET /health` 免认证；`/v1/*` 一律需要 `Authorization: Bearer <SH_AUTH_TOKEN>`

## 自托管部署

使用自己的服务地址、固定 token 和独立数据库。安装前先核对本版本配置样例及运行脚本。

## Agent 安装指南

> Agent 读完本节即可代替用户完成钩子插件与 Skill 的安装。**服务端地址与 Token 必须向用户索取，不要猜、不要编造。**

### 第 0 步：收集连接信息（需用户参与）

| 项 | 来源 |
|---|------|
| 服务端地址 `baseUrl` | 用户实际使用的部署入口。填写用户自己的部署入口 |
| Token | 服务端 `server/.env` 里的 `SH_AUTH_TOKEN`（生产实例的 token 以用户提供为准） |

先 `GET <baseUrl>/health` 探活：`ok: true` 即可继续；`warnings` 非空只影响语义检索，不影响采集。

### 第 1 步：写共享配置（插件与 Skill 共用）

写入 `~/.config/session-hub/config.json`：

```json
{ "baseUrl": "https://session-hub.example.test", "token": "<SH_AUTH_TOKEN>", "timeoutMs": 30000 }
```

环境变量 `SESSION_HUB_URL` / `SESSION_HUB_TOKEN` 优先于该文件。未配置时插件静默不启用（opencode 会打一条禁用日志）。

### 第 2 步：安装 ZCode 插件（hooks 实时采集）

```sh
npm run install:zcode-plugin    # esbuild 打包 dist/hook.js + dist/worker.js 并校验
```

注册到 ZCode（Settings 是 UI 操作，引导用户完成）：

1. ZCode → Settings → Plugin Management → Discover → "+" 添加本地目录 marketplace，选仓库的 `plugins/` 目录（含 marketplace.json）
2. 启用其中的 `session-hub` 插件
3. **新开一个会话**验证——hook 配置只在会话启动时加载

排障：

- hook 未生效：把插件 manifest（`plugins/zcode/.zcode-plugin/plugin.json`）的 hooks 指向 `dist/hooks-absolute.json`（构建时生成的本机绝对路径版本），再新开会话
- 运行日志（仅元数据，不含正文）：`~/.config/session-hub/logs/zcode-worker.log`

### 第 3 步：安装 opencode 插件

```sh
npm run install:plugin    # 打包单文件到 ~/.config/opencode/plugins/session-hub.js
```

重启 opencode 或新开会话即生效，日志出现 `session-hub: enabled` 表示已启用；本地删除会话会镜像删除服务端记录。

### 第 4 步：历史回填（可选，补存量会话）

```sh
# ZCode：默认只读 ~/.zcode/cli/db/db.sqlite，跳过 subagent 子会话
npm run backfill -w @session-hub/zcode-plugin -- --url <baseUrl> --token <token> [--since <ms>] [--dry-run]

# opencode：默认只读 ~/.local/share/opencode/opencode.db；url/token 可省略，回落 config.json
npm run backfill -w @session-hub/opencode-plugin -- [--since <ms>] [--dry-run]
```

- 幂等 upsert，重复执行安全；建议先 `--dry-run` 预览
- 对源库只读；opencode.db 为 GB 级，禁止整库拷贝

### 第 5 步：安装 Agent Skill（让任意 Agent 会用档案库）

`skills/session-hub/SKILL.md` 是外部 Agent 的操作手册：上传/更新会话、语义搜索、统计与补索引，接口动态发现（`GET /v1/help`），零 SDK 依赖。安装：

1. 把 `skills/session-hub/` 整个目录复制（或软链）到目标 Agent 的技能目录，如 `~/.agents/skills/session-hub/`
2. 目录需可写：Skill 会在 SKILL.md 同目录缓存 `config.json`（内容同第 1 步）；没有缓存时首次使用会向用户索取地址与 Token
3. 收到 401 说明 token 失效（服务端 `SH_AUTH_TOKEN` 已更换），向用户重新索取

### 第 6 步：验收（Agent 执行）

1. `GET /health` → `ok: true`
2. 新开 ZCode / opencode 会话对话两轮 → `GET /v1/stats`（带 Bearer token）会话数 +1；索引异步，`unindexed` 稍后归零
3. `POST /v1/search` 用刚才会话里的关键词能搜到该会话

## 安全约定

- Token 只进用户目录的 `config.json` 与服务端 `.env`，绝不提交仓库
- 会话正文含密钥/内网信息：日志只记元数据与统计；Agent 不把会话正文发到本系统之外
- 对各来源本地会话文件只读，写入一律走 API

## 文档

- `plan.md` — 需求、决策记录、侦察事实、风险
- `AGENTS.md` — 开发 SOP（每个需求一个版本号，`<子系统>/develop-doc/<版本号>/`）
- `server/develop-doc/`、`plugins/*/develop-doc/` — 各版本 plan.md / summary.md 档案

# 服务端安装与自托管

## 前置条件

- 建议 Node.js 22.13+ LTS、npm 10+；源码使用 `process.loadEnvFile` 和 `import.meta.dirname`。
- SQLite 原生模块 `better-sqlite3` 和 `sqlite-vec` 需支持目标平台。预编译模块不可用时，安装 Node 原生模块构建工具（Windows：C++ Build Tools；Linux：C/C++ 编译器、make、node-gyp 所需 Python）。
- Python 构建工具按本机环境管理要求提供；应用运行时代码为 TypeScript / Node.js。
- 安装从仓库根目录执行，保留全部 workspace。

本仓库锁定的 `better-sqlite3` 13.0.3 含平台预编译模块，但默认安装脚本仍可能触发 node-gyp。若默认安装受构建工具阻塞，可以 `npm ci --ignore-scripts` 后先验证 `node -e "const D=require('better-sqlite3');const d=new D(':memory:');console.log(d.prepare('select 1 as ok').get());d.close()"`，再运行根测试和构建。只有目标平台原生模块实测可用时才采用这种安装方式。

```sh
npm ci
```

## 配置

复制 `server/.env.example` 为 `server/.env`（PowerShell：`Copy-Item server/.env.example server/.env`；POSIX：`cp server/.env.example server/.env`）。

| 变量 | 配置 |
| --- | --- |
| `HOST` / `PORT` | 默认 `127.0.0.1:7428`；远程访问使用 HTTPS 反向代理 |
| `SH_AUTH_TOKEN` | 必填，校验至少 8 字符；实际使用长随机值，不保留样例值 |
| `SH_DB_PATH` | 如 `./data/session-hub.db`；父目录自动创建 |
| `SH_WEB_DIST` | `./apps/web/dist`，构建后由 API 服务托管前端；留空仅 API |
| `SH_PROVIDERS_FILE` | 默认 `./config/providers.json` |
| `SH_PROVIDERS_LOCAL_FILE` | 默认 `./config/providers.local.json`，存在时优先 |
| `SH_AUTO_INDEX_INTERVAL_MS` | 默认 30000，至少 5000 |
| `SH_EMBED_BATCH_SIZE` | 默认 32，正整数 |

`.env` 及所有相对配置路径均以 `server/` 为根，与启动目录无关。每个实例使用独立数据库路径和端口。优先本地磁盘；SQLite 统一使用 `TRUNCATE`、`FULL` 和 busy timeout，不启用 WAL。网络文件系统必须自行确认锁与事务可靠性。

生成随机 token 可在本机执行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`，结果仅写入私有配置。

## 启动

开发：

```sh
npm run dev
npm run dev:web
```

第二条在另一个终端执行。Vite 默认代理到 7428；其他端口设置 `SH_API_PORT`（PowerShell：`$env:SH_API_PORT='7429'`；POSIX：`SH_API_PORT=7429 npm run dev:web`）。

源码部署：

```sh
npm run build
node server/apps/server/dist/index.js
```

配置 `SH_WEB_DIST=./apps/web/dist` 后，同一端口提供 Web 和 API。`npm start` 会先执行完整构建。可由 systemd 或 NSSM 托管 Node 进程；根据部署目录配置启动命令与私有环境，日志仅保留必要诊断信息。

Release zip 是独立发布包，依赖与启动入口以 zip 内 `package.json` 为准，不套用源码 workspace 命令。源码更新依赖后重新 `npm ci` 与构建；不要默认跳过所有原生模块安装脚本。

## Embedding

默认样例全部禁用。可在 Web 设置页配置，或创建 `server/config/providers.local.json`：

```json
{
  "providers": [
    {
      "name": "local-embedding",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "bge-m3",
      "weight": 100,
      "enabled": true,
      "timeoutMs": 30000
    }
  ]
}
```

示例要求该地址实际提供 OpenAI 兼容 `/v1/embeddings` 且已安装指定模型。需要认证时使用 `apiKeyEnv` 指向私有环境变量，或在已 gitignore 的 local 文件中设置 `apiKey`。

最高 weight 的已启用提供商决定活跃模型；故障切换仅在同模型提供商之间进行。模型切换保留旧向量空间，需补建当前模型索引。设置页保存即热更新，支持单提供商测试与重建索引。未配置可用 embedding 时仍可上传、列表、详情和 grep；混合检索需要 embedding。

## 使用与验证

- `GET /health` 免认证；查看版本、数据库状态、embedding 与 warnings。
- `/v1/*` 均需 `Authorization: Bearer <token>`；Web 登录框填写同一 token。
- `GET /v1/help` 获取接口目录；任意接口附加 `?help=1` 查询参数和响应说明。
- 先用模拟会话验证上传，再查询列表、详情、grep 和搜索；生产会话不要用于公开截图或测试材料。
- 全量正文与工具产出走 `/v1/sessions/:id/full`；先查 `/full_length` 控制消费者上下文。

## 备份与安全

单用户、固定 token、明文会话存储；没有多租户隔离或自动脱敏。数据库可能包含工具输出中的密钥。限制配置、数据库、备份与日志的文件权限，跨网络使用 HTTPS。Embedding 提供商会收到被索引的正文与明文 reasoning，使用前确认其数据处理边界。

使用 SQLite 一致性备份或停止写入后复制数据库；不要在持续写入时直接复制文件作为一致快照。升级前备份；数据库迁移随启动执行。token 轮换后同步各采集端和消费 Skill。

本文按源码、配置校验器与脚本静态核对，不代表在所有平台完成从零部署验收。

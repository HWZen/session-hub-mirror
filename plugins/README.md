# 采集插件安装指南

所有命令从仓库根目录运行，先 `npm ci`。需要已安装对应宿主、Node.js 可从宿主进程 PATH 找到，以及可访问的 Session Hub 服务。安装目录需保持稳定，更新后重新构建并重启宿主。请先备份宿主配置，只合并所需条目。

## 通用连接配置

OpenCode、ZCode、Claude Code、Codex、WorkBuddy：环境变量 `SESSION_HUB_URL` / `SESSION_HUB_TOKEN` 逐字段优先于 `~/.config/session-hub/config.json`：

```json
{
  "baseUrl": "http://127.0.0.1:7428",
  "token": "<SH_AUTH_TOKEN>",
  "timeoutMs": 30000
}
```

上述地址仅为本地示例，远程部署替换为自己的 HTTPS 地址。文件必须保持私有。DSH 与 Hermes 配置来源见各节，不能假定所有插件使用同一套环境变量。缺少有效连接信息时插件跳过采集。

## OpenCode

前置：V1 官方插件事件 API，或 V2 `@opencode/plugin` / `@opencode/client` API；仓库 V2 开发依赖固定 2.0.26，其他版本需自行核对。

```sh
npm run install:plugin
# 自定义安装文件：
npm run install:plugin -- --target <absolute-plugin-file.js>
```

构建单文件默认安装到 `~/.config/opencode/plugins/session-hub.js`。V2 可使用项目级自动发现目录安装：

```sh
npm run install:plugin -- --target <project>/.opencode/plugins/session-hub/index.js
```

V2 也支持在 `opencode.json(c)` 的 `plugins` 数组合并插件目录路径；配置示例保留 `$schema: https://opencode.ai/config.json`，但该 schema 地址不用于推断 V2 字段。加载规则见 [V2 插件指南](https://opencode.ai/v2/docs/build/plugins)。在宿主检查已加载插件，避免同一插件重复安装，重启 OpenCode 后生效。

V1 用 idle/deleted 事件，V2 通过宿主适配器管理历史扫描、订阅、重连和删除；日志在 OpenCode 宿主日志，只有元数据。没有新建会话也可由 V2 启动扫描回填已有记录。

V1 SQLite 回填（V2 不使用此 CLI）：

```sh
npm run backfill -w @session-hub/opencode-plugin -- --dry-run
npm run backfill -w @session-hub/opencode-plugin -- --since <milliseconds>
```

默认只读 `~/.local/share/opencode/opencode.db`，可加 `--db <path>`；连接参数可由共享配置提供。先 dry-run，源库无需复制。支持源会话删除镜像。V1 对超限内容有截断，V2 超限暂停该会话同步并记录诊断。

## ZCode

```sh
npm run install:zcode-plugin
```

脚本构建并检查产物，不代替宿主注册。ZCode Settings → Plugin Management → Discover 添加仓库 `plugins/` 本地 marketplace（`marketplace.json`），启用 `session-hub`，新开会话。

hook 未生效时，检查 `.zcode-plugin/plugin.json` 的 hooks 路径；构建会生成 `dist/hooks-absolute.json` 本机绝对路径版本，可在本地配置使用。修改后新开会话。UserPromptSubmit / Stop 触发 detached worker，只读 SQLite 而非临时 transcript。

```sh
npm run backfill -w @session-hub/zcode-plugin -- --dry-run
npm run backfill -w @session-hub/zcode-plugin -- --since <milliseconds>
```

默认源库 `~/.zcode/cli/db/db.sqlite`，可加 `--db <path>`。跳过 subagent；日志 `~/.config/session-hub/logs/zcode-worker.log`；没有删除镜像。

## Claude Code

```sh
npm run install:claude-code-plugin
```

Claude Code 内执行（将路径替换为实际仓库路径）：

```text
/plugin marketplace add <repo>/plugins
/plugin install session-hub-collector@session-hub
```

名称来自 `plugins/.claude-plugin/marketplace.json`。开发时也可 `claude --plugin-dir <repo>/plugins/claude-code`。安装或改动后重启 Claude Code，审阅 hooks 权限。UserPromptSubmit / Stop / SessionEnd 读取可靠的 `transcript_path`，上传全量快照。

```sh
npm run backfill -w @session-hub/claude-code-plugin -- --dry-run
npm run backfill -w @session-hub/claude-code-plugin -- --since <milliseconds>
```

默认扫描 `~/.claude/projects/**/*.jsonl`，当前不采 subagent，无删除镜像；日志 `~/.config/session-hub/logs/claude-code-worker.log`。

## Codex

```sh
npm run install:codex-plugin
```

脚本仅构建、检查和提示，不写个人 marketplace。仓库提供 `.agents/plugins/marketplace.json`（本地 source 相对仓库根），插件目录为 `plugins/codex`，manifest 为 `.codex-plugin/plugin.json`，名称 `codex`。

在支持本地插件 marketplace 的 Codex 插件管理界面中添加仓库根目录作为本地 marketplace，选择 Session Hub 的 `codex` 插件安装；打开新任务的 `/hooks` 审阅和信任 Stop hook。若该版本界面只支持 Git marketplace，可添加此仓库的 Git 地址，并在其安装副本的插件目录构建产物。marketplace 字段与现有宿主清单静态核对；本会话未进行 Codex UI 安装验收。更新后重新构建安装副本并重启新任务。

```sh
npm run backfill -w @session-hub/codex-plugin -- --dry-run
npm run backfill -w @session-hub/codex-plugin -- --since <milliseconds-or-date>
```

`--codex-home <path>` 覆盖 `$CODEX_HOME`（默认 `~/.codex`），源为 `sessions/**/rollout-*.jsonl`；标题索引 `session_index.jsonl`。环境变量和共享配置提供连接信息，也支持显式 `--url` / `--token`（不要把真实 token 写入可公开的命令记录）。跳过 subagent，加密 reasoning 不生成可索引明文；无删除镜像。日志 `~/.config/session-hub/logs/codex-worker.log`。插件与 rollout 格式受宿主版本影响。

## Hermes

前置：支持 Shell hooks 的 Hermes、profile 的 `state.db`，以及 `better-sqlite3` 原生模块。

```sh
npm run build -w @session-hub/hermes-plugin
```

**连接配置优先使用 `SH_BASE_URL` / `SH_TOKEN`**，设置在启动 Hermes 的环境中。当前代码的文件兜底为特定 Windows profile 下的 Skill `config.json`，并非通用共享路径；通用安装用环境变量，勿假定 `SESSION_HUB_*` 生效。

在目标 profile 的 `config.yaml` 合并以下内容，替换插件与 profile 的绝对路径：

```yaml
hooks:
  post_api_request:
    - command: 'node "<repo>/plugins/hermes/dist/hook.js" --profile "<profile-home>"'
      timeout: 10
  on_session_end:
    - command: 'node "<repo>/plugins/hermes/dist/hook.js" --profile "<profile-home>"'
      timeout: 10
  on_session_finalize:
    - command: 'node "<repo>/plugins/hermes/dist/hook.js" --profile "<profile-home>"'
      timeout: 10
  on_session_reset:
    - command: 'node "<repo>/plugins/hermes/dist/hook.js" --profile "<profile-home>"'
      timeout: 10
```

在该 profile 的 `shell-hooks-allowlist.json` 的 `approvals` 数组中，为四个事件各合并一个 `{"event":"<event>","command":"<与上面完全相同的命令>"}`，保留其他审批。用 `HERMES_HOME=<profile-home>` 环境运行 `hermes hooks list` 检查，重启该 profile 的 Hermes 进程。

根 `install:hermes-plugin` 脚本当前针对固定 Windows profiles，且 worktree 下会转向主工作区插件路径；一般部署应采用上述手动安装步骤，不盲目执行。

```sh
npm run backfill -w @session-hub/hermes-plugin -- --profile <profile-home>
# 可指定单个会话：--session <session-id>
```

此 CLI 没有 dry-run / since / url / token 参数；只回填未归档会话。实时 hook 60 秒节流，结束事件强制上传，worker 日志在 `<profile-home>/logs/session-hub-hermes-worker.log`。无明文 reasoning 持久化，因此不索引该来源思考；无删除镜像。

## DSH（Cordis Host）

前置：DSH 的持久会话服务及 `subprocess` 插件启用，Node.js 在 Host 启动环境可用；当前适配根据 0.2.0-rc.2 开发。

```sh
npm run build -w @session-hub/dsh-plugin
```

在目标 profile 的官方 `plugin_manager` 中用 `install_bundle` 安装 `<repo>/plugins/dsh`（目录含 `package.json`、构建产物和 `cordis.patch.yml`），再启用 `session-hub-dsh`；模板默认 disabled。通过管理器确认依赖 seam 启用并刷新/重启 Host，不手改 profile 包文件。

配置逐字段来源：显式 Cordis Config → `~/.config/session-hub/config.json` 的 `baseUrl` / `token` / `machine` → 主机名仅兜底 machine。DSH 不从 `SESSION_HUB_*` 环境变量读取连接。可配置 `timeoutMs`、绝对 `workerCwd`、`reconcileOnStart`、`concurrency`（1..4）。缺省启动 reconcile 回填已有持久会话，当前没有独立 backfill CLI。

每轮结束先 flush 持久屏障，再读取完整 SessionEvent；包括普通、fork、subagent 独立会话。上传通过官方 subprocess 的 Node sidecar，payload/token 走 stdin。诊断在 Host 日志，按会话隔离队列失败；archive 不等于源删除，无删除镜像。

## WorkBuddy

见 [采集器安装指南](../apps/collector/README.md)。

## 共同验收与排障

1. `GET /health` 确认数据库正常；`warnings` 可能表示 embedding 未就绪。
2. 带 token 查询 `/v1/stats` 与 `/v1/sessions`，新建模拟会话完成两轮，确认同一三元组更新而非重复新建。
3. 查询 grep；配置 embedding 后再检查混合搜索与索引进度。
4. 401 核对 token；无法上传核对宿主加载路径、hook 信任、Node PATH、配置来源与网络。

不要以全部来源具有相同的删除、subagent 或回填行为为前提。这里只做源码和脚本静态核对；未验证的宿主安装入口按该版本能力确认。

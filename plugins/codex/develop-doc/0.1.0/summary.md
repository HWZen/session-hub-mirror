# 0.1.0 开发总结

## 实际改动

- 新增 Codex 插件兼容 manifest 与 `Stop` hook 配置，hook 通过 `PLUGIN_ROOT` 执行打包后的 Node.js 入口。
- 新增宽容 rollout JSONL 解析器：
  - 优先读取 `event_msg/item_completed` 的 `UserMessage`、`AgentMessage`、`Reasoning`、`CommandExecution`、`Extension`、`FileChange`。
  - 无高层对话流时回退 `response_item`，只接受 user/assistant message，过滤 developer/system 注入。
  - 支持坏行跳过、文件名 UUID 兜底、标题索引读取、时间戳归一、未知事件与加密 reasoning 统计。
- 新增 Session Hub 转换层：
  - 以用户消息为轮次边界聚合助手可见文本、reasoning 与工具事实。
  - reasoning 明文归一为 `{type:"reasoning", text, original}`；命令、扩展与文件修改归一为 tool raw；仅密文 reasoning 只保留原文而不生成可索引文本。
  - 限制 5000 条消息和单条 1 MB 文本，标题与 cwd 限制 2000 字符。
- 新增 hook/worker：入口只写入 `PLUGIN_DATA/queue` 并 detached 启动 worker；worker 在 2 秒内等待 transcript 稳定，读取全量快照后幂等上传，并始终清理队列 payload。
- 新增共享 Session Hub 配置读取与 Bearer `PUT /v1/sessions` 上传；未配置时静默跳过，日志只包含会话 id、路径外的统计和 HTTP 状态。
- 新增历史回填 CLI：支持 `--codex-home`、`--since`、`--dry-run`、`--url`、`--token`，按 source id 去重并跳过 subagent。
- 新增 esbuild 打包与安装说明脚本，根 npm build/test 编排接入 Codex 插件。
- 新增桌面端真实结构 fixture、Codex CLI `exec` 真实结构 fixture，以及 legacy `response_item` 兼容 fixture；覆盖解析、转换、配置、上传、hook、worker 与回填测试。

## 与计划的偏差

- 本机当前 CLI 与桌面端都提供 `item_completed` 高层流；legacy fixture 根据本机真实 `response_item` 字段脱敏组合，用于锁定无高层流时的兼容分支。
- `install.mjs` 不直接改写个人 marketplace 或 Codex 配置，只负责构建、检查产物并输出安装/信任步骤，避免仓库脚本隐式修改个人插件目录。
- 未自动执行安装后的 `/hooks` 人工信任和向真实 Session Hub 的上传。hook 信任必须由用户在新任务中审阅；真实上传会写入个人档案库。实现侧已用本地 HTTP 测试验证请求方法、鉴权和 payload，并对本机历史目录完成只读 dry-run。

## 测试与验收

- `npm test`：通过。
- `npm run build`：通过。
- `plugin-creator/scripts/validate_plugin.py plugins/codex`：通过。
- 打包 hook stdin 冒烟：输出 `{"continue":true}`。
- 本机历史回填 dry-run：5 个 rollout，3 个主会话，跳过 2 个 subagent，0 个无效文件。
- `npm audit` 报告仓库既有的 2 个 moderate 依赖问题，本版本未执行破坏性自动升级。

## 遗留事项

- 从本地 marketplace 安装插件，在新 Codex 任务的 `/hooks` 中审阅并信任 `Stop` hook。
- 配置真实 Session Hub 后完成两轮新会话实时更新与历史回填实跑验收。

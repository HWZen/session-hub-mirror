# WorkBuddy 采集器

当前实现是 WorkBuddy hook 和历史回填 CLI，不是常驻轮询守护进程；豆包适配器尚未实现。

## 安装与连接

先在仓库根目录 `npm ci`，Node.js/npm 必须可从 WorkBuddy 进程环境访问。按 [通用连接配置](../../plugins/README.md#通用连接配置) 设置共享 `config.json`；`SESSION_HUB_URL` / `SESSION_HUB_TOKEN` 逐字段优先。

在 `~/.workbuddy/settings.json` 合并 Stop 与 SessionEnd hooks，保留其他设置与 hooks。以下示例把 `<repo>` 换成实际绝对路径，Windows JSON 路径建议使用 `/`：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "npm --prefix \"<repo>\" run hook:workbuddy -w @session-hub/collector" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "npm --prefix \"<repo>\" run hook:workbuddy -w @session-hub/collector" }] }]
  }
}
```

新开 WorkBuddy 会话；如配置未加载，重启 WorkBuddy。hook stdin 提供 `transcript_path` 与会话信息，读取全量 JSONL 后同步等待上传，失败返回 0，避免把采集错误当成对话错误。启动 npm/tsx 会有开销，需关注宿主 hook 超时。

解析器从 `<user_query>` 提取用户内容、过滤系统注入，保留工具原文，reasoning 归一化；标题优先 `aiTitle`，时间取源消息或文件时间。

## 历史回填

```sh
npm run backfill:workbuddy -w @session-hub/collector
```

扫描 `~/.workbuddy/projects` 下 JSONL，连接来源同实时 hook；当前 CLI 没有 dry-run、since 或路径覆盖参数，执行即上传。可重复运行，三元组幂等覆盖。无删除镜像。

## 验证与排障

先查 `/health`，然后用模拟会话完成两轮，检查 `/v1/sessions` 中同一来源记录更新。日志 `~/.config/session-hub/workbuddy-hook.log`；诊断包括会话、路径、统计与 HTTP 状态，日志保持私有。

上传 401 核对连接信息；找不到 transcript 检查 hook payload 与宿主版本；reasoning 未入索引需核对源格式。可用根 `npm test` 与 `npm run build` 验证整合代码。本文按源码和脚本静态核对，宿主 hook 配置结构变化时以已安装版本为准。

# 元数据向量探针

比较纯正文、全字段 header 与仅标题 header 三种输入。`result.md` 为历史聚合结果，`queries.json` 为占位示例；实际运行须提供自己的私有语料。

- `SH_REMOTE_BASE_URL` / `SH_REMOTE_TOKEN`：自托管会话服务的连接信息。
- `SH_PROBE_SOURCE_IDS`：逗号分隔的语料 source id，保持私有；填写后才执行 fetch。
- `SH_PROBE_EMBED_URL` / `SH_PROBE_EMBED_MODEL` / `SH_PROBE_EMBED_KEY`：embedding 连接配置。
- `SH_PROBE_QUERIES_FILE`：指向仓库外的私有查询 JSON 文件；按 `queries.json` 示例格式填写，`target` 使用所选语料 source id，不修改仓库占位示例。

在安装依赖的仓库根运行 `npx tsx server/develop-doc/0.17.0/probe/probe.mjs fetch`，然后执行 `run`。`data/`、逐条结果及运行日志保持私有；历史聚合摘要不得被含私人语料的结果覆盖并提交。

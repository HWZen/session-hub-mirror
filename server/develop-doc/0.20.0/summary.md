# 0.20.0 — 开发总结

## 完成内容

- `GET /health` 新增 `db.size_bytes`，通过同一 SQLite 连接读取 `PRAGMA page_count` 与 `PRAGMA page_size` 并计算主数据库当前已分配大小。
- shared `HealthStatus` 契约同步新增 `db.size_bytes: number`。
- Web 格式化工具新增 `formatBytes()`，按 IEC 单位输出 `B / KiB / MiB / GiB / TiB`。
- Web「运行状态」页数据库卡片新增“占用空间”展示。
- health 测试覆盖 `size_bytes` 为正整数，并验证其严格等于测试数据库的 `page_count * page_size`。
- `server/package.json` 在开发基线中已为 `0.20.0`，无需再次修改。

## 数据库大小语义

`size_bytes` 表示 SQLite 主数据库文件当前分配的页总大小：

```
page_count * page_size
```

该值包含空闲页，不包含 TRUNCATE 模式下的临时 journal 文件，也没有新增文件系统路径访问或数据库连接点。

## 验证

本次改动通过 GitHub 连接器直接落库，当前执行环境不提供仓库命令执行能力，因此未实际运行根目录 `npm test` 与 `npm run build`。提交前已核对 API 类型、调用点与测试逻辑；合并前仍需在完整 Node.js 工作区执行这两条命令完成最终验证。

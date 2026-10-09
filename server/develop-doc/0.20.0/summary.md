# 0.20.0 — 开发总结

## 完成内容

- `GET /health` 新增 `db.size_bytes`，通过同一 SQLite 连接读取 `PRAGMA page_count` 与 `PRAGMA page_size` 并计算主数据库当前已分配大小。
- shared `HealthStatus` 契约同步新增 `db.size_bytes: number`。
- Web 格式化工具新增 `formatBytes()`，按 IEC 单位输出 `B / KiB / MiB / GiB / TiB`。
- Web「运行状态」页数据库卡片新增“占用空间”展示。
- health 测试覆盖 `size_bytes` 为正整数，并验证其严格等于测试数据库的 `page_count * page_size`。

## 数据库大小语义

`size_bytes` 表示 SQLite 主数据库文件当前分配的页总大小：

```
page_count * page_size
```

该值包含空闲页，不包含 TRUNCATE 模式下的临时 journal 文件，也没有新增文件系统路径访问或数据库连接点。

## 验证

- 根目录 `npm test`：通过，30 个测试文件、235 项测试全部通过。
- 根目录 `npm run build`：通过，TypeScript、插件与采集器类型检查、Web 生产构建均完成。

## 遗留事项

- 无。

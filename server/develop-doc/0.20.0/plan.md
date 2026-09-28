# 0.20.0 — 运行状态展示数据库占用空间

## 需求描述

在 Web「运行状态」页的「数据库」卡片中增加数据库占用空间（数据库大小），让用户无需登录服务器或检查文件系统即可直接看到当前 Session Hub SQLite 数据库的体积。

## 现状侦察

- `GET /health` 已返回数据库健康状态与 `journal_mode`：
  `db: { ok, journal_mode }`。
- Web `server/apps/web/src/routes/system.tsx` 的「数据库」卡片直接消费 `/health` 数据，目前展示：
  `journal_mode`、WAL 状态、数据库状态。
- 数据库连接统一由 `server/apps/server/src/db/connection.ts` 创建，使用 better-sqlite3，且按项目存储红线固定为 `journal_mode=TRUNCATE`。
- 当前没有通用字节大小格式化函数。

## 方案

### 1. 后端通过 SQLite PRAGMA 计算数据库大小

在 `/health` 中读取：

- `PRAGMA page_count`
- `PRAGMA page_size`

数据库大小定义为：

`size_bytes = page_count * page_size`

该值表示 SQLite 主数据库文件当前已分配的大小，包含空闲页，与用户从文件系统看到的主 `.db` 文件大小语义基本一致。

不通过 `fs.stat` 读取数据库路径，避免：
- 为 health 路由额外传递/暴露 DB 文件路径；
- 引入路径解析差异；
- 绕开现有统一数据库连接抽象。

TRUNCATE 模式下的临时 journal 文件不计入此值；本需求中的“数据库大小”明确指主 SQLite 数据库文件。

### 2. 扩展 health API 契约

`packages/shared/src/api.ts`：

```ts
db: {
  ok: boolean;
  journal_mode: string;
  size_bytes: number;
}
```

`server/apps/server/src/routes/health.ts` 返回 `db.size_bytes`。

### 3. Web 运行状态展示

在「数据库」卡片中增加一行：

- 标签：`占用空间`
- 值：按 IEC 单位自动格式化，例如：
  - `832 B`
  - `12.4 KiB`
  - `48.7 MiB`
  - `1.36 GiB`

格式化函数放在现有 `server/apps/web/src/lib/format.ts`，避免把格式化逻辑塞进页面组件。

### 4. 测试

扩展 `server/apps/server/test/health.test.ts`：

- `db.size_bytes` 为正整数；
- 可进一步验证其等于测试数据库的 `page_count * page_size`，避免字段仅存在但语义错误。

## 涉及文件

- `server/package.json`：版本 `0.19.1 → 0.20.0`
- `server/apps/server/src/routes/health.ts`
- `packages/shared/src/api.ts`
- `server/apps/server/test/health.test.ts`
- `server/apps/web/src/lib/format.ts`
- `server/apps/web/src/routes/system.tsx`
- `server/develop-doc/0.20.0/summary.md`（开发完成后新增）

## 任务清单

- [ ] health 路由计算并返回 `db.size_bytes`
- [ ] shared `HealthStatus` 同步新增字段
- [ ] 增加字节大小格式化函数
- [ ] 运行状态「数据库」卡片展示“占用空间”
- [ ] health 测试覆盖数据库大小
- [ ] 根目录 `npm test` 全绿
- [ ] 根目录 `npm run build` 全绿
- [ ] 写 `server/develop-doc/0.20.0/summary.md`
- [ ] 提交本版本开发改动

## 验收标准

1. 打开 Web「运行状态」页，可以在「数据库」卡片直接看到数据库占用空间。
2. 展示值使用易读单位，不直接暴露裸字节数。
3. `GET /health` 返回 `db.size_bytes`，其值为 SQLite 主数据库当前分配大小。
4. 不新增数据库连接点，不修改 WAL/TRUNCATE 等存储策略。
5. `npm test` 与 `npm run build` 全部通过。

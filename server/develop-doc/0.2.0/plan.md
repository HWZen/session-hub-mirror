# 0.2.0 — 版本号体系 + 开发 SOP

## 需求描述

1. 项目此前没有可感知的版本号：package.json 里 0.1.0 从未被消费，`/health` 与前端均不展示。
2. 建立"需求 → 计划 → 开发 → 提交"的开发 SOP：每个需求占一个版本号，规划阶段写
   `develop-doc/<版本号>/plan.md`，开发阶段（新会话）按 plan.md 落地后写 `summary.md` 并提交 commit。

## 方案

- 版本号唯一事实源：根 `package.json` 的 `version`；子包 version 不维护（npm workspace 私有包）。
- 服务端启动时从源码位置（`import.meta.dirname` 上溯三级，src/dist 同深度）读取根 package.json 的
  version，导出 `SERVER_VERSION`，`/health` 返回 `version` 字段。
- 前端侧栏底部常驻 `Session Hub v<version>`（复用 /health 查询缓存）；运行状态页"服务"卡片加版本行。
- SOP 写入 AGENTS.md（含目录结构、命令更新）。

## 涉及文件

- `apps/server/src/config.ts`（SERVER_VERSION）
- `apps/server/src/routes/health.ts`
- `packages/shared/src/api.ts`（HealthStatus.version）
- `apps/web/src/components/app-shell.tsx`（VersionFooter）、`apps/web/src/routes/system.tsx`
- `apps/server/test/health.test.ts`（新增）
- 根 `package.json`（0.1.0 → 0.2.0）
- `AGENTS.md`（开发 SOP、仓库结构、命令）
- `develop-doc/0.2.0/`（本文件 + summary.md）

## 任务清单

- [x] SERVER_VERSION 读取并暴露于 /health
- [x] 前端侧栏版本号 + 运行状态页版本行
- [x] health 测试（无需鉴权、版本格式、journal_mode）
- [x] 版本号 bump 0.2.0
- [x] AGENTS.md 写入开发 SOP
- [x] develop-doc/0.2.0 档案（本文件 + summary.md）

## 验收标准

- `npm test` + `npm run build` 全绿
- `GET /health` 返回 `version: "0.2.0"`
- 前端侧栏底部显示 `Session Hub v0.2.0`
- AGENTS.md 包含完整 SOP，后续需求按此流转

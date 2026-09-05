# 0.3.0 — 仓库重构：服务端子系统化

## 需求描述

后续将在本仓库开发各 Agent 的客户端插件（opencode 插件、采集器等），当前所有内容都平铺在根目录。
要求：把服务端相关内容（含版本号、develop-doc）收进 `server/` 子系统目录；根目录只留跨子系统的
全局资产（README.md、AGENTS.md、plan.md）。

## 方案

- 每个子系统自成一个子文件夹，自带 `package.json`（版本号事实源）+ `develop-doc/` + 运行时数据。
- 版本号事实源从根 package.json 迁移到 `server/package.json`（本版 0.3.0）。
- `packages/shared/` 留在根：它是跨子系统契约，未来插件/采集器共用。
- 服务端相对路径（SH_*、.env）改为以 `server/` 为根解析（`SERVER_ROOT` = config.ts 上溯三级，
  src/dist 同深度），与启动 cwd 无关。
- 根 package.json 变为纯编排层（private、无版本语义）：workspaces `packages/* server/apps/* plugins/* apps/*`，
  脚本带 server/ 路径；vitest include 改 `server/apps/**`；tsconfig references 更新。

## 涉及文件（移动）

- `apps/` → `server/apps/`（server、web）
- `config/` → `server/config/`；`data/` → `server/data/`（db、模型缓存、截图、日志）
- `develop-doc/` → `server/develop-doc/`
- `.env`、`.env.example` → `server/`

## 涉及文件（修改）

- 新增 `server/package.json`（version 0.3.0）
- 根 `package.json`（编排化）、`tsconfig.json`、`vitest.config.ts`、`.gitignore`
- `server/apps/server/tsconfig.json`（shared 引用路径）
- `server/apps/server/src/config.ts`（SERVER_ROOT / resolveServerPath）、`bootstrap.ts`、`index.ts`
- `AGENTS.md`（仓库结构、SOP 版本源改为各子系统、命令）、新增 `README.md`

## 任务清单

- [x] 目录搬移 + db 完整性校验（5 行 sessions、vec 表在）
- [x] 根编排（package.json / tsconfig / vitest）+ server/package.json
- [x] SERVER_ROOT 相对路径解析
- [x] .gitignore（server/config/*.local.json、server/data/）
- [x] AGENTS.md / README.md
- [x] npm install 重生成 lockfile；npm test + npm run build 全绿
- [x] 服务端重启实测：/health v0.3.0、journal truncate、SPA、settings API

## 验收标准

- 根目录只剩：README.md、AGENTS.md、plan.md、.gitignore、npm 编排文件、packages/shared
- `GET /health` 返回 `version: "0.3.0"`（来自 server/package.json）
- 从任意 cwd 启动服务端，SH_* 相对路径均解析到 server/ 下

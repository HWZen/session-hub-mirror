# 0.3.0 summary — 仓库重构：服务端子系统化

## 实际改动

- 目录搬移（同卷 rename）：`apps/`→`server/apps/`、`config/`→`server/config/`、`data/`→`server/data/`、
  `develop-doc/`→`server/develop-doc/`、`.env(.example)`→`server/`。
- 新增 `server/package.json`：`session-hub-server` v0.3.0，服务端版本号唯一事实源。
- 根 `package.json` 编排化：private、无 version 字段，workspaces `packages/* / server/apps/* / plugins/* / apps/*`，
  脚本带 `server/` 路径；lockfile 重新生成（npm install）。
- 根 `tsconfig.json` references → `server/apps/server`；`server/apps/server/tsconfig.json` 的 shared 引用
  改 `../../../packages/shared`；`vitest.config.ts` include 改 `server/apps/**`。
- `server/apps/server/src/config.ts`：新增 `SERVER_ROOT`（import.meta.dirname 上溯三级，src/dist 同深度）
  与 `resolveServerPath()`；`bootstrap.ts` / `index.ts` 的 SH_DB_PATH、providers 文件、模型缓存、web dist
  全部经它解析——相对路径一律锚定 `server/`，与启动 cwd 无关。
- `.gitignore`：`server/config/*.local.json`、`server/data/`。
- `AGENTS.md`：仓库结构（子系统化）、SOP 版本源改为"各子系统 package.json"、命令说明补 cwd 无关语义。
- 新增 `README.md`（定位、结构、快速开始、文档索引）。

## 与计划的偏差

- `packages/shared/` 未搬入 server/：它是跨子系统契约，未来插件/采集器共用，留在根（与 AGENTS 规划树一致）。
- 搬移时运行中的服务端锁住 `data/session-hub.db` 导致目录拆成两半，已合并并用只读连接校验
  （5 条 sessions、vec 表齐全）；拆分期间 SQLite 在新路径重建过 journal 头（journal_mode 曾短暂为 delete），
  服务端重启后 createDb 统一设回 TRUNCATE，/health 实测 truncate。
- 根目录遗留的临时脚本 `check-web.tmp.mjs` 已删除。

## 测试 / 验收结果

- `npm test` 40/40 通过；`npm run build`（tsc -b + web vite build）通过。
- 服务端重启后实测：`/health` → `version: 0.3.0`、`journal: truncate`、`db ok: true`；`/v1/sessions` 4 条；
  settings API 读 `server/config/providers.local.json`；SPA 正常（`/` 返回 index.html）。
- Edge 截图：侧栏 `Session Hub v0.3.0`、提供商卡显示新配置路径（server/data/shots/settings-030.png）。

## 遗留事项

- 仓库仍零提交：0.1.0 基线、0.2.0（版本号+SOP）、0.3.0（本次重构）建议拆 3 个 commit 首次提交，
  等用户确认后执行。
- .env 现位于 `server/.env`（gitignore）；NSSM 部署时 cwd 任意均可（路径已 cwd 无关）。

# 0.2.0 summary — 版本号体系 + 开发 SOP

## 实际改动

- `apps/server/src/config.ts`：新增 `SERVER_VERSION`（`import.meta.dirname` 上溯三级读根 package.json，
  src 与 dist 深度相同故路径一致；读取失败回退 "0.0.0"）。
- `apps/server/src/routes/health.ts`：`/health` 响应增加 `version: SERVER_VERSION`。
- `packages/shared/src/api.ts`：`HealthStatus` 增加 `version: string`。
- `apps/web/src/components/app-shell.tsx`：侧栏底部新增 `VersionFooter`，复用 `["health-badge"]`
  查询缓存显示 `Session Hub v<version>`；折叠时收起文字。
- `apps/web/src/routes/system.tsx`：运行状态"服务"卡片增加版本行（v0.2.0，等宽字体）。
- `apps/server/test/health.test.ts`：新增（/health 无需鉴权、版本号格式、journal_mode=truncate）。
- 根 `package.json`：version 0.1.0 → 0.2.0。
- `AGENTS.md`：新增「开发 SOP（需求 → 计划 → 开发 → 提交）」章节（版本号规则、两阶段流程、
  develop-doc 档案、commit 规范）；仓库结构补 `apps/web/` 与 `develop-doc/`；命令章节更新为实际脚本。

## 与计划的偏差

- 无。本版本是 SOP 的引导版本，plan.md 与 summary.md 为事后补立（SOP 生效前的存量需求），
  自 0.3.0 起严格走"规划会话写 plan → 开发会话出 summary + commit"两阶段。

## 测试 / 验收结果

- `npm test`：40/40 通过（新增 health 1 例）。
- `npm run build`：tsc -b + 前端构建通过。
- 实测：`GET /health` → `version: "0.2.0"`；Edge 渲染侧栏底部 `Session Hub v0.2.0`
  （data/shots/settings.png）。

## 遗留事项

- 仓库尚未有任何 git commit：0.1.0 存量（P1 服务端 + Web 前端 + 系统设置）与 0.2.0 需一并首次提交，
  建议拆两个 commit（基线 / 版本号+SOP），待用户确认后执行。
- 提供商密钥语义：UI/API「留空=保留旧密钥」，不支持"清空密钥"（可换 key 或停用提供商替代）；
  本次清理测试密钥时直改 providers.local.json 规避，后续如有真实需求再加显式清除。

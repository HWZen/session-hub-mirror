# 0.1.1 — 插件从未加载成功：安装产物改为纯 JS 打包（PATCH 修复）

> 全局决策见根 `plan.md`；本档不推翻任何全局决策，只修 0.1.0 的一个错误事实假设。

## 需求描述（缺陷）

用户反馈插件不生效，会话没有自动上传。排查确认：**插件自 0.1.0 交付起从未被 opencode 加载过**，服务端里的 132 条 opencode 会话全部来自 backfill 手动回填。

## 排查过程与根因（2026-09-06 实测）

1. `~/.local/share/opencode/log/opencode.log` 全量检索，从未出现任何 `session-hub` 插件日志（enabled / sync / not configured 均无）→ 插件从未初始化。
2. 0.1.0 plan 的侦察事实写的是"全局插件目录直接加载 TS/JS 单文件（**Bun 运行时**，类型擦除执行）"。该假设只对 opencode CLI（Bun 打包的单文件二进制）成立；**桌面版 `@opencode-aidesktop` 内嵌的 opencode server 跑在 Node 上**（日志堆栈 `app.asar/out/main/chunks/node-*.js` + `node:internal/*`，且 opencode 源码对 `$` 钩子有 `typeof Bun === "undefined"` 判断）。
3. opencode 1.18.11 源码（`plugin/loader.ts`）：本地插件是裸 `await import(file://...)`，**无任何转译步骤**。安装脚本只是把 `src/plugin.ts` 原样拷成 `session-hub.js` —— `.js` 后缀里的 TS 语法（`interface`/`import type`）Node 直接语法错误。实测 Node 26 动态 import 该文件：`SyntaxError: Unexpected token '{'`。加载失败只会发一条 session error 事件，界面上几乎无感，日志里也看不到。
4. 次要缺陷：即使能解析，1.18.11 的 legacy 加载路径会遍历模块**所有导出**——非函数导出（`AGENT_ID` 字符串）直接抛 `Plugin export is not a function`；每个导出函数还会被当插件工厂各调一次（首个抛错则整个文件加载失败）。`plugin.ts` 导出的一堆 helper（transformSession 等）全踩雷。

## 方案

- 新增 `src/entry.ts`：插件加载入口，只导出 `sessionHubPlugin`（named + default 同一引用，legacy 去重后仅注册一次）。
- `scripts/install.mjs` 从"原样拷贝 TS"改为 **esbuild 打包**：`entry.ts --bundle --format=esm` 输出纯 JS 单文件到 `~/.config/opencode/plugins/session-hub.js`（类型已擦除、helper 内联、无多余导出），Bun（CLI）与 Node（桌面版）均可加载。
- esbuild 仅作 plugins/opencode 的 devDependency（构建期），产物零运行时依赖（`node:*` 与全局 fetch）。
- `plugin.ts` 本体不动（仍是 typecheck/测试/backfill 的源）。

## 涉及文件

```
plugins/opencode/
  src/entry.ts               # 新增：唯一插件入口
  scripts/install.mjs        # 改为 esbuild 打包安装
  package.json               # version 0.1.1；devDeps 加 esbuild
  develop-doc/0.1.1/         # 本档
根 package.json              # install:plugin 指向不变，无需改
```

## 任务清单

- [ ] entry.ts + install.mjs + package.json
- [ ] npm install 接线 esbuild，执行安装
- [ ] 验证：Node 直接 import 安装产物可解析、导出形状正确
- [ ] 验证：opencode CLI（Bun 运行时）端到端——新会话 idle 后服务端可见
- [ ] 根 npm test + npm run build 全绿
- [ ] summary.md（含"用户需重启桌面版 opencode"提醒）

## 验收标准

1. `node --input-type=module -e "import('file://...session-hub.js')"` 成功，`mod.default` 为函数
2. opencode CLI 跑一个临时会话 → `GET /v1/sessions?agent=opencode` 出现该会话，且后续轮次 updated_at 前进
3. 根 `npm test` + `npm run build` 全绿
4. 安装产物为纯 JS（无 interface/import type 等 TS 语法），仅导出插件函数

## 风险与对策

| 风险 | 对策 |
|---|---|
| opencode 未来版本改插件加载方式 | 产物同时满足 V1 检测路径与 legacy 路径（只导出函数）；升级后回归验收 2 |
| esbuild 版本与 root allowScripts 不一致 | 锁 ^0.28.2 与 allowScripts 对齐 |

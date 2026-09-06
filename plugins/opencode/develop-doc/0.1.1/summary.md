# 0.1.1 Summary — 插件从未加载：安装产物改为纯 JS 打包

## 实际改动

- `src/entry.ts`（新增）：插件唯一入口，只导出 `sessionHubPlugin`（named + default 同一引用）。
- `scripts/install.mjs`：由"原样拷贝 TS 源码"改为 esbuild 打包（`bundle + format=esm + platform=neutral`，`node:*` external），输出纯 JS 单文件到 `~/.config/opencode/plugins/session-hub.js`。
- `package.json`：version 0.1.0 → 0.1.1；devDependencies 加 `esbuild ^0.28.2`（与根 allowScripts 对齐）；新增 `install:plugin` 脚本。
- `~/.config/opencode/package.json` 加 `"type": "module"`（机器侧顺手修复：消除 Node 对 typeless `.js` 的 CJS 重解析开销，非仓库文件）。
- `src/plugin.ts` 本体未动（typecheck / 单测 / backfill 继续以它为源）。

## 根因（与计划一致，补充实锤）

0.1.0 的侦察假设"插件目录直接加载 TS/JS 单文件（Bun 运行时，类型擦除）"只对 opencode CLI 成立。桌面版 `@opencode-aidesktop` 内嵌 server 跑在 **Node** 上，1.18.11 `plugin/loader.ts` 对本地插件是裸 `import(file://...)` 无转译 ⇒ `.js` 里的 TS 语法直接 `SyntaxError`，插件从未加载过（实测 Node 动态 import 报 `Unexpected token '{'`）。服务端 132 条 opencode 会话全部来自 backfill 手动回填，与用户判断一致。次要隐患：legacy 加载器遍历全部导出，`AGENT_ID` 非函数导出会抛错、helper 函数会被当插件工厂误调——入口收窄为单一函数导出后一并消除。

## 与计划的偏差

- 无实质偏差。entry.ts 相对 import 按 NodeNext 规范写成 `./plugin.js`（typecheck 要求，esbuild 兼容）。
- 验证方式：原计划直接用 opencode CLI 验收；实际发现 `opencode run` 短命进程在流结束后立即退出，3s debounce 计时器必然来不及触发（见遗留事项）。改用 `opencode serve`（长驻，`OPENCODE_SERVER_PASSWORD` 认证）通过 HTTP 建会话 + 发消息完成端到端验收。

## 测试 / 验收结果

- 根 `npm test`：13 文件 88 用例全绿；`npm run build` 全绿（含插件 typecheck）。
- 安装产物 `node --input-type=module -e "import(...)"` 加载成功，导出仅 `default` 与 `sessionHubPlugin`（同一函数）。
- 端到端（serve 实例，cwd 临时目录）：HTTP 建会话 `ses_synthetic00000000000000001` → 发消息 → idle + 3s debounce → `session-hub: sync ... status=201 messages=2`；session-hub 服务端可查到该会话（title「要求只回复ok」，message_count=2）且后台已自动向量化索引。
- 桌面版今晨启动实例（run=bbfbd37a）日志已出现 `session-hub: enabled`，新插件在桌面版生效；本会话随对话推进即自动同步。

## 遗留事项

1. **`opencode run` 短命进程会漏最后一拍**：进程在 idle 事件后 3s debounce 内退出，最终快照传不上去。候选方案（后续版本）：监听 `dispose` 钩子在退出前冲刷 pending 同步，或 idle 即传 + `session.updated` 再补。
2. 桌面版启动时同一 run 出现两条 `session-hub: enabled`（疑为多目录实例各一）；因服务端按 `agent+machine+source_id` 幂等 upsert，重复同步无害，暂不处理。

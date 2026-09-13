# 0.18.1 完成记录

## 实际改动

| 文件 | 改动 |
|---|---|
| `server/package.json` | version 0.18.0 → 0.18.1 |
| `server/apps/web/src/routes/search.tsx` | 第二行过滤区四个日期 `Input` 外包 `<div className="w-36">` 并去掉失效的 `w-36` 类；「创建」「更新」各自与组内日期框、`–` 分隔符包进 `flex items-center gap-2` 组，防止标签与日期框被 `flex-wrap` 拆散 |
| `AGENTS.md`（仓库根） | worktree 工作流：新建分支/worktree 的版本号末位填 `x`（如 `0.19.x-server-dev`），一条 MINOR 线内的补充/修补不新建；SOP 规划阶段的 PATCH 条目同步说明 |

## 与计划的偏差

无。实现与 plan.md 方案一致。

## 测试 / 验收结果

- `npm test`：30 文件 / 230 用例全部通过。
- `npm run build`：`tsc -b` + 三个插件 typecheck + web（`tsr generate && tsc --noEmit && vite build`）全绿；CSS 产物 hash 不变（`w-36`/`flex` 等类已存在），JS 产物更新为 `index-BpnrYPs9.js`。
- Edge 有头实测（本地 7429，构建产物）：
  - 修复前：四个日期框各 768px 整行宽，「创建」「更新」「–」孤立在行间。
  - 修复后：四个日期框均 144×36；「创建」（y=252）与创建起止日期、「更新」（y=296）与更新起止日期各在同一行，`–` 位于两框之间；「创建」不再像失效按钮。
- 未执行项：运行中的 dev 服务端（PID 24768，tsx watch）不监听 `server/package.json`，页脚/`/health` 仍显示 0.18.0，服务端下次重启后即为 0.18.1。

## 遗留事项

- `lib/cn.ts` 只做字符串拼接、不做 Tailwind 冲突合并，基础类 `w-full`/`h-9`/`text-sm` 会压过调用处传入的 `w-36`/`h-8`/`text-xs`（全站过滤控件的 `h-8 text-xs` 实际均未生效，渲染为 h-9）。本版按既有「定宽容器」写法绕过；若要根治，后续可评估引入 tailwind-merge 或统一改为容器定宽。
- 窄屏下过滤行仍由 `flex-wrap` 按组换行（「创建」组与「更新」组可能分别折行），属预期。

# 0.2.0 Summary — OpenCode V1 / V2 单产物兼容

同一份纯 JS ESM bundle（`dist/session-hub.js`，SHA256 `dd320d0b1096c38ffb67e5059310f7dac2244ab78bae6ce7b6a74ac1dd337a1c`）
在本机 V1 fork 与官方 V2 2.0.26 两侧真实宿主上加载，V1 行为回归通过、V2 会话同步恢复并完成 mock-only 隔离验收。

## 实际改动

- `src/adapter-v2.ts`（新增）：V2 适配。事件词表按宿主实际发布修订（`session.execution.succeeded/failed/interrupted`、`session.status[idle]` 兼容、`session.deleted`）；显式连接配置（`endpoint` 仅 loopback + 可选 Basic auth）与同实例能力校验（版本/PID/插件来源）；`@opencode/client` 分页读全量历史；无损映射（assistant 原序 content 顶层进 raw、明文 reasoning 归一 `{type:"reasoning",text}`、完整源消息 envelope、synthetic 不进入 text）；超限（5000 条/100 万字符/标题/cwd 2000）时不截断、告警并暂停该会话；删除 tombstone 与在途上传/删除竞争处理。
- `src/entry.ts`：唯一入口改为 default 双支持定义（`{...define({id:"session-hub",setup}), server}`），消除 helper 导出误加载面。
- `src/plugin.ts`：V1 侧仅加固不改语义 —— 上传/列表/删除全链路支持 `AbortSignal`、dispose 中止在途请求并等待收尾、删除镜像等待在途上传、读取期间重复 idle 合并（rerun）、错误只记状态与统计。
- `scripts/build.mjs`（新增）与 `scripts/install.mjs`：构建与安装分离；`dist/session-hub.js` 为唯一产物；安装支持显式 `--target`（默认仍是用户插件目录），测试/构建不隐式写现役目录。
- `scripts/qualify-host.ts` + `test/helpers/qualification.ts`（新增）：隔离宿主资格验证（loopback 连通、非 loopback 拒绝、Job 约束、环境根越界检查）。
- `test/`（新增）：`v2-adapter`(32) / `v2-connection`(20) / `v2-history`(6) / `v2-runtime`(2) / `v2-sdk-integration`(4) / `v1-lifecycle`(9) / `build`(3) / `entry`(2) / `qualification`(32)；`upload.test.ts` 补响应体生命周期与中止用例。
- 根 `package.json`：`build` 编排纳入插件 bundle 构建（`npm run build -w @session-hub/opencode-plugin`）。
- `v1-lifecycle.test.ts` 覆盖此前遗留的 dispose 冲刷/中止、删除竞争不复活等 V1 长尾。
- `package.json`：`0.1.1 → 0.2.0`，新增 `@opencode/client`、`@opencode/plugin` 2.0.26 受控依赖。

## 与计划的偏差及原因

1. **验收设施以实际在用为准**：计划 §6.1 引用的旧交接目录（`opencode-network-isolation`）已由 Leader 停用；本版验收使用同构的新隔离包 `session-hub-opencode-v2-isolation`（防火墙规则组 `Hermes-OpenCode-Isolation-v2-20261013`，验收期间保持启用），launch_isolated.py / V1、V2 隔离副本 / deployed-before.json 均取该包。
2. **"单次 idle 恰好 1 次 PUT" 的 V2 语义修订**：V2 宿主按 location 各实例化一份插件，同一完成信号会被每个实例各同步一次（服务端按 `agent+machine+source_id` 幂等 upsert 消化，无数据损坏）。A9 断言改为"PUT 数不随 reload 增长"（以运行中实测基准为准，本次 3→3→3）。V1 桌面端在 0.1.1 已记录同类多实例现象。
3. **A11-2 断言改为"本次运行前后现役摘要不变"**：现役 `session-hub.js` 在本轮开发前已被替换为 0.2.0 产物，而隔离基线（11:32 生成）仍是替换前摘要；运行器现同时记录与基线的差异（本次 `matchesIsolationBaseline=false` 属预期，证据在报告 cleanup 字段）。
4. **运行器工具修复**（验收期发现的工具缺陷，非插件行为）：删除会话改用 V2 客户端实际 API `session.remove`；事件采集改为带连接重试的直连 `/api/event` SSE（原 SDK 订阅在宿主端口就绪前发起，首连失败被静默吞掉，导致事件为 0、debounce 计时失真）；全量模式补 30 分钟总预算；证据目录的 `host-live.log` 在运行开始截断，避免跨运行追加混入。

## 测试与验收结果

- 根 `npm test`：61 文件 / 504 用例全绿；根 `npm run build` 全绿（含插件 bundle 生成）。
- 单产物验证：Node ESM 直接 import 成功，仅 default 导出，`id=session-hub`，`server`（V1）与 `setup`（V2）双形态；仅 4 个 `node:` 内建 external，无宿主侧额外安装要求。
- **V2 全量 E2E（opencode-v2-isolated.exe 2.0.26）：30/30 全绿**。数据点：事件 912（35 类，含执行终态、删除、compaction 全链）、模型调用 74、PUT 22、镜像记录 1；长历史 215 条 / 3 页在单次快照中逐条一致；compaction + synthetic + reasoning + tool 覆盖齐全；删除与在途上传竞争不复活；上传 500 可诊断且插件保持 active；reload 前后 PUT 数 3/3/3 不增长并回归规范 SHA。
- **V2 smoke（执行终态→PUT→字段保真→删除）：20/20 全绿**。
- **V1 全量 E2E（opencode-v1-isolated.exe）：37 断言 35 通过**，2 项失败为宿主二进制环境性阻塞（`2.model-round-status`、`3.tool-part-coverage`，根因 `MODEL-ROUND-UNREACHABLE`：宿主在组装系统提示时抛 `TypeError`，与插件无关，见 `e2e-v1/report.json` blockers）；结果 `green-except-environmental-blockers`。本次新增的 abort/dispose/delete/reload 用例在 V1 全部通过。
- 现役未触碰：三个部署文件运行前后 SHA 一致；宿主/mock/沙箱全部清场（hostExited、mockClosed、sandboxRemoved 均为 true）。

## 验收命令（worktree：`.worktrees/0.2.x-opencode-plugin-dev/plugins/opencode`）

```
npx tsx scripts/acceptance/e2e-v2.ts C:/Users/example-user/miniconda3/python.exe            # V2 全量
npx tsx scripts/acceptance/e2e-v2.ts C:/Users/example-user/miniconda3/python.exe --smoke   # V2 smoke
npx tsx scripts/acceptance/e2e-v1.ts                                                    # V1 全量
```

证据目录：`develop-doc/0.2.0/e2e-v2/`、`e2e-v2-smoke/`、`e2e-v1/`（report.json 为断言与清场事实源）。

## 遗留事项

1. **V1 宿主 exe 需重建后复跑两项阻塞断言**（`SystemPrompt.environment` TypeError，超出本版授权范围；修复后用同一运行器复跑即可）。
2. `plugin.updated` 事件在 A9 观测窗口内未出现（`reloadSeenAt=null`）；reload 检测以 PUT 数稳定性与文件 SHA 回归为实质判据，如需直接事件证据可在后续版本用 `plugin.check/list` 轮询补强。
3. 多 location 多实例重复上传为宿主语义、服务端幂等；如需去重（跨实例协调）属后续需求评估。
4. **现役部署已完成（2026-10-13，用户批准后执行）**：`~/.config/opencode/plugin-packages/session-hub/`（目录包，`index.js` 为本版产物 SHA）＋ `opencode.jsonc` 的 `plugins: [{ package: "./plugin-packages/session-hub", options: { endpoint: "http://127.0.0.1:49374", auth: { password } } }]`（端点为本机桌面服务的固定端口 0xC0DE=49374，密码取自 `~/.local/state/opencode/service.json`，不入库）。旧单文件与旧配置备份在 `~/.config/opencode/plugin-backups/`。配置修改经宿主热加载生效（无需重启）。现役验证：临时真实会话完成上传（201→200）与删除镜像同步删除。若以后桌面服务端口变化（`opencode service status` 可查），需同步更新配置中的 endpoint。
5. 隔离设施（防火墙规则组与两个隔离副本）待 Leader 完成独立验收后按交接流程清理。

# 0.12.0 Summary — 服务端优雅停止

## 实际改动

- 新增 `apps/server/src/shutdown.ts`：
  - `createShutdownRunner(deps)`：核心 runner，deps = `{ server, autoIndexer, db, exit }`（exit 可注入）。
    执行序列幂等（重复调用复用同一 promise）：停机日志（信号名/连接数/耗时，只打元数据）→
    `autoIndexer.stop()` → `server.closeIdleConnections()` → `server.close()` 排水
    （race `REQUEST_DRAIN_TIMEOUT_MS=10s`，超时 `closeAllConnections()` 强断）→
    `autoIndexer.whenIdle()` race `INDEX_GRACE_MS=2s`（超时放弃，未落库向量下次启动重算）→
    `db.close()`（try/catch，失败继续）→ `exit(0)`；序列中途意外抛错 → `exit(1)`
  - `installGracefulShutdown(deps, proc=process)`：SIGINT / SIGTERM / SIGHUP / SIGBREAK 注册同一 runner，
    第二次信号立即 `exit(1)` 强杀兜底；proc 可注入（单测不污染真实 process）
- `auto-index.ts`：新增 `whenIdle()`——返回在途 round 的 promise（`#inflight` 跟踪 `#loop()`），
  无在途立即 resolve；`start()`/`kick()`/`stop()` 行为不变
- `index.ts`：接住 `serve()` 返回值（cast 为 `http.Server`，未启用 http2），调 `installGracefulShutdown`
- 新增 `apps/server/test/shutdown.test.ts`：runner 单元（fake 依赖）7 例 + 信号注册层 1 例 +
  进程内集成 2 例；`auto-index.test.ts` 补 `whenIdle` 2 例
- 远端部署资产（不入库）：`~/apps/session-hub/stop.sh` 重启停机路径改为
  kill → 轮询等待退出（30 × 0.5s ≈ 15s）→ 超时 `kill -9` 兜底；原脚本备份为 `stop.sh.bak-0.11`
- `server/package.json` version 0.10.0 → 0.12.0（规划阶段已改）

## 与计划的偏差

1. **`-journal` 断言修正**：实测证实 `journal_mode=TRUNCATE` 下 SQLite 在干净关闭后仍保留
   **0 字节占位** journal 文件（TRUNCATE 模式的持久化行为，非残留垃圾）；只有硬杀在途写入才会留下
   非 0 热日志。验收标准"db 无 -journal 残留"落地为"journal 必须为 0 字节"，
   测试与两次实测均按此断言。plan 侦察中"正常关闭本应清理的 -journal 文件会残留"的说法
   按此理解修正：文件存在但内容必为空。
2. **Windows Ctrl+C 人工实测未按原方式完成**：自动化环境无法合成真实按键（键盘注入被宿主策略拦截，
   ConPTY 注入 CTRL_C_EVENT 不可达）。改用**真实控制台标签页关闭**（CTRL_CLOSE_EVENT → Node SIGHUP，
   本版注册的信号之一）完成一次 Windows 本地实测：停机序列日志完整、端口停止接受连接、
   journal 0 字节。SIGINT 按键路径由单元测试覆盖注册集合，真机按键实测**留给用户**（用户已确认自测）。
3. **WSL1 实测用隔离环境而非生产**：0.12.0 dist 拷贝到远端 `/tmp/sh0120-test`（复用生产 node_modules，
   `packages/shared` 自 0.6.0 未变更、无 drift），端口 5329 + 独立 db，不触碰生产进程。
   远端 stop.sh 更新后未在生产执行（仅语法校验），下次部署重启时自然生效。
4. **用户反馈（设计输入）**：Ctrl+C 属人工兜底路径，非主要停机方式；生产自动化停机未来可能走
   shutdown/restart 接口。当前 plan 决策"不做 POST /v1/shutdown 端点"未改，此观点记录在案，
   若要改决策先改根 `plan.md`。
5. **误杀说明**：清理本地旧测试实例时用过一次 `taskkill /F /IM node.exe`（按镜像名杀掉了本机 5 个
   node 进程），可能波及用户其他 node 进程；此后均按 PID 精确操作。如发现本机其他 node 程序异常，
   大概率源于此。

## 测试 / 验收结果

- `npm test` 全绿：19 文件 139 用例（含新增 12 例）
- `npm run build` 全绿（tsc -b + 插件 typecheck + 前端构建）
- 远端 WSL1（4.4.0-19041-Microsoft）SIGTERM 实测 ✅：
  `[shutdown] begin signal=SIGTERM` → `open connections=0` → `done in 2ms` → `EXITCODE=0`，journal 0 字节
- 本地 Windows 真实控制台关闭（SIGHUP）实测 ✅：`begin signal=SIGHUP` → `done in 2ms`，
  端口 connection refused，journal 0 字节（日志含 `EXITCODE` 行未打印属预期：cmd 随控制台同亡，
  `done` 行之后即 `exit(0)`，且进程确已退出、无 sequence error 日志）
- 在途请求排水、幂等、双信号强杀、两类超时、db.close 失败不阻断等路径由单元 + 进程内集成测试覆盖

## 遗留事项

- 用户自测 Windows Ctrl+C（`npm run dev` 或 `node apps/server/dist/index.js` 真机按键）
- 0.12.0 未部署生产（远端代码仍为 0.10.x，stop.sh 新逻辑对旧代码前向兼容——kill 后等 15s 再 kill -9）；
  部署按 README 更新流程：push → pull + npm ci + better-sqlite3 GLIBC 重建 + build → stop.sh + start.sh
- 未来 NSSM 化（P4）注意 AppStopMethodConsole 默认 1.5s：优雅退出常规路径 ~ms 级，可满足；
  若担心排水 10s 上限场景，届时调大该参数
- worktree 运行环境初始化记录：worktree 缺 node_modules，已在 worktree 根 `npm install --ignore-scripts`
  后从主工作区拷贝 `better-sqlite3/prebuilds/`（主工作区该包 gyp 编译在 worktree 内不可复现）；
  `server/.env` 已建（PORT=7429、worktree 本地 data 目录）

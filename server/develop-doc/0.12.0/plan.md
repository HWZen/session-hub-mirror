# 0.12.0 服务端优雅停止

## 需求描述

用户提问：server 是不是没法优雅停止？——侦察确认：**是，现状完全没有任何停机处理**。
本版需求：停止信号（Ctrl+C / kill）触发有序退出——停止接受新请求 → 在途请求收尾 →
停后台索引 → 关闭 DB → 退出码 0。任何阶段超时强断兜底，绝不挂死。

## 侦察事实（2026-09-06）

- `apps/server/src/index.ts`：`serve()` 返回的 http.Server 被丢弃；全文件无 `process.on`；
  无 `db.close()`、无 `autoIndexer.stop()`。任何停止信号 = Node 默认行为，进程立即终止
- `auto-index.ts`：有 `stop()` 但无人调用；且只清定时器，不等在途索引 round（`#loop` 的 promise 没有暴露）
- DB：从不 `db.close()`。journal_mode=TRUNCATE + synchronous=FULL 保证硬杀后下次打开回滚热日志、
  数据不损坏；但正常关闭本应清理的 `-journal` 文件会残留，在途写入被打断浪费
- 索引流程 crash-safe：`indexSession` 的 `storeEmbeddings`/`setIndexed` 是同步事务
  （单事件循环回合内完成，信号回调在回合之间执行，不会打断事务）；可能被打断的只有
  `await embed()` 网络阶段——放弃无损失，会话仍在未索引集合，下次启动 `listUnindexed` 续跑
- 在途 HTTP 请求被硬掐（客户端见连接重置）。插件上报是幂等 upsert 可重试，但体验差
- 生产形态（0.10.0 定稿）：远端 WSL1 `nohup node apps/server/dist/index.js`，
  `start.sh` 重启 = `kill` + 重跑；`kill` 默认发 SIGTERM → **现在每次重启都是硬杀**
- 未来 NSSM（P4，暂缓）：stop 时向控制台发 Ctrl+C（Node 收到 SIGINT），默认只等 1.5s
  （AppStopMethodConsole）就 TerminateProcess——优雅退出必须在时限内完成，或届时调大该参数
- Windows 信号现实：SIGINT（Ctrl+C）/ SIGBREAK（CTRL_BREAK）/ SIGHUP（关控制台）可被 handler 捕获；
  SIGTERM 只有本机 Node `process.kill` 模拟可触发 handler（WSL1 里 `kill` 是真 SIGTERM，可捕获）

## 方案

新增 `apps/server/src/shutdown.ts`，核心逻辑与信号注册分离，保证可测试：

1. **shutdown runner**（核心，可注入依赖）：`createShutdownRunner(deps)` 返回
   `(signal: string) => Promise<number>`；deps = `{ server, autoIndexer, db, exit }`，
   `exit` 可注入（单测不真退）。执行序列（幂等守卫，重复调用直接复用同一 promise）：
   1. log 停机开始（只打元数据：信号名、阶段、耗时、在途计数；不打印会话正文/请求 URL）
   2. `autoIndexer.stop()`：清定时器、标记停（后续 kick 忽略）
   3. `server.close()` + `server.closeIdleConnections()`：停止接受新连接、立即断开空闲 keep-alive
   4. 等在途请求完成，`REQUEST_DRAIN_TIMEOUT_MS = 10_000` race 超时 → `server.closeAllConnections()` 强断
   5. 等在途索引 round 收尾：`autoIndexer.whenIdle()` race `INDEX_GRACE_MS = 2_000`，
      超时放弃（未落库的向量下次启动重算，无损失）
   6. `db.close()`（try/catch，失败也继续退出）
   7. `exit(0)`
2. **信号注册**（薄层，`installGracefulShutdown`）：SIGINT / SIGTERM / SIGHUP / SIGBREAK
   四个信号注册同一 runner；**第二次信号**立即 `exit(1)` 强杀兜底
3. **AutoIndexer**：新增 `whenIdle(): Promise<void>`——返回在途 round 的 promise，
   无在途则立即 resolve；`stop()` 行为不变
4. **index.ts 接线**：接住 `serve()` 返回值，调 `installGracefulShutdown`
5. **测试** `test/shutdown.test.ts`：
   - 单元：runner 各阶段顺序、幂等（复用同一 promise）、第二信号强杀、超时强断路径
   - 进程内集成：真 http server（随机端口）+ 临时 db + fake provider，直接调 runner，
     断言关停后端口不可连、db 可重新打开、退出码 0
   - 不用真实进程信号做集成（Windows 上父进程 `process.kill(pid, 'SIGTERM')` 是硬终止
     不走 handler，跨平台不可行）；信号注册层保持薄，由单元测试覆盖注册集合即可

### 设计取舍

- 常量不进 env：`REQUEST_DRAIN_TIMEOUT_MS`/`INDEX_GRACE_MS` 写死模块常量，
  停机是低频操作，不值得配置面；未来 NSSM 若嫌 1.5s 不够，调 NSSM 的 AppStopMethodConsole
- 未完成索引不等待长收尾：未索引队列天然可重入（幂等 upsert + listUnindexed），
  宽限 2s 只是"顺手让它落库"，非正确性依赖
- 不做 `POST /v1/shutdown` 停机端点（kill 是唯一停机路径，端点是多余的攻击面）
- 不处理 uncaughtException/unhandledRejection：Node 默认崩溃路径对 SQLite 可恢复
  （热日志回滚），保持小步
- dev 热重启：tsx watch 改文件重启子进程会走一次优雅停机，常规路径（无在途 round/请求）
  额外开销为 0（race 立即胜出 + 一次 db.close），可接受

## 涉及文件

- `server/package.json`：version 0.10.0 → 0.12.0（用户点名 0.12，0.11 跳过不用；顺修缩进）
- 新增 `apps/server/src/shutdown.ts`
- 修改 `apps/server/src/index.ts`、`apps/server/src/auto-index.ts`
- 新增 `apps/server/test/shutdown.test.ts`
- 本档 `plan.md` / `summary.md`
- 远端 `start.sh`（部署资产，不入库）：重启逻辑改为 kill 后轮询等待退出（约 15s），
  超时 `kill -9` 兜底；dev 阶段更新并记入 summary

## 任务清单

1. `shutdown.ts`：runner + 信号注册
2. `auto-index.ts`：`whenIdle()`
3. `index.ts` 接线
4. 单元 + 进程内集成测试
5. `npm test` + `npm run build` 全绿
6. 远端部署：更新 `start.sh` 重启逻辑，WSL1 实测 SIGTERM 优雅退出
7. `summary.md` + 提交

## 验收标准

- `npm test` / `npm run build` 全绿
- Windows 本地 `npm run dev`：Ctrl+C 后日志出现停机序列，进程退出码 0，db 无 `-journal` 残留
- WSL1 远端：`kill <pid>`（SIGTERM）后进程按序列优雅退出（退出码 0），`start.sh` 重启正常
- 关停期间到达的请求得到响应或被明确断开，进程不挂死
- 未完成的索引不写半截数据，下次启动自动续跑

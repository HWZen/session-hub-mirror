# 0.10.0 Summary — 服务端部署到远程服务器 WSL1

## 实际改动

仓库内：
- 根 `plan.md`：决策更新——数据存放改为服务器本地 D 盘（NAS 暂缓）、部署形态定为 WSL1（`ssh <server-alias>` 直达，端口 5328）、Caddy/NSSM 归入 P4 公网化并暂缓、架构图同步
- `server/package.json`：version 0.9.0 → 0.10.0
- `package-lock.json`：补齐缺失的 `@session-hub/zcode-plugin@0.1.0` 工作区条目
- 本档 `plan.md` / `summary.md`

远端资产（不入库）：
- Node 22.23.2 → `~/node22`（官方 tarball，免 sudo；`~/.bashrc` 已注入 PATH）
- 裸仓库 `~/repos/session-hub.git`；部署目录 `~/apps/session-hub`（更新方式：本地 `git push intel:repos/session-hub.git <branch>:master` 后远端 `git pull` + `npm ci` + `npm run build` + 重启）
- `server/.env`：PORT=5328、HOST=0.0.0.0、SH_DB_PATH=/mnt/d/session-hub/data/session-hub.db、SH_AUTH_TOKEN（随机生成）、SH_WEB_DIST=./apps/web/dist
- `~/apps/session-hub/start.sh` / `stop.sh`：nohup 启停，PID 与日志落 `/mnt/d/session-hub/`（log：`logs/server.log`）
- 存量数据 `/mnt/d/session-hub/data/session-hub.db`（140MB，拷自本地工作区）；`server/config/providers.local.json` 原样拷贝
- `LD_LIBRARY_PATH=/usr/local/lib64` 已写入 start.sh 与 `~/.bashrc`（见偏差 3）

本地机器：拷 db 前按红线停掉了 dev 服务端（7428），**尚未重启**，需要时 `npm run dev`。

## 与计划的偏差及原因

1. **版本号用 0.10.0 而非 0.9.x 延续**：规划时发现 0.9.0 已被"Agent Skill 与接口动态发现"占用（c06ec1f），按 SOP 顺延。
2. **package-lock 失修**：master 合并 zcode 插件工作区时未更新 lock 文件，远端 `npm ci` 报 EUSAGE。在 worktree 内 `npm install --package-lock-only` 补齐并单独提交（8b20e58）。
3. **better-sqlite3 无法用预编译产物**：v13 预编译要求 GLIBC 2.33，服务器 Ubuntu 20.04 只有 2.31。处理：删 `node_modules/better-sqlite3/prebuilds/linux-x64.node`（包内自带、优先加载，`npm_config_build_from_source` 无效）→ `npx node-gyp rebuild` 源码编译（服务器有自定义 g++ 12）；编译产物又依赖 GLIBCXX_3.4.29，运行时需 `LD_LIBRARY_PATH=/usr/local/lib64`（该 g++ 自带的运行时库）。**npm ci 重新安装会还原预编译文件，必须重做这两步**。
4. **访问验证方式变化**：本地工作机与服务器不在同一局域网（SSH 走 DDNS `session-hub.example.test`），原计划的"局域网直连"改为"公网域名 + 路由器端口转发 + Windows 防火墙入站规则"（转发已有，防火墙规则由用户开通后验证通过）。

## 测试 / 验收结果

- 远端 `npm ci`：199 packages，0 vulnerabilities ✅
- 远端 `npm run build`：全绿（tsc -b + plugin typecheck + web vite build）✅
- 远端 `npm test`：14 文件 / 103 用例全部通过 ✅
- `GET https://session-hub.example.test/health`：`ok`，version 0.10.0，journal_mode=truncate ✅
- Bearer token 鉴权 `GET /v1/sessions`：返回 156 条会话 ✅
- db 实际落在 `/mnt/d/session-hub/data/` ✅
- `start.sh` 手动启动验证 ✅
- 语义搜索 ❌：见遗留 1

## 遗留事项

1. **语义搜索不可用**：embedding 提供商链未通——服务器侧 `127.0.0.1:434`（5070Ti 机 frpc 隧道）未注册，frps 现有隧道（5200/5207/5211）后端也无响应；用户确认为常态，后续再接（属 P4 提供商链范畴）。
2. **P4 公网化**（Caddy HTTPS/DDNS/token 前置）、开机自启（NSSM，且需管理员）、NAS 存储均暂缓（见根 plan.md §3/§8）。
3. Windows 账户 10414 无管理员权限：装系统服务、改防火墙需用户手动提权操作。
4. 服务器重启后手动恢复：`ssh <server-alias>` → `~/apps/session-hub/start.sh`。

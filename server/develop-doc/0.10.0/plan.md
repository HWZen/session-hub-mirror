# 0.10.0 服务端部署：远程服务器 WSL1

## 需求描述

把服务端部署到远程 Win10 工作站（HWZEN-INTELPC）的 WSL 里并跑起来：

- 数据库与运行数据全部留在服务器本地，**数据落 D 盘**（用户定稿：暂不使用 NAS）
- 访问方式：`ssh <server-alias>`（Windows OpenSSH DefaultShell 直达 WSL1，密钥登录，账户 intel）
- 端口定 **5328**（用户指定 5300~6000 区间）
- 不做开机自启（重启/死机后手动启动）；不处理防火墙（用户确认自管）
- 无管理员权限（Windows 账户 10414），不引入 NSSM/Caddy（属 P4 公网化，暂缓）

## 侦察事实（2026-09-06）

- 远端：`ssh <server-alias>` 直接落在 **WSL1 Ubuntu-20.04**（内核 4.4.0-19041-Microsoft；非 WSL2）
- WSL1 特性利好：端口直接绑定 Windows 网络栈（局域网可达）；`/mnt/d` 为原生 NTFS 语义，无 9p 转发层，SQLite 落 D 盘安全
- WSL1 限制：无 systemd（本来也不需要自启）；Windows PATH 未注入 WSL（调 Windows 程序需全路径，如 `/mnt/c/Windows/System32/cmd.exe`）
- 远端现状：Node v10.19.0（不可用，项目要求 ≥22，better-sqlite3@13 要求 ≥22）；git 2.25.1；外网可达；内存 16G / 4 核；D 盘 103G 可用
- Windows 账户非管理员：装系统服务、改防火墙不可行（本版也不要求）

## 方案

- **代码分发**：远端 `~/repos/session-hub.git` 建裸仓库（ext4），本地 `git push server` 增量更新；部署目录 `~/apps/session-hub`（ext4，保证 node_modules 符号链接可用；drvfs 上 npm 装依赖有符号链接风险）
- **Node 22**：官方 linux-x64 tarball 装到 `~/node22`（免 sudo），`~/.bashrc` 注入 PATH
- **运行数据**：`SH_DB_PATH=/mnt/d/session-hub/data/session-hub.db`；日志/备份同放 `/mnt/d/session-hub/`
- **配置**：远端 `server/.env`（PORT=5328、HOST=0.0.0.0、SH_DB_PATH、SH_AUTH_TOKEN 随机生成）；`server/config/providers.local.json` 从本地工作区拷贝（embedding 走 frps 隧道地址）
- **存量数据**：本地 `server/data/session-hub.db` 拷贝到远端数据目录（拷前确认本地服务端未运行）
- **启动**：`nohup node apps/server/dist/index.js`（WSL 有常驻进程即保持 Running）；手动重启 = kill + 重跑启动脚本，脚本落 `~/apps/session-hub/start.sh`

## 涉及文件

- 根 `plan.md`：§3 部署/隐私、数据存放、技术栈行；§4 服务器部署形态；§5 架构图；§8 P4 标注暂缓
- `server/package.json`：version 0.9.0 → 0.10.0
- 本档 `plan.md` / `summary.md`
- 远端新建：bare 仓库、`~/node22`、`~/apps/session-hub`、`/mnt/d/session-hub/`、`start.sh`（远端资产，不入库）

## 任务清单

1. 远端装 Node 22（tarball，免 sudo）
2. 远端建裸仓库，本地 push，远端 clone 到 `~/apps/session-hub`
3. `npm ci` + `npm run build` + `npm test` 全绿
4. 配置 `.env`（5328 / 0.0.0.0 / D 盘 db / 随机 token），拷贝 providers.local.json 与存量 db
5. 启动服务，`/health` 校验（版本 0.10.0），本地机器走局域网验证 API 与 Web
6. 写 `start.sh` 与 summary.md，提交并合并回 master

## 验收标准

- 远端 `npm test` / `npm run build` 全绿
- `GET http://<服务器IP>:5328/health` 从本地机器可访问，返回 version 0.10.0
- db 文件实际落在 `/mnt/d/session-hub/`，语义搜索可用（依赖 GPU 机 frpc 隧道在线）
- 重启后可按 `start.sh` 手动拉起

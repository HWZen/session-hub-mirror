# Session Hub

跨端跨 Agent 的个人会话档案库 + 检索层。只做"存得全、找得到"，零加工。

opencode / WorkBuddy / 豆包等各 Agent 的会话全量归档到一处（SQLite on NAS），支持语义检索定位 + 全量下载提取。

## 仓库结构

```
packages/shared/   跨子系统契约（会话数据模型、类型、配置 schema）
server/            服务端子系统（API + Web 前端，版本号与 develop-doc 在此）
plugins/           各 Agent 客户端插件（规划中）
apps/collector/    采集器守护进程（规划中）
plan.md            全局需求与决策（唯一事实源）
AGENTS.md          AI 协作规范与开发 SOP
```

## 快速开始

```powershell
npm install
npm run dev      # 服务端 http://127.0.0.1:7428
npm run dev:web  # 前端开发（可选）
npm test
```

配置：复制 `server/.env.example` 为 `server/.env`；embedding 提供商在 Web 设置页或
`server/config/providers.local.json` 配置（模型固定 bge-m3）。

## 文档

- `plan.md` — 需求、决策记录、侦察事实、风险
- `AGENTS.md` — 开发 SOP（每个需求一个版本号，`server/develop-doc/<版本号>/`）
- `server/develop-doc/` — 各版本 plan.md / summary.md 档案

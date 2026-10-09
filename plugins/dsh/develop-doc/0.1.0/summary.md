# 0.1.0 — DSH Cordis 会话采集插件摘要

## 实际改动

- 实现 Host-only Cordis bundle、会话持久化读取、事件顺序与 raw 保留、用户/助手可见文本与 reasoning 投影、per-session single-flight、有限重试、启动补传、配置校验与日志脱敏。
- 将 Node 上传 sidecar 实现为自包含 TypeScript `uploaderMain()`，`UPLOADER_CODE` 由函数 `toString()` 生成；stdin 使用 config JSON、换行、原始 payload JSON 的协议，Host 使用 `TextEncoder` 检查 16 MiB payload 上限。超限以 nonretryable `payload_too_large` 失败，队列保留 dirty 并 parked。
- 启动 `sessionPersistence.list()` 失败时通过同一 Cordis timer scheduler 退避重试最多 3 次；清理会取消待执行重试。补充 `session/title` 单独触发测试。
- reasoning decoder 同时读取原始 provider chunks 与安装版 durable snapshot：`@deepseek-ai/dsh-llm/lib/index.js:964-1004` / `1020-1030` 描述 block chunks/assembler；`1150-1248` 的 `AssistantStreamAccumulator.snapshot()` 持久化 `{type:"reasoning-chunks",time0,index,dt,texts}` 与 `{type:"chunk",time,chunk}`。decoder 校验 packed index/texts、解包 chunk、允许 delta-only，并以同 index block-end 完整 reasoning text 覆盖增量。合成 fixture 覆盖 durable packed+wrapped、delta-only/interrupted、override 和 raw 兼容形态。
- 更新根 `AGENTS.md` 中多个子系统/插件 `package.json` 版本事实源说明。

## 验证与边界

- 根目录 `npm test`：45 个 test files / 301 tests 全绿。
- 根目录 `npm run build`：通过，包括全仓 typecheck、DSH ESM bundle 与 Web production build。
- Windows 受限 sandbox 会阻止 Vitest/esbuild 创建子进程；上述两条根命令在获准的非受限执行中完成。
- 依据安装版静态源码形状编写合成 fixture；当前会话没有 `plugin_manager` / `cordis_inspect_query` 工具，无法做真实 Host/profile 安装、启停和网络链路验收。未读取任何私人会话正文，也未安装或改动真实 DSH profile。

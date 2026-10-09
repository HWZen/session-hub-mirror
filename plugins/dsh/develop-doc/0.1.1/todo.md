# 0.1.1 TODO（本版遗留与后续候选）

来源：`develop-doc/0.1.1/acceptance.md`（真机验收）与 `summary.md` §6。0.1.1 已通过验收，下列两项不阻塞使用。

## TODO 1：DSH 原生配置面（0.1.2 候选）

- **目标**：在 DSH「插件」页给 `@session-hub/dsh-plugin#session-hub-dsh` 一个可点开、可填写的配置页，不再依赖共享配置文件 `~/.config/session-hub/config.json`。
- **依据（0.1.0 验收实测）**：Host Config 投影 `status:"unsupported"`（zod Config 缺少 `Symbol.for("schemastery")` 标记，`isNativeConfigSchema()` 不认）；client `plugins.row.config` 的 occupants 为空 → 插件行上没有「配置 …」按钮；Settings 插件页是只读清单。
- **工作项**：
  1. `Config` 改为原生 schemastery `Schema`（标记是全局 symbol，跨副本可识别，可随 dist 打包），使 `cordis_inspect host/Config listConfigs` 返回 `status:"schema"`。
  2. 补 client 半：bundle 声明 `dsh.client`，注册 `plugins.row.config`（key `@session-hub/dsh-plugin#session-hub-dsh`），用 host 注入的 `ConfigPageForm` 读写；客户端 bundle 形态为 `window.__ModuleLoader__.load({...})`，构建链需先侦察（参考 `@deepseek-ai/dsh-client-ui-plugin-manager`）。
  3. 表单字段与现有解析链保持一致优先级：Cordis Config > 共享配置 > hostname 兜底。
  4. 保存后无需重启即生效，并保留 token 不回显（沿用秘密字段处理）。
- **验收**：插件页能填写 7 个字段并保存；`listConfigs` 为 `schema`；未填时仍走共享配置与 hostname 兜底（不得回退当前行为）。

## TODO 2：超大会话 payload（16 MiB 上限）

- **现状**：0.1.0 设计——serialize 后超过 16 MiB 的 payload 判 nonretryable `payload_too_large`，queue 保留 dirty 并 parked，不截断、不上传部分内容。本机 16 个历史会话均未触发（最大者已成功上传）。
- **风险**：会话继续增长后可能触发（本会话验收时已 386 条消息）；触发后该会话停止上传，只能在日志里看到错误类别。
- **候选方向（需另开一轮规划，可能涉及服务端契约升级，先不动手）**：
  1. 服务端支持增量/分片上传（如按事件区间追加 + 幂等序号）；
  2. 或客户端按消息边界拆包并携带稳定序号，由服务端保证最终一致；
  3. 或提高上限并明确内存与超时预算。
- **决策时机**：真机上出现 `payload_too_large` parked 之后再规划，不预先实现。

## 备注

- `.scratch/` 下的真机验收脚本（`sh-accept.mjs`、`dsh-coverage.mjs`、`dsh-reasoning-token.mjs` 等）不入库，可复用于下一轮验收。
- 判断插件是否**真正卸载**要看 `plugin_manager list_plugins` 的 `fiberPhase`（`null` = fiber 已卸载），不能只看 `cordis_inspect` 的 `inactive`（那只反映 patch 层 `disabled`）。
- 插件当前安装方式：profile 以 `link:` 指向仓库 `plugins/dsh`（路径与运行位置见部署说明）；`dist/index.js` 为构建产物，不入库，重装前需先 `npm run build`。

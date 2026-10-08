# 0.1.0 Hermes 采集插件完成记录

## 实际改动

- 新增 `@session-hub/hermes-plugin` 0.1.0：Shell hook 读取事件身份，按会话 60 秒节流，并 detached 启动 worker；worker 只读打开对应 profile 的 `state.db`，转换会话后 PUT `/v1/sessions`。
- 转换覆盖 `user`、`assistant` 与 `tool` 消息，过滤 `session_meta`，保留 rowid 顺序；应用 title/text 2000/1,000,000 字符上限及 5000 条消息上限，超限写入截断标记。不生成 reasoning。
- 配置优先读取 `SH_BASE_URL` / `SH_TOKEN`，缺失项从 Leader profile 的 Session Hub skill `config.json` 补齐。
- 新增四 profile 历史回填 CLI，默认逐个回填未归档会话；支持 `--profile` 与 `--session`。
- 新增安装脚本：生成 Hermes Shell hooks 配置、合并 `(event, command)` allowlist，并调用 `hermes hooks list` 验证；运行时路径解析指向主工作区插件产物。
- 根 `package.json` 增加 Hermes 插件 typecheck 编排与 `install:hermes-plugin`；刷新 `package-lock.json`。未改动 `server/**`、`packages/shared/**` 或其他插件；无新运行时依赖。

## 验证结果

- `npm test`：PASS 38 个测试文件 / 258 个测试，FAIL 0。
- 插件定向测试：8 个测试文件 / 28 个用例通过；hook/helper 配置合并另以独立无副作用脚本验证通过。
- `npm run build`：PASS，根项目引用、opencode/zcode/Hermes/collector 类型检查及 Web 构建均完成。Vite 输出 circular-dependency 与 native configLoader 警告，命令退出码为 0。
- `npm run build -w @session-hub/hermes-plugin`：PASS，生成 `dist/hook.js`、`dist/worker.js`、`dist/backfill.js`。
- 两个 `.mjs` 脚本语法检查及安装配置纯函数测试：PASS；覆盖配置幂等更新、现存 hooks 保留、空 hooks 映射及 allowlist 合并。
- 只读检查了本机四个 profile 的 `state.db` 表/列和时间戳类型，未读取或输出会话正文，也未写入数据库。

## 与 plan 的差异

- 根 `AGENTS.md` 补充未能执行：受保护文件写入审批等待超时，工具拒绝写入；未通过其他方式重试。该文档更新仍待获批后处理。
- 实测 `messages.timestamp` 列存在且为秒级 REAL；plan 说明消息无逐条时间列。本版仍按 plan 省略消息 `ts`，以 rowid 保持顺序。
- 本阶段未执行 `install:hermes-plugin`，未注册或触发 hooks；真实会话上报、回填统计及卸载验证按任务边界留给 Leader 实测。
- worktree 中未找到 `docs/agents/testing.md`；按仓库 `AGENTS.md` 与 plan 执行根目录测试和构建。

## 遗留事项

- 获批后补充根 `AGENTS.md` 的 Hermes 目录与外部事实条目。
- Leader 在主工作区运行安装脚本并完成 `hermes hooks list`、真实触发、连续会话、历史回填统计及卸载 fail-open 验收。

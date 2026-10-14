# 0.23.0 隔离历史脱敏验收

## 结果

在仓库外独立镜像完成 Git 历史脱敏；原仓库、其他 worktree 与 GitHub refs 保持原状。本地候选 master 包含 0.23.0 整合成果。

## 历史保真

| 核对项 | 结果 |
| --- | --- |
| 原提交 | 126 个全部保留，没有删除空提交或折叠 merge |
| AuthorDate / CommitterDate | 逐条一致，包括时区 |
| 作者 / 提交者 | 逐条一致，保留获准邮箱 |
| 父提交关系 | 按提交映射逐条一致 |
| 最早提交日期 | 2026-09-05 |
| 分支与标签 refs | 37 个 refs 完成映射核对，9 个标签保留 |
| 注释标签 | 4 个 tagger 信息、时间与目标映射一致 |
| 原始工作区 | 15 个 worktree 的 HEAD、状态、diff 及未提交文件哈希一致 |

重写改变 SHA 和脱敏内容，保留开发时间线；本次验收记录使用实际执行日期作为新增提交时间。

## 隐私处理

- 私有 Git bundle 已验证并记录 SHA-256；备份与原始证据只保存在受限的仓库外交付目录。
- 全历史移除 OpenCode 原始 E2E 目录与私人探针逐条结果；DSH 验收和探针指标保留工程摘要。
- 对私人部署地址、设备、用户路径、profile 和会话标识进行匿名化；代码/fixture 中关系一致的标识使用一致别名。
- OpenCode 验收脚本改用用户目录和 `OPENCODE_E2E_SCRATCH` / `OPENCODE_E2E_ISOLATION_ROOT`；Python 解释器显式由参数或 `OPENCODE_E2E_PYTHON` 提供。
- 私人探针语料标识改由 `SH_PROBE_SOURCE_IDS` 读取；`SH_PROBE_QUERIES_FILE` 指向仓库外私有查询，仓库示例保持占位数据。
- 3 个 Codex 内部 checkpoint tree refs 不属于发布分支或标签，在候选镜像中移除；原备份保持完整。
- 680 个完整可达 blob、提交消息和标签元数据复扫；Gitleaks 命中仅为 settings 测试模拟密钥的历史变体，未确认真实凭证。
- `git fsck --full` 通过，候选镜像没有连接原仓库或服务器的 remote。

## 代码验证

在脱敏候选的独立 checkout 安装依赖后运行：

- `npm test`：70 个文件、552 个测试全部通过。
- `npm run build`：通过。
- `git diff --check`：通过。

这是整合代码与静态文档验证，宿主隔离 E2E、生产部署及真实会话上传未执行。

## 后续发布门槛

开源发布到 `HWZen/session-hub-mirror`；新仓库先 private 上传已脱敏分支和标签，完整历史及全部资产复核通过后 public 并回读。备份、扫描对象与生产资料保持私有，发布验证记录见 `publication.md`。

# 0.23.0 公开审查与历史处理方案

## 审查范围与方法

初始全历史范围：122 个可达提交、658 个唯一 blob，合计约 8.8 MB。已 fetch GitHub origin 的全部分支与标签；包括本地各分支、origin refs、拟整合的 Codex 与 OpenCode 分支。服务器 remote 未连接。

- Gitleaks 8.30.1：`git --log-opts="--all --full-history"`，报告 100% redact。
- 将全部唯一 blob 导出到仓库外，再进行目录扫描，覆盖完整文件快照而非仅新增 diff。
- 提交作者、提交者、消息另存仓库外扫描；补充部署标识、域名、路径与原始验收文件分类检查。
- GitHub：9 个分支、9 个标签、9 个 Release 附件、11 次 Actions 运行日志；另检查唯一已合并 PR 的正文、评论、reviews、提交与 diff，以及仓库描述、wiki/pages 状态和 Actions artifacts。
- 原始报告、下载资产和历史对象仅留在本机仓库外，不提交凭证或会话。

扫描是基于规则与上下文的风险排查，不是没有未知敏感内容的证明。

## 发现与分类

| 类别 | 位置/范围 | 结论与处置 |
| --- | --- | --- |
| Gitleaks 命中 | OpenCode 0.2.0 report/summary，服务端 settings 测试 | Git diff 扫描 23 条：22 条为插件文件哈希，1 条为模拟测试密钥；完整 blob 扫描含测试文件的历史变体。没有确认真实凭证 |
| 凭证形状补充命中 | `.env.example`、probe 环境变量访问、OpenCode token 日志测试 | 占位值、变量名或测试模拟值；未进行凭证轮换/作废 |
| 私人部署与设备信息 | 历史 README、根 plan、多版本 develop-doc、少量宿主验收脚本与 fixture | 初始分类涉及 75 个 blob；隔离镜像已完成上下文脱敏，核心说明使用用户自托管配置 |
| 原始证据 | 服务端 0.17.0 probe、DSH acceptance、OpenCode 0.2.0 e2e 目录 | 镜像全历史移除原始 JSON 与设备明细，保留聚合指标和工程验收摘要；原对象仅由私有备份保管 |
| 作者邮箱 | 提交与 GitHub 提交元数据 | 用户明确同意保留当前邮箱；署名 HWZen |
| Releases / Actions / PR | 已下载附件与日志、API 元数据、PR diff/comments/reviews | 凭证扫描无命中，未发现需要公开的原始会话附件；元数据中的已获准作者信息保留。后续重写须复核源码自动下载包与旧提交链接 |

本地镜像全历史已处理下列 26 个已知私人标识文件，并补充匿名化语料会话标识和 profile 名称。完整文件对象复扫没有这些已知标识；凭证命中仅为模拟测试值。扫描不能证明不存在未知敏感内容。

定位清单：

- `apps/collector/develop-doc/0.2.0/{plan,summary}.md`
- `plugins/claude-code/develop-doc/0.1.0/plan.md`、`plugins/claude-code/test/transform.test.ts`
- `plugins/dsh/develop-doc/0.1.1/{plan,summary}.md`、`plugins/dsh/test/{shared-config,sidecar}.test.ts`
- `plugins/hermes/develop-doc/0.1.0/plan.md`
- `plugins/opencode/develop-doc/0.1.0/{plan,summary}.md`、`plugins/opencode/develop-doc/0.2.0/{plan,summary}.md`
- `plugins/opencode/scripts/acceptance/{e2e-v1,e2e-v2}.ts`、`plugins/opencode/scripts/qualify-host.ts`
- `server/apps/server/test/helpers.ts`、`server/apps/server/test/session-meta.test.ts`
- `server/develop-doc/0.10.0/{plan,summary}.md`
- `server/develop-doc/{0.4.0,0.13.0,0.14.0,0.18.0,0.21.0,0.21.1}/summary.md`

## 已确认决策

- `HWZen/session-hub-mirror` 为开源交付仓库，保留已脱敏的 Git 历史。
- MIT 署名：2026 HWZen。
- 公开提交允许保留现有作者邮箱。
- 已授权仓库外隔离备份、历史脱敏、新仓库创建及检查通过后的公开。

## 本地执行范围

### 本地隔离重写

1. 仓库外生成全部 refs 的 Git bundle，并记录哈希；保存当前版本文档、原始验收对象和 ref 清单。备份保持私有。
2. 创建独立 bare 镜像；只在镜像中修改历史，不移动原仓库或其他 worktree 的分支，不 reset 用户工作区。
3. 覆盖所有拟公开本地分支及 GitHub 分支：已有 9 个远端分支，加纳入公开范围的本地版本线；master 使用 0.23.0 整合成果。覆盖现有 9 个标签。
4. 全历史移除 OpenCode 0.2.0 原始 e2e 请求/模型/报告 JSON、私人探针逐条结果；将 DSH 与 OpenCode 验收明细替换为工程摘要。保留 fixture 中可证明模拟的数据和可复用测试脚本。
5. 对历史 Markdown、配置示例、验收脚本和 fixture 的私人部署地址、个人用户目录、设备标识做上下文脱敏。运行脚本中的本机路径改为显式参数/通用路径前需保持语义并执行测试；不替换真实协议字段或公共 API。
6. 保留作者名称、邮箱、时间与工程提交消息；如消息自身含私人部署标识，仅改该部分。生成 old/new commit 和 refs 映射。
7. 全历史复扫、各 tag/branch 树核对、根测试与构建，以及最终公开文档检查。

### 新仓库发布

新仓库先 private，只接收已验收的分支与标签。发布前逐项核对实际 refs、完整可达历史、提交元数据、源码下载包、Releases、Actions、PR 和仓库设置。私有生产资料与备份和开源交付隔离，发布资产按实际内容单独审查。

协作者从公开仓库 clone 脱敏历史；后续发布改动必须在经过隐私审查的提交图上进行。其他 worktree 的未提交内容保持原状。

本地隔离执行、日期核对和最终测试结果见 `history-rewrite.md`，开源入口与发布流程见 `publication.md`。全部拟公开 refs 和 GitHub 资产检查通过后设置 public 并回读实际状态。

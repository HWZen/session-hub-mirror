# 0.2.0 采集器：WorkBuddy reasoning 纳入采集

## 需求描述

WorkBuddy transcript JSONL 的 `type:"reasoning"` 行（思考）当前**无 role，被解析器当 dropped 丢弃**，导致服务端拿不到 WorkBuddy 的 thinking，无法索引。

本版把 reasoning 采集进消息 `raw`，并按**统一归一化契约**产出 part `{type:"reasoning", text}`，与 opencode/zcode 的结构对齐，供服务端 0.15.0 切片索引。

## 现状（侦察结论，2026-09-10）

- `src/workbuddy/parse.ts:100` `TEXT_PART_TYPES = {"text","input_text","output_text"}`：只认文本 part；`joinTextParts` 产出 `{text, raw}`。
- `parse.ts:148-151`：`role === null` 的行 `stats.dropped++` 并跳过。真实 WorkBuddy JSONL 中 `function_call`/`function_call_result`/`reasoning`/`file-history-snapshot` 均无 role，**全部被丢**（见 0.1.0 summary「实测发现」第 42 行）。
- 真实格式（0.1.0 实测）：扁平行，`role`/`content`/`timestamp`（数字 ms）在**行顶层**；文本 part 类型 `input_text`（用户）/`output_text`（助手）；另有 `type:"ai-title"` 行。
- `raw` 产出形态：content 为多 part 数组时 raw=数组；**单 part 时 raw=裸对象**；content 为 string 时 raw=string（`parse.ts:112`、`:154-163`）。
- 上传契约 `messageInputSchema.raw` 为 `z.unknown()`，**加字段/换结构无需改服务端契约**。

### 未知（阻塞项）

- **`type:"reasoning"` 行的真实 schema 未采样**。本机（WORKSTATION-A）已无 `~/.workbuddy/projects`，需在跑 WorkBuddy 的机器（WORKSTATION-B）用 `scripts/workbuddy-probe.mjs` 采样。
- 预期为 OpenAI Responses 风格：`{type:"reasoning", summary:[{type:"summary_text", text:"..."}]}`，也可能为 `content[]`/`text`/`thinking`；**若仅给 `encrypted_content` 无明文，则该条无索引价值，跳过并计数**。

## 方案

### 归一化契约（与服务端一致）

- reasoning 一律以 part `{ "type": "reasoning", "text": "<明文>" }` 放入所属消息的 `raw`：
  - 多 part 时为数组、单 part 时可直接是对象（沿用现有 raw 形态规则）。
- 字段名固定 `text`，**不新造 `thinking` 等字段**（服务端同时兼容 `thinking`，但采集侧统一用 `text`）。

### `src/workbuddy/parse.ts` 改动

- `parseLine` 增加识别 `type:"reasoning"` 行（无需 role）；提取明文：
  - `summary` 为数组 → 拼接各项 `summary_text.text` / `text`；
  - 否则取 `content[]` 的文本 / 直接 `text` / `thinking`；
  - 均无明文（如仅 `encrypted_content`）→ 记入 `stats` 计数并跳过。
- **归属策略（推荐"挂到下一个 assistant 消息"）**：缓冲已读 reasoning 文本；遇到下一条 `type:"message"` 且 role=assistant 的行时，把 `{type:"reasoning", text}` part 追加进该消息 raw（并保证 raw 为数组形态）；会话结束仍有剩余缓冲时，flush 成一条 `role="assistant"`、仅含 reasoning raw 的消息（text 省略）。
  - 该策略与 opencode/zcode 的"reasoning 是 assistant 消息内的 part"结构一致，服务端抽取逻辑无需特例。
  - 备选（更简单但多出消息行）：每条 reasoning 行直接产出一条 reasoning-only 消息；本版不采用，避免 message_count 虚高。
- 保持既有行为不变：`<user_query>` 提取、`<system-reminder>` 剥离、text 1MB 截断、messages 尾部 5000、title 用 `aiTitle`、`function_call*` 继续 dropped（本期不采集工具产出）。

### 采样（E2E 验证项，不阻塞开发）

- **不采样也能开发**：reasoning 提取按候选形态防御式兼容（`summary[].text` / `content[]` / `text` / `thinking`），单测逐一覆盖；真实 schema 未知不影响先落地。
- 在 WORKSTATION-B 跑 `npm run probe:workbuddy -w @session-hub/collector` 产出 transcript 头尾样本，用于**确认**真实 schema、收窄分支；作为开发收尾的 E2E 验证项，**不是前置阻塞**。
- 若真实形态在候选之外，按样本小改提取逻辑即可（summary 记录实际 schema）。

## 涉及文件

- `apps/collector/package.json`：version 0.1.0 → 0.2.0（已完成）
- `apps/collector/src/workbuddy/parse.ts`（reasoning 采集 + 归属）
- `apps/collector/test/parse.test.ts`（新增 reasoning 用例）
- 根 `AGENTS.md`（新 Agent raw 契约条款，与服务端版共用）
- 本档 `plan.md` / `summary.md`

## 任务清单

1. `parse.ts`：reasoning 提取（候选形态防御式：`summary[]`/`content[]`/`text`/`thinking`）+ 归属到 assistant 消息 raw + 结束 flush
2. 单测：summary 形态 / content 形态 / text 形态 / encrypted 跳过 / 归属顺序 / 结尾 flush / raw 形态（数组与单对象）
3. 服务端 0.15.0 联调：确认 workbuddy 会话被抽出 reasoning chunk 并可被检索命中
4. WORKSTATION-B 采样确认真实 schema（**E2E 验证，非前置**）；如形态出入则微调
5. `npm test` + `npm run build` 全绿，写 summary.md，提交

## 验收标准

- 含 reasoning 的 WorkBuddy 会话上传后，`raw` 中出现 `{type:"reasoning", text}` part（数组形态），且文本为明文。
- 无明文的 reasoning（仅加密）不产生空 part，`stats` 有跳过计数。
- 既有文本采集、title、时间戳、幂等 upsert 行为不回退。
- 服务端 0.15.0 对 workbuddy 会话能产出 `source="reasoning"` 的 chunk 并被检索片段命中。
- 根目录 `npm test` + `npm run build` 全绿。

## 风险与未知

| 风险/未知 | 处置 |
|---|---|
| reasoning 行 schema 未采样 | **不阻塞**：按候选形态防御式兼容实现 + 单测；真机采样在 E2E 阶段确认/校正 |
| reasoning 可能仅加密无明文 | 跳过 + 计数；评估是否仍有价值并记录进 summary |
| reasoning 与 assistant 消息归属可能错序 | 以 JSONL 行序为准缓冲；结尾 flush 兜底；单测覆盖 |
| 采集端改动影响既有解析 | 保持既有 16 例全绿，仅新增分支 |

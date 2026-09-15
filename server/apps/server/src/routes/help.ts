import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
  grepRequestSchema,
  providerSettingsBodySchema,
  searchRequestSchema,
  sessionFilterSchema,
  sessionUpsertSchema,
} from "@session-hub/shared";

export interface HelpParam {
  name: string;
  in: "query" | "body" | "path";
  type: string;
  required: boolean;
  desc: string;
}

export interface HelpError {
  status: number;
  message: string;
  recoverable: boolean;
}

export interface EndpointHelp {
  method: string;
  path: string;
  summary: string;
  description: string;
  params: HelpParam[];
  returns: Array<{ name: string; type: string; desc: string }>;
  example?: unknown;
  errors: HelpError[];
}

interface JsonSchemaProp {
  type?: string | string[];
  description?: string;
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  anyOf?: JsonSchemaProp[];
  $ref?: string;
}

const UNAUTHORIZED: HelpError[] = [{ status: 401, message: "Bearer token 缺失或错误", recoverable: true }];
const BAD_JSON: HelpError = { status: 400, message: "invalid JSON body", recoverable: true };

function propType(p: JsonSchemaProp): string {
  if (p.items) return `${propType(p.items)}[]`;
  if (p.type) return Array.isArray(p.type) ? p.type.join("|") : p.type;
  if (p.anyOf) return p.anyOf.map(propType).join(" | ");
  if (p.properties || p.$ref) return "object";
  return "any";
}

function schemaParams(
  location: HelpParam["in"],
  schema: z.ZodType,
  descs: Record<string, string> = {},
): HelpParam[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchemaProp & {
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  const props = json.properties ?? {};
  return Object.entries(props).map(([name, p]) => ({
    name,
    in: location,
    type: propType(p),
    required: required.has(name),
    desc: descs[name] ?? p.description ?? "",
  }));
}

const bodyParams = (schema: z.ZodType, descs?: Record<string, string>) => schemaParams("body", schema, descs);
const queryParams = (schema: z.ZodType, descs?: Record<string, string>) => schemaParams("query", schema, descs);

export const endpoints: EndpointHelp[] = [
  {
    method: "GET",
    path: "/v1/help",
    summary: "接口发现：返回全部 /v1 端点索引（L0）",
    description:
      "接入本服务的起点：返回全部 /v1 端点索引（method/path/summary），保持轻量、不含参数细节。先在此发现接口，再对目标端点附加 ?help=1 取 L1 详情；自身也支持 ?help=1。接入或排障时先调它，不要凭记忆硬编码接口路径。",
    params: [],
    returns: [
      { name: "endpoints", type: "object[]", desc: "{ method, path, summary } 列表" },
      { name: "hint", type: "string", desc: "对任意接口附加 ?help=1 查看该接口的 L1 详情" },
    ],
    errors: UNAUTHORIZED,
  },
  {
    method: "PUT",
    path: "/v1/sessions",
    summary: "上传/更新会话（按 agent/machine/source_id 三元组幂等 upsert）",
    description:
      "写入会话的唯一入口，按 agent/machine/source_id 三元组幂等 upsert：同三元组重复上传是覆盖而非追加（整会话替换、消息全量重建、原有向量作废），已删除会话同三元组重新上传即恢复。时间戳一律取源数据时间，不用上传时刻。上传成功即返回（新建 201、更新 200），向量索引由后台异步补齐。",
    params: bodyParams(sessionUpsertSchema, {
      agent: "来源 Agent 标识，如 opencode",
      machine: "来源机器标识",
      source_id: "来源系统内的会话 ID；与 agent/machine 组成三元组，决定幂等 upsert",
      title: "会话标题（可选）",
      cwd: "会话工作目录（可选）",
      created_at: "会话创建时间，毫秒时间戳（取源数据时间，不用上传时间）",
      updated_at: "会话最后修改时间，毫秒时间戳",
      messages: "消息数组，元素为 { role, text?, ts?, raw? }；ts 为毫秒时间戳，raw 存原始结构",
    }),
    returns: [
      { name: "id", type: "string", desc: "会话 ID；新建返回 201，更新返回 200" },
      { name: "created", type: "boolean", desc: "是否新建" },
    ],
    example: {
      agent: "opencode",
      machine: "MY-PC",
      source_id: "ses_abc123",
      title: "修复登录超时",
      created_at: 1757100000000,
      updated_at: 1757100600000,
      messages: [
        { role: "user", text: "登录接口经常超时，帮我看看", ts: 1757100000000 },
        { role: "assistant", text: "排查发现是连接池配置问题", ts: 1757100060000 },
      ],
    },
    errors: [
      BAD_JSON,
      { status: 400, message: "invalid body（附 zod issues 字段级错误）", recoverable: true },
      ...UNAUTHORIZED,
    ],
  },
  {
    method: "GET",
    path: "/v1/sessions",
    summary: "分页列出会话（可按 agent/machine/source_id/时间范围过滤）",
    description:
      "会话元数据分页列表，不含消息正文；适合浏览、翻页与按 agent/machine/来源/时间范围圈选。过滤条件除 title 为子串包含外均为精确匹配。要看消息正文请改走 /v1/sessions/:id 系列接口。",
    params: [
      ...queryParams(sessionFilterSchema, {
        agent: "精确匹配来源 Agent",
        machine: "精确匹配来源机器",
        source_id: "精确匹配来源会话 ID",
        title: "标题子串包含（LIKE，ASCII 大小写不敏感）",
        created_from: "创建时间下界（毫秒时间戳或可解析的日期字符串）",
        created_to: "创建时间上界",
        updated_from: "修改时间下界",
        updated_to: "修改时间上界",
      }),
      { name: "limit", in: "query", type: "integer", required: false, desc: "1..200，默认 50" },
      { name: "offset", in: "query", type: "integer", required: false, desc: ">=0，默认 0" },
    ],
    returns: [
      { name: "total", type: "integer", desc: "过滤后总数" },
      { name: "limit", type: "integer", desc: "本次分页大小" },
      { name: "offset", type: "integer", desc: "本次偏移" },
      { name: "items", type: "object[]", desc: "会话记录数组（不含消息正文）" },
    ],
    errors: [
      { status: 400, message: "invalid filters / invalid pagination", recoverable: true },
      ...UNAUTHORIZED,
    ],
  },
  {
    method: "GET",
    path: "/v1/sessions/:id",
    summary: "获取会话对话消息（仅 idx/role/text/ts，不含会话元数据与消息 raw）",
    description:
      "轻量对话视图：仅返回每条消息的 idx/role/text/ts，不含会话元数据与消息 raw。只看对话流、不关心原始结构时选它，响应体远小于 /full。",
    params: [{ name: "id", in: "path", type: "string", required: true, desc: "会话 ID" }],
    returns: [
      { name: "messages", type: "object[]", desc: "对话消息数组：{ idx, role, text, ts }，按 idx 升序；不含 raw，raw 只在 /full 返回" },
    ],
    errors: [{ status: 404, message: "not found", recoverable: false }, ...UNAUTHORIZED],
  },
  {
    method: "GET",
    path: "/v1/sessions/:id/full",
    summary: "获取单个会话全量详情（会话记录 + 全部消息含 raw）",
    description:
      "全量详情：会话记录 + 全部消息（含 raw 原始结构），审计与回放消息原始形态时用。长会话响应可能很大，建议先用 /full_length 探测大小再决定是否拉取。",
    params: [{ name: "id", in: "path", type: "string", required: true, desc: "会话 ID" }],
    returns: [{ name: "（响应体）", type: "object", desc: "SessionDetail：会话记录 + messages 数组" }],
    errors: [{ status: 404, message: "not found", recoverable: false }, ...UNAUTHORIZED],
  },
  {
    method: "GET",
    path: "/v1/sessions/:id/full_length",
    summary: "获取会话 full 响应体大小（字节数，不返回会话内容）",
    description:
      "只返回 /full 响应体 JSON 序列化后的 UTF-8 字节数，不含任何会话内容。用于拉取 /full 前评估响应体大小。",
    params: [{ name: "id", in: "path", type: "string", required: true, desc: "会话 ID" }],
    returns: [{ name: "full_length", type: "integer", desc: "/full 响应体 JSON 序列化后的 UTF-8 字节数" }],
    errors: [{ status: 404, message: "not found", recoverable: false }, ...UNAUTHORIZED],
  },
  {
    method: "DELETE",
    path: "/v1/sessions/:id",
    summary: "删除会话（软删除）",
    description:
      "软删除：deleted_at 置位，列表/详情/搜索/grep/统计等所有读路径立即不可见。物理数据保留，同三元组重新上传即恢复；不提供物理删除入口。",
    params: [{ name: "id", in: "path", type: "string", required: true, desc: "会话 ID" }],
    returns: [{ name: "ok", type: "boolean", desc: "删除成功" }],
    errors: [{ status: 404, message: "not found", recoverable: false }, ...UNAUTHORIZED],
  },
  {
    method: "POST",
    path: "/v1/search",
    summary: "向量语义搜索会话（活跃 embedding 模型的向量空间）",
    description:
      "语义检索主入口：在活跃 embedding 模型的向量空间内对消息切片（正文 + 从 raw 抽取的 reasoning）做向量检索，返回会话级结果与命中切片，按距离升序。可用 filters 缩小范围。无可用 embedding 提供商时返回 503，此时可退回 /v1/grep 做关键词检索。",
    params: bodyParams(searchRequestSchema, {
      query: "自然语言查询，1..8000 字符",
      top_k: "返回条数，1..50，默认 10",
      filters: "过滤条件，字段同 GET /v1/sessions 的过滤参数（agent/machine/source_id/时间范围）",
    }),
    returns: [
      { name: "model", type: "string", desc: "实际使用的 embedding 模型" },
      { name: "provider", type: "string", desc: "实际服务的提供商名" },
      {
        name: "results",
        type: "object[]",
        desc: "{ session, distance, snippets } 按距离升序；snippets 为命中切片 { message_idx, role, text, ts, source, distance }，source 为 text（正文）｜reasoning（思考）",
      },
    ],
    example: { query: "上周修的那个登录超时问题", top_k: 5 },
    errors: [
      BAD_JSON,
      { status: 400, message: "invalid body（附 zod issues）", recoverable: true },
      { status: 503, message: "embedding unavailable：无可用 embedding 提供商", recoverable: true },
      ...UNAUTHORIZED,
    ],
  },
  {
    method: "GET",
    path: "/v1/grep",
    summary: "关键词子串检索消息正文（LIKE 扫描，字面匹配，不依赖 embedding）",
    description:
      "关键词字面子串检索（LIKE 扫描），不依赖 embedding，是语义检索 503 时的退路。适合精确词（错误码、函数名、文件路径）；LIKE 通配符按字面处理，默认仅 ASCII 大小写折叠。结果按会话分组，分页按命中消息行计。",
    params: queryParams(grepRequestSchema, {
      q: "关键词子串，1..256 字符；%/_/\\ 按字面匹配",
      case_sensitive: "1 开启大小写敏感（默认否；仅 ASCII 折叠）",
      agent: "精确匹配来源 Agent",
      machine: "精确匹配来源机器",
      source_id: "精确匹配来源会话 ID",
      title: "会话标题子串包含过滤",
      created_from: "创建时间下界（毫秒时间戳或可解析的日期字符串）",
      created_to: "创建时间上界",
      updated_from: "修改时间下界",
      updated_to: "修改时间上界",
      limit: "1..200，默认 50（按命中消息行计）",
      offset: ">=0，默认 0",
    }),
    returns: [
      { name: "total", type: "integer", desc: "命中的消息总数" },
      { name: "limit", type: "integer", desc: "本次分页大小" },
      { name: "offset", type: "integer", desc: "本次偏移" },
      {
        name: "items",
        type: "object[]",
        desc: "按会话分组：{ session, hits }；hits 为 { message_idx, role, ts, snippet, match_start }，match_start 是命中在 snippet 内的偏移",
      },
    ],
    errors: [{ status: 400, message: "invalid query（附 zod issues）", recoverable: true }, ...UNAUTHORIZED],
  },
  {
    method: "GET",
    path: "/v1/stats",
    summary: "库内统计（会话数、消息数、索引进度、按 agent/machine 分布）",
    description:
      "只读统计总览：会话/消息总数、indexed/unindexed 索引进度、按 agent/machine 分布、首末会话时间。健康巡检与排障先看这里。",
    params: [],
    returns: [
      { name: "sessions", type: "integer", desc: "会话总数（不含已删除）" },
      { name: "messages", type: "integer", desc: "消息总数" },
      { name: "indexed", type: "integer", desc: "已按活跃模型建向量的会话数" },
      { name: "unindexed", type: "integer", desc: "待补索引数" },
      { name: "by_agent", type: "object", desc: "按 agent 的会话计数" },
      { name: "by_machine", type: "object", desc: "按 machine 的会话计数" },
      { name: "first_session_at", type: "integer", desc: "最早会话创建时间（毫秒）" },
      { name: "last_session_at", type: "integer", desc: "最近会话修改时间（毫秒）" },
    ],
    errors: UNAUTHORIZED,
  },
  {
    method: "GET",
    path: "/v1/settings/providers",
    summary: "读取 embedding 提供商链配置（密钥掩码显示）",
    description:
      "读取当前 embedding 提供商链配置：顺序、模型、权重、启用状态与密钥掩码，密钥不回显明文。只读诊断用，修改走 PUT /v1/settings/providers。",
    params: [],
    returns: [
      { name: "file", type: "string", desc: "当前生效的配置文件路径" },
      { name: "providers", type: "object[]", desc: "提供商列表，含 name/baseUrl/model/weight/enabled/timeoutMs/keySource/keyMasked；不返回完整密钥" },
    ],
    errors: UNAUTHORIZED,
  },
  {
    method: "PUT",
    path: "/v1/settings/providers",
    summary: "整体保存 embedding 提供商链（保存后立即触发一轮补索引）",
    description:
      "整体替换式保存提供商链（非增量合并，请求中未带的提供商会被移除）。apiKey 留空保留该提供商旧密钥。保存成功后自动触发一轮后台补索引；活跃模型变化时需全库重建向量。",
    params: bodyParams(providerSettingsBodySchema, {
      providers: "提供商数组（≤16，name 唯一），元素字段 { name, baseUrl, model?, apiKey?, apiKeyEnv?, weight?, enabled?, timeoutMs? }；apiKey 留空保留该提供商旧密钥",
    }),
    returns: [
      { name: "ok", type: "boolean", desc: "保存成功" },
      { name: "count", type: "integer", desc: "提供商数量" },
    ],
    errors: [BAD_JSON, { status: 400, message: "invalid body（附 zod issues）", recoverable: true }, ...UNAUTHORIZED],
  },
  {
    method: "POST",
    path: "/v1/settings/providers/test",
    summary: "测试指定提供商连通性（真实调用一次 embeddings 接口）",
    description:
      "对指定提供商真实调用一次 embeddings 接口验证连通性，返回延迟、维度、模型名或失败原因。保存前验证用，不改变链路状态。",
    params: bodyParams(z.object({ name: z.string().min(1) }), { name: "要测试的提供商名" }),
    returns: [
      { name: "ok", type: "boolean", desc: "是否连通" },
      { name: "latencyMs", type: "integer", desc: "往返耗时（成功时）" },
      { name: "dim", type: "integer", desc: "向量维度" },
      { name: "model", type: "string", desc: "模型名" },
      { name: "error", type: "string", desc: "失败原因（失败时）" },
    ],
    errors: [{ status: 404, message: "provider not found", recoverable: true }, ...UNAUTHORIZED],
  },
  {
    method: "POST",
    path: "/v1/settings/reindex",
    summary: "手动补索引：对未索引会话同步执行一轮（每批最多 200）",
    description:
      "同步补索引一批（每批最多 200）未索引会话，返回本轮成功/失败/剩余数。remaining 大于 0 时可反复调用直到归零；依赖可用 embedding 提供商。",
    params: [],
    returns: [
      { name: "total", type: "integer", desc: "本轮处理的会话数" },
      { name: "indexed", type: "integer", desc: "本轮成功索引数" },
      { name: "failed", type: "integer", desc: "本轮失败数" },
      { name: "remaining", type: "integer", desc: "剩余未索引数" },
    ],
    errors: UNAUTHORIZED,
  },
];

export function listEndpoints(): { total: number; endpoints: Array<{ method: string; path: string; summary: string }>; hint: string } {
  return {
    total: endpoints.length,
    endpoints: endpoints.map(({ method, path, summary }) => ({ method, path, summary })),
    hint: "对任意接口附加 ?help=1 查看该接口的详细说明（参数/返回/示例/错误）",
  };
}

function matchPath(pattern: string, path: string): boolean {
  if (path.length > 1 && path.endsWith("/")) return false;
  const ps = pattern.split("/").filter(Boolean);
  const ss = path.split("/").filter(Boolean);
  if (ps.length !== ss.length) return false;
  return ps.every((seg, i) => (seg.startsWith(":") ? ss[i]!.length > 0 : seg === ss[i]));
}

export function findEndpoint(method: string, path: string): EndpointHelp | undefined {
  return endpoints.find((e) => e.method === method && matchPath(e.path, path));
}

export function helpRoutes(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(listEndpoints()));
  return app;
}

export function helpInterceptor() {
  return createMiddleware(async (c, next) => {
    if (c.req.query("help") !== "1") return next();
    const doc = findEndpoint(c.req.method, c.req.path);
    if (!doc) return c.json({ error: "endpoint not documented" }, 404);
    return c.json(doc);
  });
}

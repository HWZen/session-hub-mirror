// V1 宿主业务 E2E 专用 loopback mock（仅新增文件；不改动现有 test/helpers）。
//
// 一个进程同时承载两种角色（均只监听 127.0.0.1）：
//  1) Session Hub 镜像端点：使用仓库真实 sessionRoutes + 内存仓库；
//     PUT /v1/sessions 的正文用共享 sessionUpsertSchema 校验，并逐条留档。
//  2) 最小 OpenAI 兼容模型端点 /model/v1/chat/completions（SSE 流式），
//     供 V1 宿主本地 provider（@ai-sdk/openai-compatible，bundled loader）调用。
//
// 另有故障注入（hold / 500 / destroy）用于删除竞争与上传失败诊断场景。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { sessionUpsertSchema } from "../../../../packages/shared/src/session.js";
import type { SessionDetail, SessionUpsertInput } from "../../../../packages/shared/src/session.js";
import type { SessionRepository } from "../../../../server/apps/server/src/db/sessions.js";
import { sessionRoutes } from "../../../../server/apps/server/src/routes/sessions.js";

export interface RecordedRequest {
  seq: number;
  at: number;
  kind: "hub" | "model";
  method: string;
  path: string;
  query: Record<string, string>;
  authenticated: boolean;
  status: number | null;
  note?: string;
}

export interface PutRecord {
  seq: number;
  at: number;
  rawBytes: number;
  sourceId: string | null;
  schemaValid: boolean;
  issues: string | null;
  body: unknown;
  status: number | null;
}

export interface ModelCallRecord {
  seq: number;
  at: number;
  model: string | null;
  stream: boolean;
  includeUsage: boolean;
  lastUserText: string;
  hasToolResult: boolean;
  toolNames: string[];
  action: "text" | "reasoning" | "tool_call";
}

export interface V1MockHandle {
  url: string;
  port: number;
  hubToken: string;
  requests: RecordedRequest[];
  puts: PutRecord[];
  modelCalls: ModelCallRecord[];
  hubRecords(): SessionDetail[];
  findHubRecord(agent: string, machine: string, sourceId: string): SessionDetail | undefined;
  holdNextPut(sourceId: string, ms: number): void;
  failPut(sourceId: string, mode: "500" | "destroy", times: number): void;
  clearFailPuts(sourceId: string): void;
  close(): Promise<void>;
}

export interface V1MockOptions {
  /** `read` 工具调用的目标文件（合成沙箱内文件）。 */
  toolFilePath: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function memoryHub(token: string) {
  const records = new Map<string, SessionDetail>();
  const repo = {
    upsert(input: SessionUpsertInput) {
      const previous = [...records.values()].find(
        (record) => record.agent === input.agent && record.machine === input.machine && record.source_id === input.source_id,
      );
      const id = previous?.id ?? `synthetic-${records.size + 1}`;
      records.set(id, {
        ...structuredClone(input),
        id,
        title: input.title ?? null,
        cwd: input.cwd ?? null,
        deleted_at: null,
        indexed_at: null,
        indexed_model: null,
        messages: input.messages.map((message, idx) => ({
          idx,
          role: message.role,
          text: message.text ?? "",
          ts: message.ts ?? null,
          raw: structuredClone(message.raw ?? null),
        })),
      });
      return { id, created: previous === undefined };
    },
    get(id: string) {
      return records.get(id);
    },
    getConversation(id: string) {
      return records.get(id)?.messages.map(({ raw: _raw, ...message }) => message);
    },
    list(filters: Record<string, unknown>, pagination: { limit: number; offset: number }) {
      const matching = [...records.values()].filter((record) =>
        Object.entries(filters).every(([key, value]) => record[key as keyof SessionDetail] === value),
      );
      return {
        total: matching.length,
        items: matching
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map(({ messages: _messages, ...record }) => record),
      };
    },
    delete(id: string) {
      return records.delete(id);
    },
  };
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.header("authorization") !== `Bearer ${token}`) return context.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.route("/v1/sessions", sessionRoutes({ repo: repo as unknown as SessionRepository }));
  return { app, records };
}

export async function startV1Mock(options: V1MockOptions): Promise<V1MockHandle> {
  const hubToken = randomBytes(24).toString("hex");
  const requests: RecordedRequest[] = [];
  const puts: PutRecord[] = [];
  const modelCalls: ModelCallRecord[] = [];
  const failPuts = new Map<string, { mode: "500" | "destroy"; times: number }>();
  const holdPuts = new Map<string, number>();
  const hub = memoryHub(hubToken);
  let seq = 0;
  let putSeq = 0;
  let modelSeq = 0;

  async function readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  }

  async function handleHub(request: IncomingMessage, response: ServerResponse, url: URL, record: RecordedRequest): Promise<void> {
    record.authenticated = request.headers.authorization === `Bearer ${hubToken}`;
    const raw = await readBody(request);
    if (request.method === "PUT" && url.pathname === "/v1/sessions") {
      let body: unknown = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = null;
      }
      const sourceId = typeof asRecord(body)?.["source_id"] === "string" ? (asRecord(body)!["source_id"] as string) : null;
      const parsed = sessionUpsertSchema.safeParse(body);
      const putRecord: PutRecord = {
        seq: ++putSeq,
        at: Date.now(),
        rawBytes: raw.length,
        sourceId,
        schemaValid: parsed.success,
        issues: parsed.success ? null : JSON.stringify(parsed.error.issues).slice(0, 4000),
        body,
        status: null,
      };
      puts.push(putRecord);
      const failure = sourceId !== null ? failPuts.get(sourceId) : undefined;
      if (failure) {
        failure.times -= 1;
        if (failure.times <= 0) failPuts.delete(sourceId!);
        if (failure.mode === "destroy") {
          record.status = 0;
          record.note = "socket destroyed before response";
          putRecord.status = 0;
          request.socket.destroy();
          return;
        }
        record.status = 500;
        record.note = "synthetic 500";
        putRecord.status = 500;
        jsonResponse(response, 500, { error: "synthetic injected failure" });
        return;
      }
      const hold = sourceId !== null ? holdPuts.get(sourceId) : undefined;
      if (hold !== undefined) {
        holdPuts.delete(sourceId!);
        record.note = `put response held ${hold}ms`;
        await sleep(hold);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const result = await hub.app.fetch(new Request(url, { method: request.method, headers, body: raw }));
      putRecord.status = result.status;
      record.status = result.status;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
    const result = await hub.app.fetch(
      new Request(url, { method: request.method, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: raw }) }),
    );
    record.status = result.status;
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  }

  function sseWrite(response: ServerResponse, payload: unknown): void {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  async function handleModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(raw.toString("utf8")));
    } catch {
      body = null;
    }
    const tools = Array.isArray(body?.["tools"]) ? (body!["tools"] as unknown[]) : [];
    const toolNames = tools
      .map((tool) => asRecord(asRecord(tool)?.["function"])?.["name"])
      .filter((name): name is string => typeof name === "string");
    const messages = Array.isArray(body?.["messages"]) ? (body!["messages"] as unknown[]) : [];
    const lastUser = [...messages].reverse().find((message) => asRecord(message)?.["role"] === "user");
    const lastUserRecord = asRecord(lastUser);
    const content = lastUserRecord?.["content"];
    const lastUserText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (typeof asRecord(part)?.["text"] === "string" ? (asRecord(part)!["text"] as string) : ""))
              .join("\n")
          : "";
    const hasToolResult = messages.some((message) => asRecord(message)?.["role"] === "tool");
    const stream = body?.["stream"] === true;
    const includeUsage = asRecord(body?.["stream_options"])?.["include_usage"] === true;
    const model = typeof body?.["model"] === "string" ? (body!["model"] as string) : "mock-model";
    let action: ModelCallRecord["action"] = "text";
    if (/E2E_TOOL_CALL/.test(lastUserText) && !hasToolResult && toolNames.includes("read")) action = "tool_call";
    else if (/E2E_REASON/.test(lastUserText)) action = "reasoning";
    modelCalls.push({
      seq: ++modelSeq,
      at: Date.now(),
      model,
      stream,
      includeUsage,
      lastUserText: lastUserText.slice(0, 400),
      hasToolResult,
      toolNames,
      action,
    });
    const n = modelSeq;
    const id = `chatcmpl-e2e-${n}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: unknown, finish: string | null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    if (!stream) {
      const message =
        action === "tool_call"
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: `call_e2e_${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: options.toolFilePath }) } },
              ],
            }
          : { role: "assistant", content: `ack-${n}-中文应答` };
      jsonResponse(response, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: action === "tool_call" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
      });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sseWrite(response, chunk({ role: "assistant" }, null));
    if (action === "tool_call") {
      sseWrite(
        response,
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `call_e2e_${n}`,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ filePath: options.toolFilePath }) },
              },
            ],
          },
          null,
        ),
      );
      sseWrite(response, chunk({}, "tool_calls"));
    } else {
      if (action === "reasoning") sseWrite(response, chunk({ reasoning_content: `reasoning-中文-${n}` }, null));
      sseWrite(response, chunk({ content: `ack-${n}-中文应答` }, null));
      sseWrite(response, chunk({}, "stop"));
    }
    sseWrite(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isHub = url.pathname.startsWith("/v1/");
      const record: RecordedRequest = {
        seq: ++seq,
        at: Date.now(),
        kind: isHub ? "hub" : "model",
        method: request.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authenticated: false,
        status: null,
      };
      requests.push(record);
      if (url.pathname === "/model/v1/chat/completions" && request.method === "POST") {
        record.authenticated = true; // 模型端点不校验鉴权，仅登记
        await handleModel(request, response);
        return;
      }
      if (isHub) {
        await handleHub(request, response, url, record);
        return;
      }
      record.status = 404;
      jsonResponse(response, 404, { error: "synthetic mock: unknown route" });
    })().catch((error) => {
      try {
        jsonResponse(response, 400, { error: `synthetic mock failure: ${error instanceof Error ? error.message : String(error)}` });
      } catch {
        /* response already gone */
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("V1 mock listener has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    hubToken,
    requests,
    puts,
    modelCalls,
    hubRecords: () => [...hub.records.values()],
    findHubRecord: (agent, machine, sourceId) =>
      [...hub.records.values()].find(
        (record) => record.agent === agent && record.machine === machine && record.source_id === sourceId,
      ),
    holdNextPut(sourceId, ms) {
      holdPuts.set(sourceId, ms);
    },
    failPut(sourceId, mode, times) {
      failPuts.set(sourceId, { mode, times });
    },
    clearFailPuts(sourceId) {
      failPuts.delete(sourceId);
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

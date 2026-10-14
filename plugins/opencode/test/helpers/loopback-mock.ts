import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Hono } from "hono";
import type { SessionDetail, SessionUpsertInput } from "../../../../packages/shared/src/session.js";
import type { SessionRepository } from "../../../../server/apps/server/src/db/sessions.js";
import { sessionRoutes } from "../../../../server/apps/server/src/routes/sessions.js";

export interface LoopbackFixture {
  session: SessionInfo;
  messages: SessionMessageInfo[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authenticated: boolean;
}

export function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startLoopbackMock(fixture: LoopbackFixture) {
  const authorization = `Basic ${Buffer.from(`opencode:${randomBytes(24).toString("hex")}`).toString("base64")}`;
  const requests: RecordedRequest[] = [];
  const hubToken = randomBytes(24).toString("hex");
  const hub = memoryHub(hubToken);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isHub = url.pathname.startsWith("/v1/");
      const authenticated = request.headers.authorization === (isHub ? `Bearer ${hubToken}` : authorization);
      requests.push({ method: request.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), authenticated });
      if (isHub) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const method = request.method ?? "GET";
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
        const body = Buffer.concat(chunks).toString("utf8");
        const result = await hub.fetch(new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
        return;
      }
      if (!authenticated) {
        jsonResponse(response, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/rpc/synthetic-history/list") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: Record<string, unknown> };
        const input = body.input;
        if (input["sessionID"] !== fixture.session.id) {
          jsonResponse(response, 404, { _tag: "RpcError", type: "rpc.not_found", message: "Unknown synthetic session" });
          return;
        }
        const query = new URLSearchParams();
        for (const key of ["limit", "order", "cursor"]) if (input[key] !== undefined) query.set(key, String(input[key]));
        try {
          jsonResponse(response, 200, { output: historyPage(query, fixture) });
        } catch (error) {
          jsonResponse(response, 400, { _tag: "RpcError", type: "rpc.invalid_input", message: error instanceof Error ? error.message : "Invalid input" });
        }
        return;
      }
      handleHistory(request, response, url, fixture);
    })().catch(() => jsonResponse(response, 400, { _tag: "InvalidRequestError", message: "Invalid synthetic request" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback listener has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    authorization,
    hubToken,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

function memoryHub(token: string): Hono {
  const records = new Map<string, SessionDetail>();
  const repo = {
    upsert(input: SessionUpsertInput) {
      const previous = [...records.values()].find((record) =>
        record.agent === input.agent && record.machine === input.machine && record.source_id === input.source_id);
      const id = previous?.id ?? `synthetic-${records.size + 1}`;
      records.set(id, {
        ...structuredClone(input), id, title: input.title ?? null, cwd: input.cwd ?? null,
        deleted_at: null, indexed_at: null, indexed_model: null,
        messages: input.messages.map((message, idx) => ({
          idx, role: message.role, text: message.text ?? "", ts: message.ts ?? null, raw: structuredClone(message.raw ?? null),
        })),
      });
      return { id, created: previous === undefined };
    },
    get(id: string) { return records.get(id); },
    getConversation(id: string) {
      return records.get(id)?.messages.map(({ raw: _raw, ...message }) => message);
    },
    list(filters: Record<string, unknown>, pagination: { limit: number; offset: number }) {
      const matching = [...records.values()].filter((record) =>
        Object.entries(filters).every(([key, value]) => record[key as keyof SessionDetail] === value));
      return { total: matching.length, items: matching.slice(pagination.offset, pagination.offset + pagination.limit).map(({ messages: _messages, ...record }) => record) };
    },
    delete(id: string) { return records.delete(id); },
  };
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.header("authorization") !== `Bearer ${token}`) return context.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.route("/v1/sessions", sessionRoutes({ repo: repo as unknown as SessionRepository }));
  return app;
}

function historyPage(query: URLSearchParams, fixture: LoopbackFixture) {
  if (query.has("cursor") && query.has("order")) throw new Error("Cursor cannot be combined with order");
  const decoded = query.has("cursor")
    ? JSON.parse(Buffer.from(query.get("cursor")!, "base64url").toString("utf8")) as { id: string; order: string; direction: string }
    : undefined;
  if (decoded && (decoded.order !== "asc" || decoded.direction !== "next" || typeof decoded.id !== "string")) {
    throw new Error("Invalid cursor");
  }
  const limit = Number(query.get("limit") ?? "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid limit");
  if (!decoded && query.get("order") !== "asc") throw new Error("Fixture expects ascending order");
  const anchor = decoded ? fixture.messages.findIndex((message) => message.id === decoded.id) : -1;
  const data = decoded && anchor < 0 ? [] : fixture.messages.slice(anchor + 1, anchor + 1 + limit);
  const last = data.at(-1);
  const next = last ? Buffer.from(JSON.stringify({ id: last.id, order: "asc", direction: "next" })).toString("base64url") : undefined;
  return { data, cursor: next ? { next } : {} };
}

function handleHistory(request: IncomingMessage, response: ServerResponse, url: URL, fixture: LoopbackFixture): void {
  const sessionPath = `/api/session/${encodeURIComponent(fixture.session.id)}`;
  if (request.method === "GET" && url.pathname === sessionPath) {
    jsonResponse(response, 200, { data: fixture.session });
    return;
  }
  if (request.method === "GET" && url.pathname === `${sessionPath}/message`) {
    try {
      jsonResponse(response, 200, historyPage(url.searchParams, fixture));
    } catch (error) {
      jsonResponse(response, 400, { _tag: "InvalidCursorError", message: error instanceof Error ? error.message : "Invalid cursor" });
    }
    return;
  }
  jsonResponse(response, 404, { _tag: "SessionNotFoundError", message: "Unknown synthetic route" });
}

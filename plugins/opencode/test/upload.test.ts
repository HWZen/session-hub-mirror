import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteSession,
  listSessions,
  mirrorDelete,
  loadConfig,
  transformSession,
  uploadSession,
  type SessionHubConfig,
  type TransformedSession,
} from "../src/plugin.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const captured: CapturedRequest[] = [];
let respond: ((req: CapturedRequest, what: string) => { status: number; body?: unknown }) | null = null;
let server: Server;
let baseUrl = "";

const defaultRespond = (req: CapturedRequest): { status: number; body?: unknown } => {
  if (req.method === "PUT" && req.url === "/v1/sessions") return { status: 201, body: { id: "uuid-1", created: true, indexed: true } };
  if (req.method === "GET" && req.url.startsWith("/v1/sessions?")) {
    return { status: 200, body: { total: 1, items: [{ id: "uuid-1", agent: "opencode", machine: "M1", source_id: "ses_1" }] } };
  }
  if (req.method === "DELETE" && req.url === "/v1/sessions/uuid-1") return { status: 200, body: { ok: true } };
  return { status: 500, body: { error: "unexpected" } };
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const capturedReq: CapturedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
    };
    captured.push(capturedReq);
    const result = (respond ?? defaultRespond)(capturedReq, capturedReq.url);
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  config = { baseUrl, token: "test-token", timeoutMs: 2000 };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let config: SessionHubConfig;

function samplePayload(): TransformedSession {
  return transformSession(
    { id: "ses_1", title: "t", directory: "/d", time_created: 1000, time_updated: 2000 },
    [{ role: "user", parts: [{ type: "text", text: "hello" }], time_created: 1500 }],
    "M1",
  );
}

async function withStalledBody(run: (config: SessionHubConfig, started: Promise<void>) => Promise<void>): Promise<void> {
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const stalled = createServer(async (req, res) => {
    for await (const _ of req) { /* consume synthetic request */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"items":[');
    start();
  });
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const address = stalled.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, token: "synthetic-body-test", timeoutMs: 100 }, started);
  } finally {
    stalled.closeAllConnections();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
  }
}

const bodyOperations = [
  { method: "PUT", run: (cfg: SessionHubConfig, signal?: AbortSignal) => uploadSession(cfg, samplePayload(), signal) },
  { method: "GET", run: (cfg: SessionHubConfig, signal?: AbortSignal) => listSessions(cfg, { agent: "opencode", machine: "M1", source_id: "ses_1" }, signal) },
  { method: "DELETE", run: (cfg: SessionHubConfig, signal?: AbortSignal) => deleteSession(cfg, "uuid-1", signal) },
];

async function outcomeWithin(work: Promise<unknown>, ms: number): Promise<string> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work.then(() => "resolved", (error: unknown) => error instanceof Error ? error.name : "rejected"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("pending"), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function withDestroyedBody(run: (config: SessionHubConfig, started: Promise<void>) => Promise<void>): Promise<void> {
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const truncated = createServer(async (req, res) => {
    for await (const _ of req) { /* consume synthetic request */ }
    res.writeHead(201, { "content-type": "application/json" });
    res.write('{"id":"uuid-1",');
    start();
    setTimeout(() => res.destroy(), 40);
  });
  await new Promise<void>((resolve) => truncated.listen(0, "127.0.0.1", resolve));
  const address = truncated.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, token: "synthetic-truncated-test", timeoutMs: 2000 }, started);
  } finally {
    truncated.closeAllConnections();
    await new Promise<void>((resolve) => truncated.close(() => resolve()));
  }
}

describe("HTTP response body lifecycle", () => {
  it("does not swallow a mid-body transport failure as a null-body success", async () => {
    await withDestroyedBody(async (cfg, started) => {
      const work = uploadSession(cfg, samplePayload());
      await started;
      const outcome = await outcomeWithin(work, 1500);
      expect(outcome).not.toBe("resolved");
      expect(outcome).not.toBe("pending");
    });
  });
  it.each(bodyOperations)("$method times out after headers when the JSON body never finishes", async ({ run }) => {
    await withStalledBody(async (cfg, started) => {
      const work = run(cfg);
      await started;
      expect(await outcomeWithin(work, 600)).toBe("AbortError");
    });
  });

  it.each(bodyOperations)("$method rejects lifecycle cancellation during a stalled JSON body", async ({ run }) => {
    await withStalledBody(async (cfg, started) => {
      const controller = new AbortController();
      const work = run({ ...cfg, timeoutMs: 2000 }, controller.signal);
      await started;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      controller.abort();
      expect(await outcomeWithin(work, 600)).toBe("AbortError");
    });
  });
});

describe("uploadSession", () => {
  it("PUTs Bearer-authenticated JSON to /v1/sessions", async () => {
    const result = await uploadSession(config, samplePayload());
    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: "uuid-1", created: true, indexed: true });
    const req = captured.at(-1)!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/v1/sessions");
    expect(req.headers["authorization"]).toBe("Bearer test-token");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toMatchObject({ agent: "opencode", machine: "M1", source_id: "ses_1" });
  });

  it("rejects before sending when its lifecycle signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const previousCount = captured.length;
    await expect(uploadSession(config, samplePayload(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(captured).toHaveLength(previousCount);
  });

  it("reports server errors as not ok", async () => {
    respond = () => ({ status: 401, body: { error: "unauthorized" } });
    const result = await uploadSession(config, samplePayload());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    respond = null;
  });
});

describe("mirrorDelete", () => {
  it("lists by source_id then deletes each hit", async () => {
    const result = await mirrorDelete(config, "M1", "ses_1");
    expect(result).toEqual({ found: 1, deleted: 1 });
    const listReq = captured.at(-2)!;
    expect(listReq.method).toBe("GET");
    const query = new URLSearchParams(listReq.url.slice("/v1/sessions?".length));
    expect(query.get("agent")).toBe("opencode");
    expect(query.get("machine")).toBe("M1");
    expect(query.get("source_id")).toBe("ses_1");
    const delReq = captured.at(-1)!;
    expect(delReq.method).toBe("DELETE");
    expect(delReq.url).toBe("/v1/sessions/uuid-1");
    expect(delReq.headers["authorization"]).toBe("Bearer test-token");
  });

  it("does not start mirror deletion after lifecycle cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const previousCount = captured.length;
    await expect(mirrorDelete(config, "M1", "ses_1", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(captured).toHaveLength(previousCount);
  });

  it("reports zero deletions on empty list", async () => {
    respond = (req) => {
      expect(req.method).toBe("GET");
      return { status: 200, body: { total: 0, items: [] } };
    };
    expect(await mirrorDelete(config, "M1", "ses_1")).toEqual({ found: 0, deleted: 0 });
    respond = null;
  });

  it("throws when list request fails", async () => {
    respond = () => ({ status: 503, body: {} });
    await expect(mirrorDelete(config, "M1", "ses_1")).rejects.toThrow();
    respond = null;
  });
});

describe("listSessions / deleteSession", () => {
  it("url-encodes the delete target", async () => {
    respond = (req) => {
      expect(req.url).toBe("/v1/sessions/sp%20ace");
      return { status: 200, body: { ok: true } };
    };
    expect(await deleteSession(config, "sp ace")).toBe(true);
    respond = null;
  });
});

describe("loadConfig", () => {
  it("reads env overrides", () => {
    expect(
      loadConfig({ SESSION_HUB_URL: "http://hub:7428", SESSION_HUB_TOKEN: "tok" }),
    ).toEqual({ baseUrl: "http://hub:7428", token: "tok", timeoutMs: 15000 });
  });

  it("returns null without config", () => {
    const missingPath = "does-not-exist-config.json";
    expect(loadConfig({}, missingPath)).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "not a url", SESSION_HUB_TOKEN: "t" }, missingPath)).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "http://x", SESSION_HUB_TOKEN: "" }, missingPath)).toBeNull();
  });

  it("normalizes trailing slash", () => {
    expect(loadConfig({ SESSION_HUB_URL: "http://x:1/", SESSION_HUB_TOKEN: "t" })!.baseUrl).toBe("http://x:1");
  });
});

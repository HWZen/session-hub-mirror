import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionHubConfig } from "../src/config.js";
import type { TransformedSession } from "../src/transform.js";
import { uploadSession } from "../src/upload.js";

let server: Server;
let baseUrl = "";
let captured: { method?: string; url?: string; authorization?: string; body: string } | null = null;

beforeAll(async () => {
  server = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    captured = {
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      body,
    };
    response.writeHead(201, { "content-type": "application/json" });
    response.end('{"created":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

describe("uploadSession", () => {
  it("PUTs a bearer-authenticated session snapshot", async () => {
    const config: SessionHubConfig = { baseUrl, token: "test-token", timeoutMs: 2000 };
    const payload: TransformedSession = {
      agent: "codex",
      machine: "TEST-PC",
      source_id: "s1",
      created_at: 1,
      updated_at: 2,
      messages: [],
    };
    expect(await uploadSession(config, payload)).toMatchObject({ ok: true, status: 201 });
    expect(captured).toMatchObject({
      method: "PUT",
      url: "/v1/sessions",
      authorization: "Bearer test-token",
    });
    expect(JSON.parse(captured!.body)).toMatchObject({ agent: "codex", source_id: "s1" });
  });
});

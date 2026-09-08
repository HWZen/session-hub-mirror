import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHook, type HookStdinEvent, type RunHookDeps } from "../src/workbuddy/hook.js";
import { uploadSession, type UploadResult } from "../src/workbuddy/upload.js";
import type { SessionHubConfig } from "../src/workbuddy/config.js";
import type { SessionUpsertInput } from "@session-hub/shared";

function stdinEvent(event: Partial<HookStdinEvent>): string {
  return JSON.stringify({ hook_event_name: "Stop", ...event });
}

const transcript = [
  JSON.stringify({ timestamp: "2026-09-07T10:00:00.000Z", message: { role: "user", content: "<user_query>hello wb</user_query>" } }),
  JSON.stringify({ timestamp: "2026-09-07T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } }),
].join("\n");

function fakeDeps(overrides: Partial<RunHookDeps> = {}): RunHookDeps & { uploaded: SessionUpsertInput[] } {
  const uploaded: SessionUpsertInput[] = [];
  return {
    uploaded,
    config: { baseUrl: "http://hub.local", token: "tok", timeoutMs: 2000 },
    machine: "M1",
    readTranscript: () => transcript,
    upload: async (_config, payload) => {
      uploaded.push(payload);
      return { ok: true, status: 201, body: { id: "u1" } };
    },
    ...overrides,
  };
}

describe("runHook", () => {
  it("uploads parsed session and stays silent on stdout with exit 0", async () => {
    const deps = fakeDeps();
    const outcome = await runHook(
      stdinEvent({ session_id: "ses_9", transcript_path: "C:/t/x.jsonl", cwd: "D:/w" }),
      deps,
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.uploaded).toBe(true);
    expect(outcome.status).toBe(201);
    expect(outcome.logLines.join("\n")).toContain("session=ses_9");
    expect(deps.uploaded).toHaveLength(1);
    expect(deps.uploaded[0]).toMatchObject({
      agent: "workbuddy",
      machine: "M1",
      source_id: "ses_9",
      cwd: "D:/w",
      created_at: Date.parse("2026-09-07T10:00:00.000Z"),
      updated_at: Date.parse("2026-09-07T10:00:05.000Z"),
    });
    expect(deps.uploaded[0]!.messages[0]).toMatchObject({ role: "user", text: "hello wb" });
  });

  it("exits 0 without upload on invalid stdin JSON", async () => {
    const deps = fakeDeps();
    const outcome = await runHook("{{{not json", deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.stderr).toContain("invalid stdin");
    expect(deps.uploaded).toHaveLength(0);
  });

  it("exits 0 without upload when unconfigured", async () => {
    const deps = fakeDeps({ config: null });
    const outcome = await runHook(stdinEvent({ transcript_path: "C:/t/x.jsonl" }), deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.stderr).toContain("not configured");
    expect(deps.uploaded).toHaveLength(0);
  });

  it("exits 0 without upload when transcript_path missing", async () => {
    const deps = fakeDeps();
    const outcome = await runHook(stdinEvent({ session_id: "s" }), deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(deps.uploaded).toHaveLength(0);
  });

  it("exits 0 when transcript unreadable", async () => {
    const deps = fakeDeps({
      readTranscript: () => {
        throw new Error("ENOENT");
      },
    });
    const outcome = await runHook(stdinEvent({ transcript_path: "C:/t/gone.jsonl" }), deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.stderr).toContain("ENOENT");
    expect(deps.uploaded).toHaveLength(0);
  });

  it("exits 0 when upload throws", async () => {
    const deps = fakeDeps({
      upload: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await runHook(stdinEvent({ transcript_path: "C:/t/x.jsonl" }), deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.stderr).toContain("boom");
  });

  it("exits 0 when upload returns non-ok status", async () => {
    const deps = fakeDeps({
      upload: async () => ({ ok: false, status: 401, body: { error: "unauthorized" } }),
    });
    const outcome = await runHook(stdinEvent({ transcript_path: "C:/t/x.jsonl" }), deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.logLines.join("\n")).toContain("uploaded=false");
  });

  it("exits 0 on SessionEnd reason pass-through", async () => {
    const deps = fakeDeps();
    const outcome = await runHook(
      stdinEvent({ hook_event_name: "SessionEnd", reason: "clear", transcript_path: "C:/t/x.jsonl" }),
      deps,
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(true);
    expect(outcome.logLines.join("\n")).toContain("reason=clear");
  });
});

describe("runHook over real HTTP", () => {
  interface Captured {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }
  const captured: Captured[] = [];
  let delayMs = 0;
  let server: Server;
  let config: SessionHubConfig;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "uuid-1", created: true, indexed: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    config = { baseUrl: `http://127.0.0.1:${address.port}`, token: "tok-1", timeoutMs: 5000 };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends Bearer-authenticated PUT with validated payload", async () => {
    const outcome = await runHook(
      stdinEvent({ session_id: "ses_http", transcript_path: "C:/t/x.jsonl" }),
      fakeDeps({ config, upload: (cfg, payload) => uploadSession(cfg, payload) }),
    );
    expect(outcome.uploaded).toBe(true);
    const req = captured.at(-1)!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/v1/sessions");
    expect(req.headers["authorization"]).toBe("Bearer tok-1");
    expect(req.body).toMatchObject({ agent: "workbuddy", machine: "M1", source_id: "ses_http" });
  });

  it("gives up after timeout and still exits 0", async () => {
    delayMs = 400;
    const slowConfig: SessionHubConfig = { ...config, timeoutMs: 50 };
    const outcome = await runHook(
      stdinEvent({ session_id: "ses_slow", transcript_path: "C:/t/x.jsonl" }),
      fakeDeps({ config: slowConfig, upload: (cfg, payload) => uploadSession(cfg, payload) }),
    );
    delayMs = 0;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.uploaded).toBe(false);
    expect(outcome.stderr).toContain("abort");
  });
});

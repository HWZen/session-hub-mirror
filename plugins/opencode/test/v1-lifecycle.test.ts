import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sessionHubPlugin } from "../src/plugin.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let server: Server;
let operations: string[];
let errors: string[];
let onPut: (res: ServerResponse) => Promise<void>;
let onGet: (res: ServerResponse) => Promise<void>;
let putResponse: () => { status: number; body: unknown };
let putClosed: boolean;
let getClosed: boolean;
let hooks: { event(input: { event: unknown }): Promise<void>; dispose(): Promise<void> };
let getSnapshot: () => Promise<unknown>;
let hadUrl: string | undefined;
let hadToken: string | undefined;
const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
const deleted = () => hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });

beforeEach(async () => {
  operations = [];
  errors = [];
  onPut = async () => {};
  onGet = async () => {};
  putResponse = () => ({ status: 200, body: { id: "mirror-1", ok: true } });
  putClosed = false;
  getClosed = false;
  server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    operations.push(req.method ?? "");
    if (req.method === "PUT") {
      res.once("close", () => { putClosed = true; });
      await onPut(res);
    }
    if (req.method === "GET") {
      res.once("close", () => { getClosed = true; });
      await onGet(res);
    }
    if (res.destroyed || res.writableEnded) return;
    if (req.method === "PUT") {
      const scripted = putResponse();
      res.statusCode = scripted.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(scripted.body));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "GET" ? { items: [{ id: "mirror-1" }] } : { id: "mirror-1", ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  hadUrl = process.env["SESSION_HUB_URL"];
  hadToken = process.env["SESSION_HUB_TOKEN"];
  process.env["SESSION_HUB_URL"] = `http://127.0.0.1:${address.port}`;
  process.env["SESSION_HUB_TOKEN"] = "synthetic-v1-test";
  getSnapshot = async () => ({ data: { id: "s1", title: "synthetic", directory: "D:/synthetic", time: { created: 100, updated: 200 } } });
  hooks = await sessionHubPlugin({
    client: {
      session: {
        get: () => getSnapshot(),
        messages: async () => ({ data: [{ info: { role: "user", time: { created: 150 } }, parts: [{ type: "text", text: "synthetic" }] }] }),
      },
      app: { log: async ({ body }: { body: { level: string; message: string } }) => { if (body.level === "error") errors.push(body.message); return {}; } },
    },
  } as never) as unknown as typeof hooks;
});

afterEach(async () => {
  await hooks?.dispose();
  expect(errors).toEqual([]);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (hadUrl === undefined) delete process.env["SESSION_HUB_URL"];
  else process.env["SESSION_HUB_URL"] = hadUrl;
  if (hadToken === undefined) delete process.env["SESSION_HUB_TOKEN"];
  else process.env["SESSION_HUB_TOKEN"] = hadToken;
});

it("V1 delete cancels its pending idle snapshot without a subsequent PUT", async () => {
  await idle();
  await deleted();
  await sleep(3200);
  expect(operations).toEqual(["GET", "DELETE"]);
}, 10000);

it("V1 delete prevents an already-reading snapshot from uploading", async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  getSnapshot = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  await idle();
  await reading;
  await deleted();
  await sleep(50);
  release({ data: { id: "s1", time: { created: 100, updated: 200 } } });
  await sleep(700);
  expect(operations).toEqual(["GET", "DELETE"]);
}, 10000);

it("V1 dispose prevents an already-reading snapshot from uploading", async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  getSnapshot = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  await idle();
  await reading;
  await hooks.dispose();
  release({ data: { id: "s1", time: { created: 100, updated: 200 } } });
  await sleep(700);
  expect(operations).toEqual([]);
}, 10000);

it("V1 mirror delete waits for an in-flight PUT to finish", async () => {
  let release!: () => void;
  let started!: () => void;
  const uploading = new Promise<void>((resolve) => { started = resolve; });
  onPut = () => { started(); return new Promise<void>((resolve) => { release = resolve; }); };
  await idle();
  await uploading;
  await deleted();
  await sleep(100);
  try {
    expect(operations).toEqual(["PUT"]);
  } finally {
    release();
    await sleep(700);
  }
  expect(operations).toEqual(["PUT", "GET", "DELETE"]);
}, 10000);

it("V1 coalesces idle while a snapshot read is still in flight", async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  let reads = 0;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const data = { data: { id: "s1", time: { created: 100, updated: 200 } } };
  getSnapshot = () => {
    reads++;
    if (reads === 1) { started(); return new Promise((resolve) => { release = resolve; }); }
    return Promise.resolve(data);
  };
  await idle();
  await reading;
  await idle();
  await sleep(3200);
  try { expect(reads).toBe(1); }
  finally { release(data); await sleep(700); }
  expect(reads).toBe(2);
  expect(operations).toEqual(["PUT", "PUT"]);
}, 15000);

it("V1 dispose aborts an in-flight upload connection", async () => {
  let release!: () => void;
  let started!: () => void;
  const uploading = new Promise<void>((resolve) => { started = resolve; });
  onPut = () => { started(); return new Promise<void>((resolve) => { release = resolve; }); };
  await idle();
  await uploading;
  try {
    await hooks.dispose();
    await sleep(200);
    expect(putClosed).toBe(true);
  } finally { release(); await sleep(100); }
}, 10000);

it("V1 upload errors log only status, never the token or the response body", async () => {
  putResponse = () => ({ status: 500, body: { error: "BODY-MARKER-LEAK" } });
  await idle();
  await sleep(3300);
  expect(operations).toEqual(["PUT"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("status=500");
  const joined = errors.join("\n");
  expect(joined).not.toContain(process.env["SESSION_HUB_TOKEN"]);
  expect(joined).not.toContain("BODY-MARKER-LEAK");
  errors.length = 0;
}, 10000);

it.each([false, true])("V1 dispose cancels in-flight mirror GET (headers sent=%s) without a later DELETE", async (sendHeaders) => {
  let release!: () => void;
  let started!: () => void;
  const listing = new Promise<void>((resolve) => { started = resolve; });
  onGet = async (res) => {
    if (sendHeaders) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"items":[');
    }
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    if (sendHeaders && !res.destroyed) res.end('{"id":"mirror-1"}]}');
  };
  await deleted();
  await listing;
  await sleep(50);
  try {
    await hooks.dispose();
    await sleep(100);
    expect(getClosed).toBe(true);
  } finally { release(); await sleep(100); }
  expect(operations).toEqual(["GET"]);
});

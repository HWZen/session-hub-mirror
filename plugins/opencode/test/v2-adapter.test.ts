import { describe, expect, it } from "vitest";
import { createSessionHubV2Setup } from "../src/adapter-v2.js";

const SELF = "D:\\plugs\\session-hub.js";
const DEBOUNCE = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value?: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as never;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FeedOptions {
  failAfter?: number;
}

function makeFeed(options: FeedOptions = {}) {
  const events: unknown[] = [];
  let closed = false;
  let signal: AbortSignal | undefined;
  let deliveries = 0;
  let subscribeCalls = 0;

  const feed = {
    subscribe(opts?: { signal?: AbortSignal }) {
      subscribeCalls++;
      signal = opts?.signal;
      return feed;
    },
    push(event: unknown) {
      events.push(event);
    },
    close() {
      closed = true;
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    get signal() {
      return signal;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      while (!closed) {
        if (signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        if (options.failAfter !== undefined && deliveries >= options.failAfter) {
          throw new Error("stream broke");
        }
        if (events.length > 0) {
          deliveries++;
          yield events.shift();
          continue;
        }
        await sleep(2);
      }
    },
  };
  return feed;
}

function v2Session(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_1",
    projectID: "proj_1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 200 },
    title: "title",
    location: { directory: "D:/work" },
    ...overrides,
  };
}

function capabilityClient(input: { version?: string; pid?: number; onInfo?: () => void } = {}) {
  return {
    server: {
      info: async () => {
        input.onInfo?.();
        return { version: input.version ?? "2.0.26", pid: input.pid ?? process.pid };
      },
    },
    plugin: {
      list: async () => ({
        data: [{ id: "session-hub", source: { type: "local", path: SELF }, features: {}, state: { status: "active" } }],
      }),
    },
  };
}

const CONFIG = { baseUrl: "http://sh.test", token: "mock-token", timeoutMs: 1000 };

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadConfig: () => CONFIG,
    makeClient: () => capabilityClient() as never,
    readSnapshot: async () => ({ session: v2Session() as never, messages: [] as never }),
    upload: async () => ({ ok: true, status: 201, body: {} }),
    mirrorDelete: async () => ({ found: 1, deleted: 1 }),
    log: () => undefined,
    debounceMs: DEBOUNCE,
    machine: "M1",
    selfUrl: SELF,
    ...overrides,
  } as never;
}

function makeCtx(feed: unknown, options: Record<string, unknown> = {}) {
  return {
    app: { version: "2.0.26" },
    location: { directory: "D:/work" },
    options,
    event: feed,
    session: { get: async ({ sessionID }: { sessionID: string }) => v2Session({ id: sessionID }) },
  } as never;
}

const CREDENTIALS = { endpoint: "http://127.0.0.1:4096", auth: { password: "mock-pass" } };

describe("createSessionHubV2Setup — gating", () => {
  it("stays disabled without Session Hub config", async () => {
    const logs: string[] = [];
    const feed = makeFeed();
    const setup = createSessionHubV2Setup(baseDeps({ loadConfig: () => null, log: (_l: string, m: string) => logs.push(m) }));
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));
    expect(cleanup).toBeUndefined();
    expect(feed.subscribeCalls).toBe(0);
    expect(logs.join("\n")).toMatch(/未配置/);
  });

  it("reports not-ready without a usable endpoint and never uploads", async () => {
    const logs: string[] = [];
    const feed = makeFeed();
    const setup = createSessionHubV2Setup(baseDeps({ log: (_l: string, m: string) => logs.push(m) }));

    await setup(makeCtx(feed, {}));
    expect(feed.subscribeCalls).toBe(0);

    await setup(makeCtx(feed, { endpoint: "http://10.0.0.7:4096" }));
    expect(feed.subscribeCalls).toBe(0);

    expect(logs.filter((line) => line.includes("未就绪")).length).toBe(2);
  });
});

describe("createSessionHubV2Setup — sync pipeline", () => {
  it("uploads after the real V2 execution succeeded event without legacy idle events", async () => {
    const feed = makeFeed();
    const uploads: string[] = [];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async (_config: never, payload: { source_id: string }) => {
        uploads.push(payload.source_id);
        return { ok: true, status: 201, body: {} };
      },
    }))(makeCtx(feed, CREDENTIALS));
    try {
      feed.push({
        id: "evt_completed", created: 200, type: "session.execution.succeeded",
        durable: { aggregateID: "ses_1", seq: 1, version: 1 },
        data: { sessionID: "ses_1" },
      });
      await sleep(DEBOUNCE * 3);
      expect(uploads).toEqual(["ses_1"]);
    } finally {
      await cleanup?.();
    }
  });

  it.each([
    ["session.execution.failed", {}],
    ["session.execution.interrupted", { reason: "user" }],
    ["session.execution.interrupted", { reason: "superseded" }],
    ["session.execution.interrupted", { reason: "inactivity" }],
  ])("mirrors terminal execution %s %j without legacy idle events", async (type, extra) => {
    const feed = makeFeed();
    const uploads: string[] = [];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async (_config: never, payload: { source_id: string }) => {
        uploads.push(payload.source_id);
        return { ok: true, status: 201, body: {} };
      },
    }))(makeCtx(feed, CREDENTIALS));
    try {
      feed.push({ type, data: { sessionID: "ses_1", ...extra } });
      await sleep(DEBOUNCE * 3);
      expect(uploads).toEqual(["ses_1"]);
    } finally {
      await cleanup?.();
    }
  });

  it("does not treat started, step ended, or shutdown interruption as terminal idle", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    try {
      feed.push({ type: "session.execution.started", data: { sessionID: "ses_1" } });
      feed.push({ type: "session.step.ended", data: { sessionID: "ses_1" } });
      feed.push({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "shutdown" } });
      await sleep(DEBOUNCE * 3);
      expect(uploads).toBe(0);
    } finally {
      await cleanup?.();
    }
  });

  it("blocks an endpoint with matching version and plugin path but different host source session", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      readSnapshot: async () => ({ session: v2Session({ location: { directory: "D:/other-instance" } }), messages: [] }),
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(0);
    await cleanup?.();
  });

  it("retains the source cwd for a matching cross-directory host event", async () => {
    const feed = makeFeed();
    const cwd = "D:/another-project";
    const uploaded: Array<{ cwd: string }> = [];
    const ctx = { app: { version: "2.0.26" }, location: { directory: "D:/work" }, options: CREDENTIALS, event: feed,
      session: { get: async () => v2Session({ location: { directory: cwd } }) } };
    const cleanup = await createSessionHubV2Setup(baseDeps({
      readSnapshot: async () => ({ session: v2Session({ location: { directory: cwd } }), messages: [] }),
      upload: async (_config: never, payload: { cwd: string }) => {
        uploaded.push(payload); return { ok: true, status: 201, body: {} };
      },
    }))(ctx as never);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploaded.map((payload) => payload.cwd)).toEqual([cwd]);
    await cleanup?.();
  });

  it("blocks an endpoint whose server pid is not the host process", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let uploads = 0;
    let pids = [process.pid + 1, process.pid];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => capabilityClient({ get pid() { return pids.shift() ?? process.pid; } }),
      log: (_l: string, m: string) => logs.push(m),
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(0);
    expect(logs.join("\n")).toMatch(/未就绪|版本|PID|pid/);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(1);
    await cleanup?.();
  });

  it("blocks a takeover endpoint that changes pid mid-session", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let uploads = 0;
    let pids = [process.pid, process.pid + 7];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => capabilityClient({ get pid() { return pids.shift() ?? process.pid + 7; } }),
      readSnapshot: async (_c: never, id: string) => ({ session: v2Session({ id }), messages: [] }),
      log: (_l: string, m: string) => logs.push(m),
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(1);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(1);
    expect(logs.join("\n")).toMatch(/未就绪|版本|PID|pid/);
    await cleanup?.();
  });

  it("blocks a takeover delete without mirroring onto the wrong instance", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let deletes = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => capabilityClient({ pid: process.pid + 5 }),
      log: (_l: string, m: string) => logs.push(m),
      mirrorDelete: async () => { deletes++; return { found: 1, deleted: 1 }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(40);
    expect(deletes).toBe(0);
    expect(logs.join("\n")).toMatch(/未就绪|版本|PID|pid/);
    await cleanup?.();
  });

  it("re-verifies the instance for each delete operation instead of caching", async () => {
    const feed = makeFeed();
    let deletes = 0;
    let pids = [process.pid + 1, process.pid];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => capabilityClient({ get pid() { return pids.shift() ?? process.pid; } }),
      mirrorDelete: async () => { deletes++; return { found: 1, deleted: 1 }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(40);
    expect(deletes).toBe(0);
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(40);
    expect(deletes).toBe(1);
    await cleanup?.();
  });

  it("shares one lazy capability check across concurrent sessions", async () => {
    const feed = makeFeed();
    const verified = deferred();
    let infoCalls = 0;
    const uploads: string[] = [];
    const client = capabilityClient();
    client.server.info = async () => {
      infoCalls++;
      await verified.promise;
      return { version: "2.0.26", pid: process.pid };
    };
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => client,
      readSnapshot: async (_client: never, id: string) => ({ session: v2Session({ id }), messages: [] }),
      upload: async (_config: never, payload: { source_id: string }) => {
        uploads.push(payload.source_id);
        return { ok: true, status: 201, body: {} };
      },
    }))(makeCtx(feed, CREDENTIALS));
    expect(infoCalls).toBe(0);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    feed.push({ type: "session.idle", data: { sessionID: "ses_2" } });
    await sleep(DEBOUNCE * 3);
    expect(infoCalls).toBe(1);
    verified.resolve();
    await sleep(30);
    expect(uploads.sort()).toEqual(["ses_1", "ses_2"]);
    await cleanup?.();
  });

  it("debounces idle events and uploads the full history snapshot once", async () => {
    const feed = makeFeed();
    const uploads: Array<{ payload: { source_id: string; messages: Array<{ role: string }> }; signal?: AbortSignal }> = [];
    const clientInputs: Array<{ baseUrl: string; headers?: Record<string, string> }> = [];
    const order: string[] = [];
    let infoCalls = 0;
    const deps = baseDeps({
      makeClient: (input: { baseUrl: string; headers?: Record<string, string> }) => {
        clientInputs.push(input);
        return capabilityClient({ onInfo: () => infoCalls++ }) as never;
      },
      readSnapshot: async (_client: never, sessionID: string) => {
        order.push(`read:${sessionID}`);
        return {
          session: v2Session() as never,
          messages: [
            { id: "msg_1", type: "user", time: { created: 150 }, text: "hi" },
            { id: "msg_2", type: "assistant", time: { created: 160 }, content: [{ type: "text", text: "yo" }] },
          ] as never,
        };
      },
      upload: async (_config: never, payload: never, signal?: AbortSignal) => {
        order.push("upload");
        uploads.push({ payload: payload as never, ...(signal !== undefined ? { signal } : {}) });
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);

    const cleanup = await setup(makeCtx(feed, CREDENTIALS));
    expect(typeof cleanup).toBe("function");

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE / 3);
    expect(uploads).toHaveLength(0);

    await sleep(DEBOUNCE * 4);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.payload.source_id).toBe("ses_1");
    expect(uploads[0]?.payload.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(order).toEqual(["read:ses_1", "upload"]);

    expect(clientInputs).toHaveLength(1);
    expect(clientInputs[0]?.baseUrl).toBe("http://127.0.0.1:4096");
    expect(clientInputs[0]?.headers?.["authorization"]).toBe(
      `Basic ${Buffer.from("opencode:mock-pass").toString("base64")}`,
    );

    feed.push({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toHaveLength(2);
    expect(infoCalls).toBe(2);
    cleanup?.();
  });

  it("merges an idle arriving during an in-flight sync into one rerun", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const first = deferred();
    const deps = baseDeps({
      upload: async () => {
        uploads++;
        if (uploads === 1) await first.promise;
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toBe(1);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(1);

    first.resolve();
    await sleep(DEBOUNCE * 5);
    expect(uploads).toBe(2);
    cleanup?.();
  });

  it("keeps the latest idle debounce when an older in-flight rerun is already queued", async () => {
    const feed = makeFeed();
    const first = deferred();
    let uploads = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async () => {
        uploads++;
        if (uploads === 1) await first.promise;
        return { ok: true, status: 201, body: {} };
      },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 2);
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(5);
    first.resolve();
    await sleep(5);
    expect(uploads).toBe(1);
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(2);
    await cleanup?.();
  });

  it("skips over-limit sessions with a warning instead of uploading", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let uploads = 0;
    const deps = baseDeps({
      log: (_l: string, m: string) => logs.push(m),
      readSnapshot: async () => ({
        session: v2Session() as never,
        messages: [{ id: "msg_big", type: "user", time: { created: 1 }, text: "x".repeat(1_000_001) }] as never,
      }),
      upload: async () => {
        uploads++;
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toBe(0);
    expect(logs.join("\n")).toMatch(/超限/);
    cleanup?.();
  });
});

describe("createSessionHubV2Setup — delete race", () => {
  it("blocks mirror deletion until the connected instance is proven", async () => {
    const feed = makeFeed();
    let deletes = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      makeClient: () => capabilityClient({ version: "1.0.0" }),
      mirrorDelete: async () => { deletes++; return { found: 1, deleted: 1 }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(40);
    expect(deletes).toBe(0);
    await cleanup?.();
  });

  it("retries failed mirror deletion on a later delete without clearing the tombstone", async () => {
    const feed = makeFeed();
    let attempts = 0;
    let uploads = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      mirrorDelete: async () => {
        attempts++;
        if (attempts === 1) throw new Error("synthetic secret-body");
        return { found: 1, deleted: 1 };
      },
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(40);
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(attempts).toBe(2);
    expect(uploads).toBe(0);
    await cleanup?.();
  });

  it("cancels a pending sync and removes the mirror on delete", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const mirrors: string[] = [];
    const deps = baseDeps({
      upload: async () => {
        uploads++;
        return { ok: true, status: 201, body: {} };
      },
      mirrorDelete: async (_config: never, _machine: string, sourceId: string) => {
        mirrors.push(sourceId);
        return { found: 1, deleted: 1 };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 5);
    expect(uploads).toBe(0);
    expect(mirrors).toEqual(["ses_1"]);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 5);
    expect(uploads).toBe(0);
    expect(mirrors).toEqual(["ses_1"]);
    cleanup?.();
  });

  it("tombstones a delete received while the full snapshot is being read", async () => {
    const feed = makeFeed();
    const reading = deferred();
    const release = deferred();
    const order: string[] = [];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      readSnapshot: async () => {
        reading.resolve();
        await release.promise;
        order.push("read:end");
        return { session: v2Session(), messages: [] };
      },
      upload: async () => { order.push("upload"); return { ok: true, status: 201, body: {} }; },
      mirrorDelete: async () => { order.push("delete"); return { found: 1, deleted: 1 }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await reading.promise;
    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(15);
    release.resolve();
    await sleep(30);
    expect(order).toEqual(["read:end", "delete"]);
    await cleanup?.();
  });

  it("waits for an in-flight upload before mirror delete and prevents resurrection", async () => {
    const feed = makeFeed();
    const order: string[] = [];
    const gate = deferred();
    const deps = baseDeps({
      upload: async () => {
        order.push("upload:start");
        await gate.promise;
        order.push("upload:end");
        return { ok: true, status: 201, body: {} };
      },
      mirrorDelete: async () => {
        order.push("mirror");
        return { found: 1, deleted: 1 };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(order).toEqual(["upload:start"]);

    feed.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await sleep(20);
    expect(order).toEqual(["upload:start"]);

    gate.resolve();
    await sleep(30);
    expect(order).toEqual(["upload:start", "upload:end", "mirror"]);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 5);
    expect(order.filter((entry) => entry === "upload:start")).toHaveLength(1);
    expect(order.filter((entry) => entry === "mirror")).toHaveLength(1);
    cleanup?.();
  });
});

describe("createSessionHubV2Setup — capability, failures and cleanup", () => {
  it("blocks uploads when the connected instance cannot be proven and retries later", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let uploads = 0;
    let infoCalls = 0;
    const deps = baseDeps({
      log: (_l: string, m: string) => logs.push(m),
      makeClient: () =>
        capabilityClient({
          onInfo: () => infoCalls++,
          get version() {
            return infoCalls < 2 ? "1.0.0" : "2.0.26";
          },
        }) as never,
      upload: async () => {
        uploads++;
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toBe(0);
    expect(logs.join("\n")).toMatch(/版本/);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toBe(1);
    cleanup?.();
  });

  it("logs upload failures without blocking later events", async () => {
    const feed = makeFeed();
    const logs: string[] = [];
    let uploads = 0;
    const deps = baseDeps({
      log: (_l: string, m: string) => logs.push(m),
      upload: async () => {
        uploads++;
        if (uploads === 1) throw new Error("hub down: mock-token secret-body");
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(logs.join("\n")).toMatch(/upload failed/);
    expect(logs.join("\n")).not.toMatch(/mock-token|secret-body|hub down/);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploads).toBe(2);
    cleanup?.();
  });

  it("logs an event stream failure and stays alive", async () => {
    const logs: string[] = [];
    const feed = makeFeed({ failAfter: 0 });
    const deps = baseDeps({ log: (_l: string, m: string) => logs.push(m) });
    const setup = createSessionHubV2Setup(deps);
    await setup(makeCtx(feed, CREDENTIALS));
    await sleep(30);
    expect(logs.join("\n")).toMatch(/event stream/);
  });

  it("stops queued work when the event stream fails", async () => {
    const feed = makeFeed({ failAfter: 1 });
    let uploads = 0;
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(0);
    expect(feed.signal?.aborted).toBe(true);
    await cleanup?.();
  });

  it("stops queued work when the event stream ends normally", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const logs: string[] = [];
    const cleanup = await createSessionHubV2Setup(baseDeps({
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
      log: (_level: string, message: string) => logs.push(message),
    }))(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(5);
    feed.close();
    await sleep(DEBOUNCE * 3);
    expect(uploads).toBe(0);
    expect(feed.signal?.aborted).toBe(true);
    expect(logs.join("\n")).toMatch(/event stream ended/);
    await cleanup?.();
  });

  it("cleanup cancels pending timers and further syncs", async () => {
    const feed = makeFeed();
    let uploads = 0;
    const deps = baseDeps({
      upload: async () => {
        uploads++;
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(5);
    cleanup?.();
    await sleep(DEBOUNCE * 5);
    expect(uploads).toBe(0);

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 5);
    expect(uploads).toBe(0);
  });

  it("cleanup aborts the subscription signal and the in-flight upload", async () => {
    const feed = makeFeed();
    const uploadSignals: AbortSignal[] = [];
    const gate = deferred();
    const deps = baseDeps({
      upload: async (_config: never, _payload: never, signal?: AbortSignal) => {
        if (signal !== undefined) uploadSignals.push(signal);
        await gate.promise;
        return { ok: true, status: 201, body: {} };
      },
    });
    const setup = createSessionHubV2Setup(deps);
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));

    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await sleep(DEBOUNCE * 4);
    expect(uploadSignals).toHaveLength(1);
    expect(uploadSignals[0]?.aborted).toBe(false);

    cleanup?.();
    expect(feed.signal?.aborted).toBe(true);
    expect(uploadSignals[0]?.aborted).toBe(true);
    gate.resolve();
    await sleep(30);
  });

  it("cleanup waits for outstanding work and is repeatable", async () => {
    const feed = makeFeed();
    const started = deferred();
    const finish = deferred();
    const setup = createSessionHubV2Setup(baseDeps({
      upload: async () => {
        started.resolve();
        await finish.promise;
        return { ok: true, status: 201, body: {} };
      },
    }));
    const cleanup = await setup(makeCtx(feed, CREDENTIALS));
    feed.push({ type: "session.idle", data: { sessionID: "ses_1" } });
    await started.promise;
    let cleaned = false;
    const done = Promise.resolve(cleanup?.()).then(() => { cleaned = true; });
    await sleep(15);
    expect(feed.signal?.aborted).toBe(true);
    expect(cleaned).toBe(false);
    finish.resolve();
    await done;
    expect(cleaned).toBe(true);
    await cleanup?.();
  });
});

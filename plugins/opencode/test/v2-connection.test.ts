import { describe, expect, it } from "vitest";
import {
  buildV2Payload,
  classifyV2Event,
  parseV2Connection,
  sessionInfoFromV2,
  verifyV2Instance,
} from "../src/adapter-v2.js";

const SELF_URL = "D:/plugins/session-hub.js";
const SELF_PATH_WIN = "D:\\plugins\\session-hub.js";

function fakeCapabilityClient(input?: {
  version?: string;
  pid?: number;
  plugins?: unknown[];
  listThrows?: boolean;
}) {
  const version = input?.version ?? "2.0.26";
  const pid = input?.pid ?? process.pid;
  const plugins =
    input?.plugins ??
    [
      {
        id: "session-hub",
        source: { type: "local", path: SELF_PATH_WIN },
        features: { server: true },
        state: { status: "active" },
      },
    ];
  return {
    server: { info: async () => ({ version, pid, urls: ["http://127.0.0.1:4096"], paths: { tmp: "C:/tmp" } }) },
    plugin: {
      list: async () => {
        if (input?.listThrows) throw new Error("list unavailable");
        return { location: { directory: "D:/work" }, data: plugins };
      },
    },
  };
}

describe("parseV2Connection", () => {
  it("requires a string endpoint", () => {
    expect(parseV2Connection(undefined)).toMatchObject({ ok: false });
    expect(parseV2Connection({})).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "" })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: 42 })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "not a url" })).toMatchObject({ ok: false });
  });

  it("only accepts loopback http(s) endpoints and normalizes the trailing slash", () => {
    expect(parseV2Connection({ endpoint: "http://10.0.0.5:4096" })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "http://example.com:4096" })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "ftp://127.0.0.1:4096" })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:4096/" })).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:4096",
      username: "opencode",
      password: null,
    });
    expect(parseV2Connection({ endpoint: "http://localhost:4096" })).toMatchObject({ ok: true });
    expect(parseV2Connection({ endpoint: "http://[::1]:4096" })).toMatchObject({ ok: true });
  });

  it("parses optional basic auth with a default username", () => {
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:4096", auth: { password: "mock-pass" } })).toEqual({
      ok: true,
      endpoint: "http://127.0.0.1:4096",
      username: "opencode",
      password: "mock-pass",
    });
    expect(
      parseV2Connection({ endpoint: "http://127.0.0.1:4096", auth: { username: "kit", password: "mock-pass" } }),
    ).toEqual({ ok: true, endpoint: "http://127.0.0.1:4096", username: "kit", password: "mock-pass" });
  });

  it("rejects malformed auth blocks", () => {
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:1", auth: { password: 5 } })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:1", auth: { password: "" } })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:1", auth: "x" })).toMatchObject({ ok: false });
    expect(parseV2Connection({ endpoint: "http://127.0.0.1:1", auth: { username: 5, password: "p" } })).toMatchObject({
      ok: false,
    });
  });
});

describe("classifyV2Event", () => {
  it("normalizes session.idle and session.status idle to the same signal", () => {
    expect(classifyV2Event({ type: "session.idle", data: { sessionID: "s1" } })).toEqual({
      type: "session.idle",
      source_id: "s1",
    });
    expect(classifyV2Event({ type: "session.status", data: { sessionID: "s2", status: { type: "idle" } } })).toEqual({
      type: "session.idle",
      source_id: "s2",
    });
  });

  it("ignores busy/retry statuses and unrelated events", () => {
    expect(classifyV2Event({ type: "session.status", data: { sessionID: "s2", status: { type: "busy" } } })).toBeNull();
    expect(classifyV2Event({ type: "session.status", data: { sessionID: "s2", status: { type: "retry" } } })).toBeNull();
    expect(classifyV2Event({ type: "session.created", data: { sessionID: "s2" } })).toBeNull();
    expect(classifyV2Event({ type: "session.renamed", data: { sessionID: "s2" } })).toBeNull();
    expect(classifyV2Event({ type: "server.connected", data: {} })).toBeNull();
  });

  it("reads the V2 delete shape only and not move/archive payloads", () => {
    expect(classifyV2Event({ type: "session.deleted", data: { sessionID: "s3" } })).toEqual({
      type: "session.deleted",
      source_id: "s3",
    });
    expect(classifyV2Event({ type: "session.deleted", properties: { info: { id: "s3" } } } as never)).toBeNull();
    expect(classifyV2Event({ type: "session.moved", data: { sessionID: "s3" } })).toBeNull();
  });

  it("is defensive against malformed events", () => {
    expect(classifyV2Event({})).toBeNull();
    expect(classifyV2Event({ type: "session.idle", data: {} })).toBeNull();
    expect(classifyV2Event({ type: "session.idle", data: 5 })).toBeNull();
    expect(classifyV2Event({ type: "session.deleted" })).toBeNull();
  });
});

describe("verifyV2Instance", () => {
  const opts = { appVersion: "2.0.26", locationDirectory: "D:/work", selfUrl: SELF_URL };

  it("passes when version, plugin entry, state and local source path all match", async () => {
    await expect(verifyV2Instance(fakeCapabilityClient() as never, opts)).resolves.toBeUndefined();
  });

  it("matches a file URL self location against a local source path", async () => {
    await expect(
      verifyV2Instance(fakeCapabilityClient() as never, {
        ...opts,
        selfUrl: "file:///D:/plugins/session-hub.js",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a version mismatch", async () => {
    await expect(verifyV2Instance(fakeCapabilityClient({ version: "1.0.0" }) as never, opts)).rejects.toThrow(/版本/);
  });

  it("rejects an endpoint served by a different process than the host", async () => {
    await expect(
      verifyV2Instance(fakeCapabilityClient({ pid: process.pid + 1 }) as never, opts),
    ).rejects.toThrow(/进程/);
    await expect(
      verifyV2Instance(fakeCapabilityClient({ pid: process.pid + 1 }) as never, { ...opts, hostPID: process.pid + 1 }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the connected instance has no session-hub entry", async () => {
    await expect(verifyV2Instance(fakeCapabilityClient({ plugins: [] }) as never, opts)).rejects.toThrow(/未加载/);
  });

  it("rejects a failed plugin state", async () => {
    await expect(
      verifyV2Instance(
        fakeCapabilityClient({
          plugins: [
            {
              id: "session-hub",
              source: { type: "local", path: SELF_PATH_WIN },
              features: {},
              state: { status: "failed", error: "boom" },
            },
          ],
        }) as never,
        opts,
      ),
    ).rejects.toThrow(/状态/);
  });

  it("rejects a local source path that is a different file", async () => {
    await expect(
      verifyV2Instance(
        fakeCapabilityClient({
          plugins: [
            {
              id: "session-hub",
              source: { type: "local", path: "D:/plugins/other-plugin.js" },
              features: {},
              state: { status: "active" },
            },
          ],
        }) as never,
        opts,
      ),
    ).rejects.toThrow(/来源/);
  });

  it("accepts a package source when id and state match", async () => {
    await expect(
      verifyV2Instance(
        fakeCapabilityClient({
          plugins: [
            { id: "session-hub", source: { type: "package", target: "session-hub", version: "0.2.0" }, features: {}, state: { status: "active" } },
          ],
        }) as never,
        opts,
      ),
    ).resolves.toBeUndefined();
  });

  it("propagates capability transport failures", async () => {
    await expect(verifyV2Instance(fakeCapabilityClient({ listThrows: true }) as never, opts)).rejects.toThrow();
  });
});

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

function v2Message(overrides: Record<string, unknown> = {}) {
  return { id: "msg_1", type: "user", time: { created: 150 }, text: "hello", ...overrides };
}

describe("sessionInfoFromV2 / buildV2Payload", () => {
  it("maps V2 session fields onto the source session contract", () => {
    expect(sessionInfoFromV2(v2Session() as never)).toEqual({
      id: "ses_1",
      title: "title",
      directory: "D:/work",
      time_created: 100,
      time_updated: 200,
    });
    expect(sessionInfoFromV2(v2Session({ title: undefined }) as never).title).toBeNull();
  });

  it("builds a payload with mapped roles and source timestamps", () => {
    const result = buildV2Payload(
      { session: v2Session() as never, messages: [v2Message({ type: "user", text: "hi" }), v2Message({ id: "msg_2", type: "assistant", time: { created: 160 }, content: [{ type: "text", text: "yo" }] })] as never },
      "M1",
    );
    if ("overLimit" in result) throw new Error("unexpected over-limit");
    expect(result.payload.agent).toBe("opencode");
    expect(result.payload.machine).toBe("M1");
    expect(result.payload.source_id).toBe("ses_1");
    expect(result.payload.created_at).toBe(100);
    expect(result.payload.updated_at).toBe(200);
    expect(result.payload.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.payload.messages[1]!.text).toBe("yo");
  });

  it("flags over-limit history instead of silently truncating", () => {
    const many = Array.from({ length: 5001 }, (_, i) => v2Message({ id: `m${i}` }));
    expect(buildV2Payload({ session: v2Session() as never, messages: many as never }, "M1")).toMatchObject({
      overLimit: "messages",
    });

    const bigText = v2Message({ text: "x".repeat(1_000_001) });
    expect(buildV2Payload({ session: v2Session() as never, messages: [bigText] as never }, "M1")).toMatchObject({
      overLimit: "text",
    });

    expect(
      buildV2Payload({ session: v2Session({ title: "t".repeat(2001) }) as never, messages: [] as never }, "M1"),
    ).toMatchObject({ overLimit: "title" });

    expect(
      buildV2Payload(
        { session: v2Session({ location: { directory: "d".repeat(2001) } }) as never, messages: [] as never },
        "M1",
      ),
    ).toMatchObject({ overLimit: "cwd" });
  });
});

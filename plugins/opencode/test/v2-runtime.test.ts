import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionHubV2Setup } from "../src/adapter-v2.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const config = { baseUrl: "http://hub.invalid", token: "synthetic-token", timeoutMs: 1000 };

function idleFeed() {
  return {
    subscribe({ signal }: { signal: AbortSignal }) {
      return (async function* () {
        yield { type: "session.idle", data: { sessionID: "ses_1" } };
        while (!signal.aborted) await sleep(2);
      })();
    },
  };
}

const context = () => ({
  app: { version: "2.0.26" }, location: { directory: "D:/mock" },
  options: { endpoint: "http://127.0.0.1:4000" }, event: idleFeed(),
}) as never;

afterEach(() => vi.restoreAllMocks());

describe("V2 SDK lifecycle transport", () => {
  it("aborts and awaits a blocked host RPC source read on cleanup", async () => {
    let reading = false;
    let requestSignal: AbortSignal | undefined;
    let uploads = 0;
    const ctx = {
      app: { version: "2.0.26" }, location: { directory: "D:/mock" },
      options: { endpoint: "http://127.0.0.1:4000" }, event: idleFeed(),
      session: { get: (_input: unknown, options: { signal: AbortSignal }) => {
        reading = true;
        requestSignal = options.signal;
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      } },
    };
    const cleanup = await createSessionHubV2Setup({
      loadConfig: () => config, log: () => undefined, debounceMs: 1,
      selfUrl: "D:/mock.js",
      makeClient: () => ({
        server: { info: async () => ({ version: "2.0.26", pid: process.pid }) },
        plugin: { list: async () => ({ data: [{ id: "session-hub", state: { status: "active" }, source: { type: "local", path: "D:/mock.js" } }] }) },
      }) as never,
      upload: async () => { uploads++; return { ok: true, status: 201, body: {} }; },
    })(ctx as never);
    await vi.waitFor(() => expect(reading).toBe(true));
    await cleanup?.();
    expect(requestSignal?.aborted).toBe(true);
    expect(uploads).toBe(0);
  });

  it("gives SDK requests an abort signal that cleanup aborts", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let requested = false;
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requested = true;
      requestSignal = init?.signal;
      return new Response(JSON.stringify({ version: "mismatch" }), { status: 200 });
    });
    const cleanup = await createSessionHubV2Setup({ loadConfig: () => config, log: () => undefined, debounceMs: 1 })(context());
    await vi.waitFor(() => expect(requested).toBe(true));
    await cleanup?.();
    expect(requestSignal?.aborted).toBe(true);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

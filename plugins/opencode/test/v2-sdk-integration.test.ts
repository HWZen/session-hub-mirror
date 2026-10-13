import { OpenCode } from "@opencode/client";
import { describe, expect, it } from "vitest";
import type { ConversationMessage, SessionDetail } from "../../../packages/shared/src/session.js";
import { startLoopbackMock } from "./helpers/loopback-mock.js";
import { fixtureSession, historyFixture } from "./helpers/v2-fixture.js";

describe("OpenCode 2.0.26 SDK over synthetic loopback HTTP (not host E2E)", () => {
  it("reads complete ascending history with the real SDK through the terminal empty page", async () => {
    const { readStableSessionSnapshot } = await import("../src/adapter-v2.js");
    const messages = historyFixture();
    const mock = await startLoopbackMock({ session: fixtureSession, messages });
    try {
      const client = OpenCode.make({ baseUrl: mock.url, headers: { authorization: mock.authorization } });
      const snapshot = await readStableSessionSnapshot(client, fixtureSession.id);
      expect(snapshot).toEqual({ session: fixtureSession, messages });
      expect(snapshot.messages[0]?.id).toBe("msg_0201");
      const pages = mock.requests.filter((request) => request.path.endsWith("/message"));
      expect(pages).toHaveLength(3);
      expect(pages[0]?.query).toEqual({ limit: "200", order: "asc" });
      for (const request of pages.slice(1)) expect(Object.keys(request.query)).toEqual(["cursor"]);
      expect(pages.every((request) => request.authenticated)).toBe(true);
      expect(mock.requests.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    } finally {
      await mock.close();
    }
  });

  it("rejects absent or incorrect Basic auth using the SDK's declared error path", async () => {
    const mock = await startLoopbackMock({ session: fixtureSession, messages: historyFixture() });
    try {
      const absent = OpenCode.make({ baseUrl: mock.url });
      const incorrect = OpenCode.make({ baseUrl: mock.url, headers: { authorization: "Basic synthetic-invalid" } });
      await expect(absent.session.get({ sessionID: fixtureSession.id })).rejects.toMatchObject({
        name: "UnauthorizedError", _tag: "UnauthorizedError", message: "Authentication required",
      });
      await expect(incorrect.message.list({ sessionID: fixtureSession.id, order: "asc" })).rejects.toMatchObject({
        name: "UnauthorizedError",
      });
      expect(mock.requests.map((request) => request.authenticated)).toEqual([false, false]);
      expect(JSON.stringify(mock.requests)).not.toContain(mock.authorization);
    } finally {
      await mock.close();
    }
  });

  it("stores the SDK history payload via authenticated PUT and reads every raw envelope back", async () => {
    const { readStableSessionSnapshot, buildV2Payload } = await import("../src/adapter-v2.js");
    const { uploadSession, mirrorDelete } = await import("../src/plugin.js");
    const messages = historyFixture();
    const mock = await startLoopbackMock({ session: fixtureSession, messages });
    try {
      const client = OpenCode.make({ baseUrl: mock.url, headers: { authorization: mock.authorization } });
      const snapshot = await readStableSessionSnapshot(client, fixtureSession.id);
      const result = buildV2Payload(snapshot, "synthetic-machine");
      if ("overLimit" in result) throw new Error(result.overLimit);
      const config = { baseUrl: mock.url, token: mock.hubToken, timeoutMs: 2_000 };
      const put = await uploadSession(config, result.payload);
      expect(put).toMatchObject({ ok: true, status: 201, body: { id: expect.any(String), created: true } });
      const id = (put.body as { id: string }).id;
      const headers = { authorization: `Bearer ${config.token}` };
      const read = await fetch(`${mock.url}/v1/sessions/${id}/full`, { headers });
      expect(read.status).toBe(200);
      const full = await read.json() as SessionDetail;
      expect(full).toMatchObject({ ...result.payload, id });
      expect(full.messages).toHaveLength(messages.length);
      for (const [index, message] of full.messages.entries()) {
        const raw = Array.isArray(message.raw) ? message.raw : [message.raw];
        expect(raw.at(-1)).toEqual({ type: "opencode-v2-envelope", version: "2.0.26", message: messages[index] });
      }
      expect(full.messages[201]!.raw).toEqual([
        ...(messages[201] as Extract<typeof messages[number], { type: "assistant" }>).content,
        { type: "opencode-v2-envelope", version: "2.0.26", message: messages[201] },
      ]);
      expect(full.messages[203]!.text).toBe("");
      expect(await uploadSession(config, result.payload)).toMatchObject({ status: 200, body: { id, created: false } });
      const list = await fetch(`${mock.url}/v1/sessions?agent=opencode&machine=synthetic-machine&source_id=${fixtureSession.id}`, { headers });
      expect(await list.json()).toMatchObject({ total: 1, items: [{ id }] });
      const conversation = await fetch(`${mock.url}/v1/sessions/${id}`, { headers });
      const detail = await conversation.json() as { messages: ConversationMessage[] };
      expect(detail.messages.every((message) => !Object.hasOwn(message, "raw"))).toBe(true);
      await expect(mirrorDelete(config, "synthetic-machine", fixtureSession.id)).resolves.toEqual({ found: 1, deleted: 1 });
      expect((await fetch(`${mock.url}/v1/sessions/${id}/full`, { headers })).status).toBe(404);
    } finally {
      await mock.close();
    }
  });

  it("transports a synthetic history RPC with the SDK's actual rpc.call envelope", async () => {
    const messages = historyFixture();
    const mock = await startLoopbackMock({ session: fixtureSession, messages });
    try {
      const client = OpenCode.make({ baseUrl: mock.url, headers: { authorization: mock.authorization } });
      const first = await client.rpc.call({
        rpcID: "synthetic-history", method: "list",
        location: { directory: fixtureSession.location.directory },
        input: { sessionID: fixtureSession.id, limit: 200, order: "asc" },
      });
      expect(first.output).toMatchObject({ data: messages.slice(0, 200), cursor: { next: expect.any(String) } });
      const output = first.output as { cursor: { next: string } };
      const second = await client.rpc.call({
        rpcID: "synthetic-history", method: "list",
        input: { sessionID: fixtureSession.id, cursor: output.cursor.next },
      });
      expect(second.output).toMatchObject({ data: messages.slice(200), cursor: { next: expect.any(String) } });
      const tail = second.output as { cursor: { next: string } };
      await expect(client.rpc.call({
        rpcID: "synthetic-history", method: "list",
        input: { sessionID: fixtureSession.id, cursor: tail.cursor.next },
      })).resolves.toEqual({ output: { data: [], cursor: {} } });
      expect(mock.requests[0]).toMatchObject({
        method: "POST", path: "/api/rpc/synthetic-history/list",
        query: { "location[directory]": fixtureSession.location.directory }, authenticated: true,
      });
    } finally {
      await mock.close();
    }
  });
});

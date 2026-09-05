import { describe, expect, it } from "vitest";
import { FailingEmbedProvider, FakeEmbedProvider, TEST_TOKEN, buildApp, putSession, sessionBody } from "./helpers.js";
import { EmbeddingRegistry } from "../src/embedding/registry.js";
import { SessionIndexer } from "../src/indexing.js";

const AUTH = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };

async function getList(app: ReturnType<typeof buildApp>["app"], query = "") {
  const res = await app.request(`/v1/sessions${query}`, AUTH);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    total: number;
    items: Array<{ id: string; agent: string; machine: string; source_id: string; title: string | null; message_count: number }>;
  };
}

describe("sessions CRUD", () => {
  it("creates, then re-upserts idempotently by agent+machine+source_id", async () => {
    const { app } = buildApp();
    const res1 = await putSession(app, sessionBody());
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as { id: string; created: boolean; indexed: boolean };
    expect(body1.created).toBe(true);
    expect(body1.indexed).toBe(true);
    expect(body1.id).toBeTruthy();

    const res2 = await putSession(
      app,
      sessionBody({
        title: "renamed",
        updated_at: 1700000200000,
        messages: [
          { role: "user", text: "one", ts: 1 },
          { role: "assistant", text: "two", ts: 2 },
          { role: "user", text: "three", ts: 3, raw: { foo: 1 } },
        ],
      }),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { id: string; created: boolean };
    expect(body2.created).toBe(false);
    expect(body2.id).toBe(body1.id);

    const list = await getList(app);
    expect(list.total).toBe(1);
    expect(list.items[0]!.title).toBe("renamed");
    expect(list.items[0]!.message_count).toBe(3);

    const detailRes = await app.request(`/v1/sessions/${body1.id}`, AUTH);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      id: string;
      indexed_model: string | null;
      messages: Array<{ idx: number; role: string; text: string; raw: unknown }>;
    };
    expect(detail.id).toBe(body1.id);
    expect(detail.messages).toHaveLength(3);
    expect(detail.messages[0]!.text).toBe("one");
    expect(detail.messages[2]!.raw).toEqual({ foo: 1 });
    expect(detail.indexed_model).toBe("bge-m3");
  });

  it("returns 404 for unknown detail", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/sessions/nope", AUTH);
    expect(res.status).toBe(404);
  });

  it("soft deletes and hides from list and detail", async () => {
    const { app } = buildApp();
    const res = await putSession(app, sessionBody());
    const { id } = (await res.json()) as { id: string };
    const del = await app.request(`/v1/sessions/${id}`, { method: "DELETE", ...AUTH });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect((await getList(app)).total).toBe(0);
    expect((await app.request(`/v1/sessions/${id}`, AUTH)).status).toBe(404);
    expect((await app.request(`/v1/sessions/${id}`, { method: "DELETE", ...AUTH })).status).toBe(404);
  });

  it("filters list by agent, machine, time range and paginates", async () => {
    const { app } = buildApp();
    await putSession(
      app,
      sessionBody({ source_id: "a1", agent: "opencode", machine: "M1", created_at: 1700000000000, updated_at: 1700000005000 }),
    );
    await putSession(
      app,
      sessionBody({ source_id: "b1", agent: "workbuddy", machine: "M2", created_at: 1705000000000, updated_at: 1705000005000 }),
    );
    await putSession(
      app,
      sessionBody({ source_id: "a2", agent: "opencode", machine: "M1", created_at: 1710000000000, updated_at: 1710000005000 }),
    );

    expect((await getList(app, "?agent=opencode")).total).toBe(2);
    expect((await getList(app, "?machine=M2")).items[0]!.source_id).toBe("b1");
    expect((await getList(app, "?created_from=1705000000000")).total).toBe(2);
    expect((await getList(app, "?created_to=1704999999999")).items[0]!.source_id).toBe("a1");
    expect((await getList(app, "?updated_from=1710000000000")).items[0]!.source_id).toBe("a2");
    expect((await getList(app, "?agent=opencode&machine=M2")).total).toBe(0);

    const page = await getList(app, "?limit=1&offset=1");
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.source_id).toBe("b1");

    const badFilters = await app.request("/v1/sessions?created_from=not-a-date", AUTH);
    expect(badFilters.status).toBe(400);
    const badPage = await app.request("/v1/sessions?limit=0", AUTH);
    expect(badPage.status).toBe(400);
  });

  it("filters by source_id alone and combined with agent/machine", async () => {
    const { app } = buildApp();
    await putSession(app, sessionBody({ source_id: "a1", agent: "opencode", machine: "M1" }));
    await putSession(app, sessionBody({ source_id: "a1", agent: "workbuddy", machine: "M2" }));
    await putSession(app, sessionBody({ source_id: "a2", agent: "opencode", machine: "M1" }));

    const hit = await getList(app, "?agent=opencode&machine=M1&source_id=a1");
    expect(hit.total).toBe(1);
    expect(hit.items[0]!.source_id).toBe("a1");
    expect(hit.items[0]!.agent).toBe("opencode");

    expect((await getList(app, "?agent=opencode&machine=M2&source_id=a1")).total).toBe(0);
    expect((await getList(app, "?source_id=missing")).total).toBe(0);
  });

  it("rejects invalid bodies", async () => {
    const { app } = buildApp();
    const missing = await putSession(app, { agent: "opencode" });
    expect(missing.status).toBe(400);
    const badTime = await putSession(app, sessionBody({ created_at: "2026-09-05" }));
    expect(badTime.status).toBe(400);
    const badJson = await app.request("/v1/sessions", {
      method: "PUT",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });

  it("stores sessions even when indexing fails, reporting indexed=false", async () => {
    const { app } = buildApp(TEST_TOKEN, [new FailingEmbedProvider("always-fails")]);
    const res = await putSession(app, sessionBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; created: boolean; indexed: boolean };
    expect(body.indexed).toBe(false);
    const list = await getList(app);
    expect(list.total).toBe(1);
  });

  it("reports stats across agents and machines", async () => {
    const { app } = buildApp();
    await putSession(app, sessionBody({ source_id: "x1", agent: "opencode", machine: "M1" }));
    await putSession(app, sessionBody({ source_id: "x2", agent: "workbuddy", machine: "M2" }));
    const res = await app.request("/v1/stats", AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: number;
      messages: number;
      indexed: number;
      unindexed: number;
      by_agent: Record<string, number>;
      by_machine: Record<string, number>;
      first_session_at: number | null;
      last_session_at: number | null;
    };
    expect(body.sessions).toBe(2);
    expect(body.messages).toBe(4);
    expect(body.indexed).toBe(2);
    expect(body.unindexed).toBe(0);
    expect(body.by_agent).toEqual({ opencode: 1, workbuddy: 1 });
    expect(body.by_machine).toEqual({ M1: 1, M2: 1 });
    expect(body.first_session_at).toBe(1700000000000);
  });

  it("reindexes previously unindexed sessions", async () => {
    const { app, db, repo, registry } = buildApp(TEST_TOKEN, [new FailingEmbedProvider("always-fails")]);
    const res = await putSession(app, sessionBody());
    const { id } = (await res.json()) as { id: string };
    const unindexed = repo.listUnindexed(100, registry.activeModel());
    expect(unindexed.map((s) => s.id)).toContain(id);

    const registry2 = new EmbeddingRegistry([new FakeEmbedProvider("recovered")]);
    const indexer = new SessionIndexer(db, repo, registry2);
    expect(await indexer.indexSession(id)).toBe(true);
    expect(repo.listUnindexed(100, registry2.activeModel())).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { FailingEmbedProvider, TEST_TOKEN, buildApp, putSession, sessionBody } from "./helpers.js";

const AUTH = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };

interface GrepHitJson {
  session: { id: string; source_id: string; agent: string };
  hits: Array<{ message_idx: number; role: string; ts: number | null; snippet: string; match_start: number }>;
}

interface GrepResponseJson {
  total: number;
  limit: number;
  offset: number;
  items: GrepHitJson[];
}

async function getGrep(app: ReturnType<typeof buildApp>["app"], query: string): Promise<Response> {
  return app.request(`/v1/grep${query}`, AUTH);
}

async function grepOk(app: ReturnType<typeof buildApp>["app"], query: string): Promise<GrepResponseJson> {
  const res = await getGrep(app, query);
  expect(res.status).toBe(200);
  return (await res.json()) as GrepResponseJson;
}

function sourceIds(body: GrepResponseJson): string[] {
  return body.items.map((item) => item.session.source_id);
}

describe("GET /v1/grep", () => {
  it("matches substring in message text, groups by session and reports match_start", async () => {
    const { app } = buildApp();
    await putSession(
      app,
      sessionBody({
        source_id: "a1",
        title: "alpha",
        updated_at: 1700000200000,
        messages: [
          { role: "user", text: "please fix the login timeout", ts: 1 },
          { role: "assistant", text: "login timeout comes from the pool", ts: 2 },
        ],
      }),
    );
    await putSession(
      app,
      sessionBody({
        source_id: "b1",
        title: "beta",
        updated_at: 1700000100000,
        messages: [{ role: "user", text: "unrelated topic about caching", ts: 3 }],
      }),
    );

    const body = await grepOk(app, "?q=login%20timeout");
    expect(body.total).toBe(2);
    expect(sourceIds(body)).toEqual(["a1"]);
    expect(body.items[0]!.hits).toHaveLength(2);
    expect(body.items[0]!.hits[0]).toMatchObject({ message_idx: 0, role: "user", snippet: "please fix the login timeout" });
    expect(body.items[0]!.hits[0]!.match_start).toBe(15);
    expect(body.items[0]!.hits[1]!.message_idx).toBe(1);
  });

  it("orders sessions by updated_at desc", async () => {
    const { app } = buildApp();
    await putSession(app, sessionBody({ source_id: "old", updated_at: 1700000000000, messages: [{ role: "user", text: "wal mode" }] }));
    await putSession(app, sessionBody({ source_id: "new", updated_at: 1700000900000, messages: [{ role: "user", text: "wal mode" }] }));
    const body = await grepOk(app, "?q=wal");
    expect(sourceIds(body)).toEqual(["new", "old"]);
  });

  it("treats % _ and backslash as literal characters", async () => {
    const { app } = buildApp();
    await putSession(
      app,
      sessionBody({
        messages: [
          { role: "user", text: "progress is 100%_done at D:\\tmp" },
          { role: "user", text: "progress is finished at D:/tmp" },
        ],
      }),
    );

    expect((await grepOk(app, "?q=100%25_done")).total).toBe(1);
    expect((await grepOk(app, "?q=%25")).total).toBe(1);
    expect((await grepOk(app, "?q=_")).total).toBe(1);
    expect((await grepOk(app, "?q=%5C")).total).toBe(1);
    expect((await grepOk(app, "?q=D%3A%5Ctmp")).total).toBe(1);
    expect((await grepOk(app, "?q=1__")).total).toBe(0);
  });

  it("is case-insensitive by default and case-sensitive with case_sensitive=1", async () => {
    const { app } = buildApp();
    await putSession(app, sessionBody({ messages: [{ role: "user", text: "Hello World" }] }));

    expect((await grepOk(app, "?q=hello")).total).toBe(1);
    expect((await grepOk(app, "?q=HELLO")).total).toBe(1);
    expect((await grepOk(app, "?q=hello&case_sensitive=1")).total).toBe(0);
    expect((await grepOk(app, "?q=Hello&case_sensitive=1")).total).toBe(1);
    expect((await grepOk(app, "?q=hello&case_sensitive=0")).total).toBe(1);
  });

  it("combines with session filters and excludes soft-deleted sessions", async () => {
    const { app } = buildApp();
    await putSession(app, sessionBody({ source_id: "m1", agent: "opencode", machine: "M1", messages: [{ role: "user", text: "sqlite wal" }] }));
    await putSession(app, sessionBody({ source_id: "m2", agent: "workbuddy", machine: "M2", messages: [{ role: "user", text: "sqlite wal" }] }));
    await putSession(app, sessionBody({ source_id: "t1", title: "sqlite tuning", messages: [{ role: "user", text: "wal checkpoint" }] }));

    expect((await grepOk(app, "?q=sqlite&agent=opencode")).items.map((i) => i.session.source_id)).toEqual(["m1"]);
    expect((await grepOk(app, "?q=wal&machine=M2")).items.map((i) => i.session.source_id)).toEqual(["m2"]);
    expect((await grepOk(app, "?q=wal&title=sqlite")).items.map((i) => i.session.source_id)).toEqual(["t1"]);
    expect((await grepOk(app, "?q=wal&created_from=1700000000000")).total).toBe(3);
    expect((await grepOk(app, "?q=wal&created_to=1699999999999")).total).toBe(0);

    const list = await app.request("/v1/sessions?source_id=m1", AUTH);
    const { id } = ((await list.json()) as { items: Array<{ id: string }> }).items[0]!;
    await app.request(`/v1/sessions/${id}`, { method: "DELETE", ...AUTH });
    expect((await grepOk(app, "?q=sqlite")).items.map((i) => i.session.source_id)).toEqual(["m2"]);
  });

  it("paginates over matched message rows", async () => {
    const { app } = buildApp();
    await putSession(
      app,
      sessionBody({
        source_id: "many",
        messages: Array.from({ length: 7 }, (_, i) => ({ role: "user", text: `hit number ${i}`, ts: i })),
      }),
    );

    const page1 = await grepOk(app, "?q=hit&limit=3");
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.hits.map((h) => h.message_idx)).toEqual([0, 1, 2]);

    const page3 = await grepOk(app, "?q=hit&limit=3&offset=6");
    expect(page3.total).toBe(7);
    expect(page3.items[0]!.hits.map((h) => h.message_idx)).toEqual([6]);
  });

  it("caps snippets per session at 5 while total counts all matched messages", async () => {
    const { app } = buildApp();
    await putSession(
      app,
      sessionBody({
        messages: Array.from({ length: 7 }, (_, i) => ({ role: "user", text: `needle ${i}` })),
      }),
    );
    const body = await grepOk(app, "?q=needle");
    expect(body.total).toBe(7);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.hits).toHaveLength(5);
  });

  it("clips long snippets to 500 chars around the match", async () => {
    const { app } = buildApp();
    const text = `${"x".repeat(700)}NEEDLE${"y".repeat(600)}`;
    await putSession(app, sessionBody({ messages: [{ role: "user", text }] }));

    const body = await grepOk(app, "?q=NEEDLE&case_sensitive=1");
    const hit = body.items[0]!.hits[0]!;
    expect(hit.snippet.length).toBe(500);
    expect(hit.snippet.slice(hit.match_start, hit.match_start + 6)).toBe("NEEDLE");
    expect(hit.match_start).toBe(120);
  });

  it("works without any usable embedding provider", async () => {
    const { app, settleIndexing } = buildApp(TEST_TOKEN, [new FailingEmbedProvider("down")]);
    await putSession(app, sessionBody({ messages: [{ role: "user", text: "grep does not need vectors" }] }));
    await settleIndexing();
    const body = await grepOk(app, "?q=vectors");
    expect(body.total).toBe(1);
  });

  it("rejects invalid query parameters", async () => {
    const { app } = buildApp();
    expect((await getGrep(app, "")).status).toBe(400);
    expect((await getGrep(app, "?q=")).status).toBe(400);
    expect((await getGrep(app, `?q=${"a".repeat(257)}`)).status).toBe(400);
    expect((await getGrep(app, "?q=x&limit=0")).status).toBe(400);
    expect((await getGrep(app, "?q=x&limit=201")).status).toBe(400);
    expect((await getGrep(app, "?q=x&offset=-1")).status).toBe(400);
    expect((await getGrep(app, "?q=x&created_from=not-a-date")).status).toBe(400);
  });

  it("documents itself via ?help=1", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/grep?help=1", AUTH);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      method: string;
      path: string;
      params: Array<{ name: string; required: boolean }>;
    };
    expect(doc.method).toBe("GET");
    expect(doc.path).toBe("/v1/grep");
    const q = doc.params.find((p) => p.name === "q");
    expect(q?.required).toBe(true);
    expect(doc.params.map((p) => p.name)).toContain("case_sensitive");
  });
});

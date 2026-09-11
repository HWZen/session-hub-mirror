import { describe, expect, it } from "vitest";
import { FailingEmbedProvider, TEST_TOKEN, buildApp, postSearch, putSession } from "./helpers.js";

const AUTH = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };
const NEEDLE = "how to fix ECONNRESET in nodejs server";
const UNRELATED = "hotpot recipe with beef and tofu";
const REASONING = "internal reasoning about connection pool exhaustion";

async function seed(parts: ReturnType<typeof buildApp>) {
  const { app, settleIndexing } = parts;
  await putSession(
    app,
    { ...opencodeBody("sA"), messages: [{ role: "user", text: NEEDLE, ts: 1 }, { role: "assistant", text: "retry with backoff", ts: 2 }] },
  );
  await putSession(
    app,
    { ...workbuddyBody("sB"), messages: [{ role: "user", text: UNRELATED, ts: 1 }] },
  );
  await settleIndexing();
}

function opencodeBody(sourceId: string) {
  return {
    agent: "opencode",
    machine: "M1",
    source_id: sourceId,
    title: "nodejs debug",
    created_at: 1700000000000,
    updated_at: 1700000100000,
    messages: [],
  };
}

function workbuddyBody(sourceId: string) {
  return {
    agent: "workbuddy",
    machine: "M2",
    source_id: sourceId,
    title: "cooking",
    created_at: 1701000000000,
    updated_at: 1701000100000,
    messages: [],
  };
}

describe("semantic search", () => {
  it("returns empty results on empty database", async () => {
    const { app } = buildApp();
    const res = await postSearch(app, { query: NEEDLE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; model: string };
    expect(body.results).toEqual([]);
    expect(body.model).toBe("bge-m3");
  });

  it("ranks the matching session first with snippets", async () => {
    const parts = buildApp();
    await seed(parts);
    const { app } = parts;
    const firstChunkEmbedInput = `会话元数据：标题=nodejs debug；Agent=opencode；机器=M1；源会话ID=sA\n${NEEDLE}`;
    const res = await postSearch(app, { query: firstChunkEmbedInput, top_k: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      results: Array<{
        session: { source_id: string; agent: string };
        distance: number;
        snippets: Array<{ text: string; message_idx: number; source: string }>;
      }>;
    };
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0]!.session.source_id).toBe("sA");
    expect(body.results[0]!.distance).toBeLessThan(0.01);
    expect(body.results[0]!.snippets[0]!.text).toBe(NEEDLE);
    expect(body.results[0]!.snippets[0]!.message_idx).toBe(0);
    expect(body.results[0]!.snippets[0]!.source).toBe("text");
    expect(body.provider).toBe("fake");
  });

  it("indexes reasoning extracted from raw and tags the snippet source as reasoning", async () => {
    const parts = buildApp();
    const { app, settleIndexing } = parts;
    await putSession(app, {
      ...opencodeBody("sR"),
      messages: [{ role: "assistant", text: "", ts: 1, raw: [{ type: "reasoning", text: REASONING }] }],
    });
    await settleIndexing();
    const res = await postSearch(app, { query: REASONING, top_k: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ session: { source_id: string }; snippets: Array<{ text: string; source: string }> }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.session.source_id).toBe("sR");
    expect(body.results[0]!.snippets[0]!.text).toBe(REASONING);
    expect(body.results[0]!.snippets[0]!.source).toBe("reasoning");
  });

  it("matches a session through its meta header prepended to the first chunk", async () => {
    const parts = buildApp();
    const { app, settleIndexing } = parts;
    await putSession(app, {
      ...opencodeBody("sMeta"),
      title: "vector metadata",
      machine: "M1",
      messages: [{ role: "user", text: NEEDLE, ts: 1 }],
    });
    await settleIndexing();

    const header = "会话元数据：标题=vector metadata；Agent=opencode；机器=M1；源会话ID=sMeta";
    const res = await postSearch(app, { query: `${header}\n${NEEDLE}`, top_k: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ session: { source_id: string }; distance: number; snippets: Array<{ text: string }> }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.session.source_id).toBe("sMeta");
    expect(body.results[0]!.distance).toBeLessThan(0.01);
    expect(body.results[0]!.snippets[0]!.text).toBe(NEEDLE);
  });

  it("applies filters to search results", async () => {
    const parts = buildApp();
    await seed(parts);
    const { app } = parts;
    const res = await postSearch(app, { query: NEEDLE, filters: { agent: "workbuddy" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ session: { source_id: string; agent: string } }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.session.agent).toBe("workbuddy");
  });

  it("returns 503 when every provider is unavailable", async () => {
    const { app } = buildApp(TEST_TOKEN, [new FailingEmbedProvider("always-fails")]);
    const res = await postSearch(app, { query: NEEDLE });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("embedding unavailable");
  });

  it("rejects invalid search bodies", async () => {
    const { app } = buildApp();
    const res = await postSearch(app, { top_k: 3 });
    expect(res.status).toBe(400);
    const badTopK = await postSearch(app, { query: "x", top_k: 999 });
    expect(badTopK.status).toBe(400);
  });
});

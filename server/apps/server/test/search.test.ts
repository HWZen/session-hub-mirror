import { describe, expect, it } from "vitest";
import { FailingEmbedProvider, TEST_TOKEN, buildApp, postSearch, putSession } from "./helpers.js";
import { searchSessions } from "../src/db/search.js";
import { hashVector, makeDb } from "./helpers.js";

const AUTH = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };
const NEEDLE = "how to fix ECONNRESET in nodejs server";
const UNRELATED = "hotpot recipe with beef and tofu";
const REASONING = "internal reasoning about connection pool exhaustion";
const IDENTIFIER = "ZQX-PATTERN-0x5F3A";

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
    const firstChunkEmbedInput = `nodejs debug\n${NEEDLE}`;
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

  it("matches a session through its title prepended to the first chunk", async () => {
    const parts = buildApp();
    const { app, settleIndexing } = parts;
    await putSession(app, {
      ...opencodeBody("sMeta"),
      title: "vector metadata",
      machine: "M1",
      messages: [{ role: "user", text: NEEDLE, ts: 1 }],
    });
    await settleIndexing();

    const res = await postSearch(app, { query: `vector metadata\n${NEEDLE}`, top_k: 5 });
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

interface HybridResult {
  session: { source_id: string };
  score: number;
  distance: number | null;
  matched_by: string[];
  snippets: Array<{ text: string; source: string; distance: number | null; matched_by: string[] }>;
}

describe("hybrid search", () => {
  it("recalls identifier sessions through the lexical channel", async () => {
    const parts = buildApp();
    const { app, settleIndexing } = parts;
    await putSession(app, {
      ...opencodeBody("sLex"),
      messages: [{ role: "user", text: `config uses ${IDENTIFIER} for the handshake`, ts: 1 }],
    });
    await settleIndexing();
    const res = await postSearch(app, { query: IDENTIFIER, top_k: 10 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: HybridResult[] };
    const hit = body.results.find((r) => r.session.source_id === "sLex");
    expect(hit).toBeDefined();
    expect(hit!.matched_by).toContain("lexical");
    const lexSnippet = hit!.snippets.find((sn) => sn.matched_by.includes("lexical"));
    expect(lexSnippet).toBeDefined();
    expect(lexSnippet!.text).toContain(IDENTIFIER);
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("merges matched_by when both channels hit the same session and chunk", async () => {
    const parts = buildApp();
    await seed(parts);
    const { app } = parts;
    const res = await postSearch(app, { query: `nodejs debug\n${NEEDLE}`, top_k: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: HybridResult[] };
    const hit = body.results.find((r) => r.session.source_id === "sA");
    expect(hit).toBeDefined();
    expect(hit!.matched_by).toEqual(["dense", "lexical"]);
    expect(hit!.distance).not.toBeNull();
    const dual = hit!.snippets.find((sn) => sn.matched_by.length === 2);
    expect(dual).toBeDefined();
    expect(dual!.matched_by).toEqual(["dense", "lexical"]);
  });

  it("returns null distance for lexical-only sessions when no dense table exists", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO sessions (id, agent, machine, source_id, created_at, updated_at) VALUES ('s1', 'opencode', 'M1', 'src1', 1, 2)",
    ).run();
    const info = db
      .prepare("INSERT INTO messages (session_id, idx, role, text) VALUES ('s1', 0, 'user', ?)")
      .run(`token is ${IDENTIFIER}`);
    db.prepare("INSERT INTO message_chunks (message_id, chunk_no, source, text, char_start) VALUES (?, 0, 'text', ?, 0)").run(
      Number(info.lastInsertRowid),
      `token is ${IDENTIFIER}`,
    );
    const hits = searchSessions(db, "bge-m3", IDENTIFIER, hashVector(IDENTIFIER), 10, {});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matched_by).toEqual(["lexical"]);
    expect(hits[0]!.distance).toBeNull();
    expect(hits[0]!.snippets[0]!.matched_by).toEqual(["lexical"]);
    expect(hits[0]!.snippets[0]!.distance).toBeNull();
    db.close();
  });

  it("applies filters to the lexical channel", async () => {
    const parts = buildApp();
    const { app, settleIndexing } = parts;
    await putSession(app, {
      ...opencodeBody("sF1"),
      messages: [{ role: "user", text: `value is ${IDENTIFIER} here`, ts: 1 }],
    });
    await putSession(app, {
      ...workbuddyBody("sF2"),
      messages: [{ role: "user", text: `also ${IDENTIFIER} elsewhere`, ts: 1 }],
    });
    await settleIndexing();
    const res = await postSearch(app, { query: IDENTIFIER, filters: { agent: "workbuddy" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: HybridResult[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.session.source_id).toBe("sF2");
    expect(body.results[0]!.matched_by).toContain("lexical");
  });

  it("keeps short queries working through dense only", async () => {
    const parts = buildApp();
    await seed(parts);
    const { app } = parts;
    const res = await postSearch(app, { query: `nodejs debug\n${NEEDLE}`, top_k: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: HybridResult[] };
    expect(body.results[0]!.session.source_id).toBe("sA");
    const res2 = await postSearch(app, { query: "ab", top_k: 5 });
    expect(res2.status).toBe(200);
  });
});

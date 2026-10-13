import { describe, expect, it } from "vitest";
import { TEST_TOKEN, buildApp, hashVector, makeSettingsDeps, postSearch, putSession, sessionBody } from "./helpers.js";
import { createDb, type SqliteDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { toVectorBlob } from "../src/db/embeddings.js";
import { SessionRepository } from "../src/db/sessions.js";
import type { SessionUpsertInput } from "@session-hub/shared";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeEmbedProvider } from "./helpers.js";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function vectorCount(db: SqliteDatabase, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function tableNames(db: SqliteDatabase, pattern: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name").all(pattern) as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function forgetMigration(db: SqliteDatabase, name: string): void {
  db.prepare("DELETE FROM _migrations WHERE name = ?").run(name);
}

describe("model partitioned chunk embeddings", () => {
  it("index model A, switch to model B: B space empty, old space preserved, reindex fills B", async () => {
    const { app, db, repo, registry, indexer, settleIndexing } = buildApp(
      TEST_TOKEN,
      [new FakeEmbedProvider("pa", "model-a", 100, 16)],
      undefined,
      (parts) => makeSettingsDeps(parts),
    );
    const put1 = await putSession(app, sessionBody({ source_id: "s1" }));
    expect(((await put1.json()) as { created: boolean }).created).toBe(true);
    const put2 = await putSession(
      app,
      sessionBody({
        source_id: "s2",
        title: "second",
        messages: [{ role: "user", text: "cooking pasta tonight", ts: 1 }],
      }),
    );
    expect(((await put2.json()) as { created: boolean }).created).toBe(true);
    await settleIndexing();
    expect(tableExists(db, "chunk_embeddings_model_a")).toBe(true);
    expect(vectorCount(db, "chunk_embeddings_model_a")).toBe(3);

    const searchA = await postSearch(app, { query: "hello world" });
    const bodyA = (await searchA.json()) as { model: string; results: unknown[] };
    expect(bodyA.model).toBe("model-a");
    expect(bodyA.results).toHaveLength(2);

    registry.replaceRemoteProviders([new FakeEmbedProvider("pb", "model-b", 100, 16)]);
    const health = (await (await app.request("/health")).json()) as { embedding: { model: string } };
    expect(health.embedding.model).toBe("model-b");

    const searchB = await postSearch(app, { query: "hello world" });
    const bodyB = (await searchB.json()) as {
      model: string;
      results: Array<{ matched_by: string[]; distance: number | null }>;
    };
    expect(bodyB.model).toBe("model-b");
    expect(bodyB.results.every((h) => !h.matched_by.includes("dense"))).toBe(true);
    expect(bodyB.results.every((h) => h.distance === null)).toBe(true);

    const stats = (await (await app.request("/v1/stats", { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json()) as {
      indexed: number;
      unindexed: number;
    };
    expect(stats.indexed).toBe(0);
    expect(stats.unindexed).toBe(2);
    expect(repo.listUnindexed(10, "model-b")).toHaveLength(2);

    expect(vectorCount(db, "chunk_embeddings_model_a")).toBe(3);

    const sessions = repo.listUnindexed(10, "model-b");
    const s1 = sessions.find((s) => s.source_id === "s1")!;
    expect(await indexer.indexSession(s1.id)).toBe(true);
    expect(vectorCount(db, "chunk_embeddings_model_b")).toBe(2);
    expect(vectorCount(db, "chunk_embeddings_model_a")).toBe(1);

    const reindex = await app.request("/v1/settings/reindex", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const reindexBody = (await reindex.json()) as { total: number; indexed: number; failed: number; remaining: number };
    expect(reindexBody).toEqual({ total: 1, indexed: 1, failed: 0, remaining: 0 });
    expect(vectorCount(db, "chunk_embeddings_model_b")).toBe(3);
    expect(vectorCount(db, "chunk_embeddings_model_a")).toBe(0);

    const searchB2 = await postSearch(app, { query: "hello world" });
    const bodyB2 = (await searchB2.json()) as { model: string; results: Array<{ session: { source_id: string } }> };
    expect(bodyB2.model).toBe("model-b");
    expect(bodyB2.results).toHaveLength(2);
    expect(bodyB2.results[0]!.session.source_id).toBe("s1");

    const put3 = await putSession(app, sessionBody({ source_id: "s1", title: "updated" }));
    expect(put3.status).toBe(200);
    await settleIndexing();
    expect(vectorCount(db, "chunk_embeddings_model_b")).toBe(3);
    expect(vectorCount(db, "chunk_embeddings_model_a")).toBe(0);
  });
});

describe("0004 chunk indexing migration", () => {
  it("drops legacy message_embeddings tables, ensures message_chunks and resets indexed state", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-chunk-migrate-"));
    const db = createDb(path.join(dir, "legacy.db"));
    migrate(db);

    expect(tableExists(db, "message_chunks")).toBe(true);
    expect(tableNames(db, "message_embeddings%")).toEqual([]);

    const repo = new SessionRepository(db);
    const { id: sessionId } = repo.upsert(sessionBody() as unknown as SessionUpsertInput);
    const message = db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY idx LIMIT 1").get(sessionId) as {
      id: number;
    };
    const vector = hashVector("hello world");
    db.exec(
      "CREATE VIRTUAL TABLE message_embeddings_bge_m3 USING vec0 (message_id INTEGER PRIMARY KEY, embedding float[1024])",
    );
    db.prepare("INSERT INTO message_embeddings_bge_m3 (message_id, embedding) VALUES (?, ?)").run(
      BigInt(message.id),
      toVectorBlob(vector),
    );
    db.prepare("UPDATE sessions SET indexed_at = ?, indexed_model = ? WHERE id = ?").run(
      Date.now(),
      "bge-m3",
      sessionId,
    );

    forgetMigration(db, "0004_chunk_indexing");
    migrate(db);

    expect(tableNames(db, "message_embeddings%")).toEqual([]);
    expect(tableExists(db, "message_chunks")).toBe(true);
    const session = repo.get(sessionId)!;
    expect(session.indexed_at).toBeNull();
    expect(session.indexed_model).toBeNull();
    db.close();
  });
});

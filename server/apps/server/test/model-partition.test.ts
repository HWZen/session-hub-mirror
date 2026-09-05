import { describe, expect, it } from "vitest";
import { TEST_TOKEN, buildApp, hashVector, makeSettingsDeps, postSearch, putSession, sessionBody } from "./helpers.js";
import { createDb, type SqliteDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { searchSessions } from "../src/db/search.js";
import { storeEmbeddings, toVectorBlob } from "../src/db/embeddings.js";
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

describe("model partitioned embeddings", () => {
  it("index model A, switch to model B: B space empty, old space preserved, reindex fills B", async () => {
    const { app, db, repo, registry, indexer } = buildApp(
      TEST_TOKEN,
      [new FakeEmbedProvider("pa", "model-a", 100, 16)],
      undefined,
      (parts) => makeSettingsDeps(parts),
    );
    const put1 = await putSession(app, sessionBody({ source_id: "s1" }));
    expect(((await put1.json()) as { indexed: boolean }).indexed).toBe(true);
    const put2 = await putSession(
      app,
      sessionBody({
        source_id: "s2",
        title: "second",
        messages: [{ role: "user", text: "cooking pasta tonight", ts: 1 }],
      }),
    );
    expect(((await put2.json()) as { indexed: boolean }).indexed).toBe(true);
    expect(tableExists(db, "message_embeddings_model_a")).toBe(true);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(3);

    const searchA = await postSearch(app, { query: "hello world" });
    const bodyA = (await searchA.json()) as { model: string; results: unknown[] };
    expect(bodyA.model).toBe("model-a");
    expect(bodyA.results).toHaveLength(2);

    registry.replaceRemoteProviders([new FakeEmbedProvider("pb", "model-b", 100, 16)]);
    const health = (await (await app.request("/health")).json()) as { embedding: { model: string } };
    expect(health.embedding.model).toBe("model-b");

    const searchB = await postSearch(app, { query: "hello world" });
    const bodyB = (await searchB.json()) as { model: string; results: unknown[] };
    expect(bodyB.model).toBe("model-b");
    expect(bodyB.results).toEqual([]);

    const stats = (await (await app.request("/v1/stats", { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json()) as {
      indexed: number;
      unindexed: number;
    };
    expect(stats.indexed).toBe(0);
    expect(stats.unindexed).toBe(2);
    expect(repo.listUnindexed(10, "model-b")).toHaveLength(2);

    expect(vectorCount(db, "message_embeddings_model_a")).toBe(3);

    const sessions = repo.listUnindexed(10, "model-b");
    const s1 = sessions.find((s) => s.source_id === "s1")!;
    expect(await indexer.indexSession(s1.id)).toBe(true);
    expect(vectorCount(db, "message_embeddings_model_b")).toBe(2);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(1);

    const reindex = await app.request("/v1/settings/reindex", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const reindexBody = (await reindex.json()) as { total: number; indexed: number; failed: number; remaining: number };
    expect(reindexBody).toEqual({ total: 1, indexed: 1, failed: 0, remaining: 0 });
    expect(vectorCount(db, "message_embeddings_model_b")).toBe(3);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(0);

    const searchB2 = await postSearch(app, { query: "hello world" });
    const bodyB2 = (await searchB2.json()) as { model: string; results: Array<{ session: { source_id: string } }> };
    expect(bodyB2.model).toBe("model-b");
    expect(bodyB2.results).toHaveLength(2);
    expect(bodyB2.results[0]!.session.source_id).toBe("s1");

    const put3 = await putSession(app, sessionBody({ source_id: "s1", title: "updated" }));
    expect(put3.status).toBe(200);
    expect(vectorCount(db, "message_embeddings_model_b")).toBe(3);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(0);
  });
});

describe("0002 migration from legacy message_embeddings", () => {
  it("renames legacy 1024-dim table to bge_m3 and keeps search working", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-migrate-"));
    const db = createDb(path.join(dir, "legacy.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, machine TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, cwd TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        deleted_at INTEGER, indexed_at INTEGER, indexed_model TEXT, UNIQUE (agent, machine, source_id)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        idx INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', ts INTEGER, raw TEXT,
        UNIQUE (session_id, idx)
      );
      CREATE VIRTUAL TABLE message_embeddings USING vec0 (
        message_id INTEGER PRIMARY KEY,
        embedding float[1024]
      );
    `);
    const repo = new SessionRepository(db);
    const { id: sessionId } = repo.upsert(sessionBody() as unknown as SessionUpsertInput);
    const message = db.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY idx LIMIT 1").get(sessionId) as {
      id: number;
    };
    const vector = hashVector("hello world");
    db.prepare("INSERT INTO message_embeddings (message_id, embedding) VALUES (?, ?)").run(
      BigInt(message.id),
      toVectorBlob(vector),
    );

    migrate(db);

    expect(tableExists(db, "message_embeddings")).toBe(false);
    expect(tableExists(db, "message_embeddings_bge_m3")).toBe(true);
    expect(vectorCount(db, "message_embeddings_bge_m3")).toBe(1);

    const hits = searchSessions(db, "bge-m3", vector, 5, {});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.id).toBe(sessionId);
    expect(hits[0]!.distance).toBeLessThan(0.01);

    storeEmbeddings(db, sessionId, "bge-m3", [{ messageId: message.id, vector }]);
    expect(vectorCount(db, "message_embeddings_bge_m3")).toBe(1);
    db.close();
  });
});

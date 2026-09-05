import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type SqliteDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { searchSessions } from "../src/db/search.js";
import { toVectorBlob } from "../src/db/embeddings.js";
import { hashVector, sessionBody } from "./helpers.js";
import { SessionRepository } from "../src/db/sessions.js";
import type { SessionUpsertInput } from "@session-hub/shared";

function tableNames(db: SqliteDatabase, pattern: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name").all(pattern) as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function vectorCount(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function seedLegacyVectors(db: SqliteDatabase, count: number): void {
  db.exec("CREATE VIRTUAL TABLE message_embeddings USING vec0 (message_id INTEGER PRIMARY KEY, embedding float[1024])");
  const insert = db.prepare("INSERT INTO message_embeddings (message_id, embedding) VALUES (?, ?)");
  for (let i = 1; i <= count; i++) insert.run(BigInt(i + 1000), toVectorBlob(hashVector(`v${i}`)));
}

function forgetMigration(db: SqliteDatabase, name: string): void {
  db.prepare("DELETE FROM _migrations WHERE name = ?").run(name);
}

describe("0003 repair vec0 shadow tables", () => {
  it("restores the renamed vtab, copies legacy vectors into a healthy bge_m3 table and drops leftovers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-repair-"));
    const db = createDb(path.join(dir, "repair.db"));
    migrate(db);

    db.exec("DROP TABLE message_embeddings_bge_m3");
    seedLegacyVectors(db, 3);
    db.exec("CREATE TABLE message_embeddings_trash (id INTEGER PRIMARY KEY)");
    db.exec("ALTER TABLE message_embeddings RENAME TO message_embeddings_bge_m3");

    expect(tableNames(db, "message_embeddings%")).toEqual([
      "message_embeddings_bge_m3",
      "message_embeddings_chunks",
      "message_embeddings_info",
      "message_embeddings_rowids",
      "message_embeddings_trash",
      "message_embeddings_vector_chunks00",
    ]);

    forgetMigration(db, "0003_repair_vec0_shadow_tables");
    migrate(db);

    expect(tableExists(db, "message_embeddings_bge_m3")).toBe(true);
    expect(tableExists(db, "message_embeddings_bge_m3_info")).toBe(true);
    expect(tableExists(db, "message_embeddings")).toBe(false);
    expect(vectorCount(db, "message_embeddings_bge_m3")).toBe(3);
    expect(tableNames(db, "message_embeddings%")).toEqual([
      "message_embeddings_bge_m3",
      "message_embeddings_bge_m3_chunks",
      "message_embeddings_bge_m3_info",
      "message_embeddings_bge_m3_rowids",
      "message_embeddings_bge_m3_vector_chunks00",
    ]);

    const insert = db.prepare("INSERT INTO message_embeddings_bge_m3 (message_id, embedding) VALUES (?, ?)");
    insert.run(BigInt(99), toVectorBlob(hashVector("v99")));
    expect(vectorCount(db, "message_embeddings_bge_m3")).toBe(4);

    migrate(db);
    expect(vectorCount(db, "message_embeddings_bge_m3")).toBe(4);
    db.close();
  });

  it("repaired vectors stay searchable under the bge-m3 model space", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-repair-search-"));
    const db = createDb(path.join(dir, "repair-search.db"));
    migrate(db);

    db.exec("DROP TABLE message_embeddings_bge_m3");
    seedLegacyVectors(db, 1);
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
    db.exec("ALTER TABLE message_embeddings RENAME TO message_embeddings_bge_m3");

    forgetMigration(db, "0003_repair_vec0_shadow_tables");
    migrate(db);

    const hits = searchSessions(db, "bge-m3", vector, 5, {});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.session.id).toBe(sessionId);
    expect(hits[0]!.distance).toBeLessThan(0.01);
    db.close();
  });

  it("is a no-op on healthy and fresh databases", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-repair-noop-"));
    const db = createDb(path.join(dir, "noop.db"));
    migrate(db);
    expect(tableExists(db, "message_embeddings_bge_m3")).toBe(true);
    expect(tableExists(db, "message_embeddings_bge_m3_info")).toBe(true);
    expect(tableExists(db, "message_embeddings")).toBe(false);
    const before = tableNames(db, "message_embeddings%");
    migrate(db);
    expect(tableNames(db, "message_embeddings%")).toEqual(before);
    db.close();
  });
});

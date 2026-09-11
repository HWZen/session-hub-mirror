import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type SqliteDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { toVectorBlob } from "../src/db/embeddings.js";
import { hashVector } from "./helpers.js";

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

    db.exec("DROP TABLE IF EXISTS message_embeddings_bge_m3");
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

  it("is a no-op on healthy and fresh databases", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-repair-noop-"));
    const db = createDb(path.join(dir, "noop.db"));
    migrate(db);
    expect(tableExists(db, "message_embeddings_bge_m3")).toBe(false);
    expect(tableNames(db, "message_embeddings%")).toEqual([]);
    expect(tableExists(db, "message_chunks")).toBe(true);
    const before = tableNames(db, "message_embeddings%");
    migrate(db);
    expect(tableNames(db, "message_embeddings%")).toEqual(before);
    db.close();
  });
});

describe("0005 session meta chunk", () => {
  function seedChunkState(db: SqliteDatabase): void {
    db.exec(
      "INSERT INTO sessions (id, agent, machine, source_id, created_at, updated_at) VALUES ('s1', 'opencode', 'M1', 'sid', 1, 2)",
    );
    db.exec("INSERT INTO messages (id, session_id, idx, role, text) VALUES (11, 's1', 0, 'user', 'hello')");
    db.exec(
      "INSERT INTO message_chunks (id, message_id, chunk_no, source, text, char_start) VALUES (5, 11, 0, 'text', 'hello', 0)",
    );
    db.exec(
      "CREATE VIRTUAL TABLE chunk_embeddings_bge_m3 USING vec0 (chunk_id INTEGER PRIMARY KEY, embedding float[1024])",
    );
    db.exec(
      "CREATE VIRTUAL TABLE chunk_embeddings_custom_model USING vec0 (chunk_id INTEGER PRIMARY KEY, embedding float[1024])",
    );
    const insert = db.prepare("INSERT INTO chunk_embeddings_bge_m3 (chunk_id, embedding) VALUES (?, ?)");
    insert.run(BigInt(5), toVectorBlob(hashVector("hello")));
    db.exec("UPDATE sessions SET indexed_at = 3, indexed_model = 'bge-m3'");
  }

  it("clears chunks, drops every chunk_embeddings vtab and resets indexing flags", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-meta-migrate-"));
    const db = createDb(path.join(dir, "meta.db"));
    migrate(db);
    seedChunkState(db);
    expect(tableExists(db, "chunk_embeddings_bge_m3")).toBe(true);
    expect(tableExists(db, "chunk_embeddings_custom_model")).toBe(true);

    forgetMigration(db, "0005_session_meta_chunk");
    migrate(db);

    expect(tableNames(db, "chunk_embeddings_%")).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM message_chunks").get() as { n: number }).n).toBe(0);
    const flags = db.prepare("SELECT indexed_at, indexed_model FROM sessions WHERE id = 's1'").get() as {
      indexed_at: number | null;
      indexed_model: string | null;
    };
    expect(flags.indexed_at).toBeNull();
    expect(flags.indexed_model).toBeNull();
    db.close();
  });
});

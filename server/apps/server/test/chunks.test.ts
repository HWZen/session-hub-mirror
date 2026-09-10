import { describe, expect, it } from "vitest";
import type { SessionUpsertInput } from "@session-hub/shared";
import { hashVector, makeDb, sessionBody } from "./helpers.js";
import { clearSessionChunks, listChunkEmbeddingTables, storeChunks } from "../src/db/chunks.js";
import { SessionRepository } from "../src/db/sessions.js";
import type { SqliteDatabase } from "../src/db/connection.js";

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("chunk storage", () => {
  it("stores chunk rows + vectors, replaces on re-store, clears on demand", () => {
    const db = makeDb();
    const repo = new SessionRepository(db);
    const { id } = repo.upsert(sessionBody() as unknown as SessionUpsertInput);
    const messages = repo.messageSources(id);
    expect(messages).toHaveLength(2);

    const rows = [
      { messageId: messages[0]!.id, chunkNo: 0, source: "text" as const, text: "hello", charStart: 0, vector: hashVector("hello") },
      { messageId: messages[0]!.id, chunkNo: 0, source: "reasoning" as const, text: "think", charStart: 0, vector: hashVector("think") },
      { messageId: messages[1]!.id, chunkNo: 0, source: "text" as const, text: "world", charStart: 0, vector: hashVector("world") },
    ];
    storeChunks(db, id, "bge-m3", rows);
    expect(count(db, "message_chunks")).toBe(3);
    expect(count(db, "chunk_embeddings_bge_m3")).toBe(3);
    expect(listChunkEmbeddingTables(db)).toContain("chunk_embeddings_bge_m3");

    storeChunks(db, id, "bge-m3", [rows[0]!]);
    expect(count(db, "message_chunks")).toBe(1);
    expect(count(db, "chunk_embeddings_bge_m3")).toBe(1);

    clearSessionChunks(db, id);
    expect(count(db, "message_chunks")).toBe(0);
    expect(count(db, "chunk_embeddings_bge_m3")).toBe(0);
    db.close();
  });

  it("propagates reasoning source into messageSources raw extraction path", () => {
    const db = makeDb();
    const repo = new SessionRepository(db);
    const { id } = repo.upsert(
      sessionBody({
        messages: [
          { role: "assistant", text: "", ts: 1, raw: [{ type: "reasoning", text: "hidden plan" }] },
        ],
      }) as unknown as SessionUpsertInput,
    );
    const [message] = repo.messageSources(id);
    expect(message!.raw).toEqual([{ type: "reasoning", text: "hidden plan" }]);
    db.close();
  });
});

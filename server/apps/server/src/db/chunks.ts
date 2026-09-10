import type { MessageSource } from "@session-hub/shared";
import type { SqliteDatabase } from "./connection.js";
import { toVectorBlob } from "./embeddings.js";

export function chunkEmbeddingTableFor(model: string): string {
  return `chunk_embeddings_${model.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

export function listChunkEmbeddingTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chunk_embeddings_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function ensureChunkEmbeddingsTable(db: SqliteDatabase, model: string, dim: number): void {
  const table = chunkEmbeddingTableFor(model);
  if (!/^[a-z0-9_]+$/.test(table)) {
    throw new Error(`invalid chunk embeddings table name for model: ${model}`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0 (chunk_id INTEGER PRIMARY KEY, embedding float[${dim}])`,
  );
}

export function clearSessionChunks(db: SqliteDatabase, sessionId: string): void {
  for (const table of listChunkEmbeddingTables(db)) {
    db.prepare(
      `DELETE FROM ${table} WHERE chunk_id IN (
         SELECT c.id FROM message_chunks c JOIN messages m ON m.id = c.message_id WHERE m.session_id = ?
       )`,
    ).run(sessionId);
  }
  db.prepare(
    "DELETE FROM message_chunks WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)",
  ).run(sessionId);
}

export interface ChunkEmbeddingRow {
  messageId: number;
  chunkNo: number;
  source: MessageSource;
  text: string;
  charStart: number;
  vector: Float32Array;
}

export function storeChunks(
  db: SqliteDatabase,
  sessionId: string,
  model: string,
  rows: ReadonlyArray<ChunkEmbeddingRow>,
): void {
  const run = db.transaction(() => {
    clearSessionChunks(db, sessionId);
    if (rows.length === 0) return;
    ensureChunkEmbeddingsTable(db, model, rows[0]!.vector.length);
    const insertChunk = db.prepare(
      "INSERT INTO message_chunks (message_id, chunk_no, source, text, char_start) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEmbedding = db.prepare(
      `INSERT INTO ${chunkEmbeddingTableFor(model)} (chunk_id, embedding) VALUES (?, ?)`,
    );
    for (const row of rows) {
      const info = insertChunk.run(row.messageId, row.chunkNo, row.source, row.text, row.charStart);
      insertEmbedding.run(BigInt(Number(info.lastInsertRowid)), toVectorBlob(row.vector));
    }
  });
  run();
}

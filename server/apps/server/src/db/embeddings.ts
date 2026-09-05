import type { SqliteDatabase } from "./connection.js";

export function embeddingTableFor(model: string): string {
  return `message_embeddings_${model.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

export function listEmbeddingTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'message_embeddings_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function ensureEmbeddingsTable(db: SqliteDatabase, model: string, dim: number): void {
  const table = embeddingTableFor(model);
  if (!/^[a-z0-9_]+$/.test(table)) {
    throw new Error(`invalid embeddings table name for model: ${model}`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0 (message_id INTEGER PRIMARY KEY, embedding float[${dim}])`,
  );
}

export function clearSessionEmbeddings(db: SqliteDatabase, sessionId: string): void {
  for (const table of listEmbeddingTables(db)) {
    db.prepare(`DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`).run(sessionId);
  }
}

export function toVectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

export function storeEmbeddings(
  db: SqliteDatabase,
  sessionId: string,
  model: string,
  rows: ReadonlyArray<{ messageId: number; vector: Float32Array }>,
): void {
  const run = db.transaction(() => {
    clearSessionEmbeddings(db, sessionId);
    if (rows.length === 0) return;
    ensureEmbeddingsTable(db, model, rows[0]!.vector.length);
    const insert = db.prepare(`INSERT INTO ${embeddingTableFor(model)} (message_id, embedding) VALUES (?, ?)`);
    for (const row of rows) {
      insert.run(BigInt(row.messageId), toVectorBlob(row.vector));
    }
  });
  run();
}

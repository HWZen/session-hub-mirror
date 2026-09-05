import type { SqliteDatabase } from "./connection.js";

export function toVectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

export function storeEmbeddings(
  db: SqliteDatabase,
  sessionId: string,
  rows: ReadonlyArray<{ messageId: number; vector: Float32Array }>,
): void {
  const run = db.transaction(() => {
    db.prepare("DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)").run(sessionId);
    const insert = db.prepare("INSERT INTO message_embeddings (message_id, embedding) VALUES (?, ?)");
    for (const row of rows) {
      insert.run(BigInt(row.messageId), toVectorBlob(row.vector));
    }
  });
  run();
}

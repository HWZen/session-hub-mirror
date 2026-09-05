import { EMBEDDING_MODEL } from "@session-hub/shared";
import type { SqliteDatabase } from "./db/connection.js";
import { storeEmbeddings } from "./db/embeddings.js";
import type { SessionRepository } from "./db/sessions.js";
import type { EmbeddingRegistry } from "./embedding/registry.js";

export class SessionIndexer {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly repo: SessionRepository,
    private readonly registry: EmbeddingRegistry,
  ) {}

  async indexSession(sessionId: string): Promise<boolean> {
    try {
      const rows = this.repo.messageTexts(sessionId);
      if (rows.length === 0) {
        this.repo.setIndexed(sessionId, EMBEDDING_MODEL);
        return true;
      }
      const { vectors, provider } = await this.registry.embed(rows.map((r) => r.text));
      storeEmbeddings(
        this.db,
        sessionId,
        rows.map((row, i) => ({ messageId: row.id, vector: vectors[i]! })),
      );
      this.repo.setIndexed(sessionId, EMBEDDING_MODEL);
      console.log(`[index] session=${sessionId} messages=${rows.length} provider=${provider}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[index] session=${sessionId} failed: ${message}`);
      return false;
    }
  }
}

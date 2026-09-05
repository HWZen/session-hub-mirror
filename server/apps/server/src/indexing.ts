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
        const activeModel = this.registry.activeModel();
        if (activeModel === null) {
          return false;
        }
        this.repo.setIndexed(sessionId, activeModel);
        return true;
      }
      const { vectors, provider, model } = await this.registry.embed(rows.map((r) => r.text));
      storeEmbeddings(
        this.db,
        sessionId,
        model,
        rows.map((row, i) => ({ messageId: row.id, vector: vectors[i]! })),
      );
      this.repo.setIndexed(sessionId, model);
      console.log(`[index] session=${sessionId} messages=${rows.length} provider=${provider} model=${model}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[index] session=${sessionId} failed: ${message}`);
      return false;
    }
  }
}

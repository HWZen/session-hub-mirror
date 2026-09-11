import type { MessageSource } from "@session-hub/shared";
import type { SqliteDatabase } from "./db/connection.js";
import { storeChunks } from "./db/chunks.js";
import type { MessageSourceRow, SessionRepository } from "./db/sessions.js";
import type { EmbeddingRegistry } from "./embedding/registry.js";
import { chunkText } from "./indexing/chunk.js";
import { extractReasoning } from "./indexing/raw-extract.js";
import { buildSessionMetaHeader } from "./indexing/session-meta.js";

interface PendingChunk {
  messageId: number;
  chunkNo: number;
  source: MessageSource;
  text: string;
  charStart: number;
}

function collectChunks(message: MessageSourceRow): PendingChunk[] {
  const chunks: PendingChunk[] = [];
  const seen = new Set<string>();
  const counters = new Map<MessageSource, number>();
  const push = (source: MessageSource, text: string): void => {
    for (const chunk of chunkText(text)) {
      if (seen.has(chunk.text)) continue;
      seen.add(chunk.text);
      const chunkNo = counters.get(source) ?? 0;
      counters.set(source, chunkNo + 1);
      chunks.push({
        messageId: message.id,
        chunkNo,
        source,
        text: chunk.text,
        charStart: chunk.char_start,
      });
    }
  };
  if (message.text.trim() !== "") push("text", message.text);
  for (const reasoning of extractReasoning(message.agent, message.raw)) {
    push("reasoning", reasoning);
  }
  return chunks;
}

export class SessionIndexer {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly repo: SessionRepository,
    private readonly registry: EmbeddingRegistry,
  ) {}

  async indexSession(sessionId: string): Promise<boolean> {
    try {
      const messages = this.repo.messageSources(sessionId);
      const pending = messages.flatMap(collectChunks);
      if (pending.length === 0) {
        const activeModel = this.registry.activeModel();
        if (activeModel === null) {
          return false;
        }
        storeChunks(this.db, sessionId, activeModel, []);
        this.repo.setIndexed(sessionId, activeModel);
        return true;
      }
      const meta = this.repo.findById(sessionId);
      const header = meta === null ? "" : buildSessionMetaHeader(meta);
      const { vectors, provider, model } = await this.registry.embed(
        pending.map((chunk, i) => (i === 0 && header !== "" ? `${header}\n${chunk.text}` : chunk.text)),
      );
      storeChunks(
        this.db,
        sessionId,
        model,
        pending.map((chunk, i) => ({
          messageId: chunk.messageId,
          chunkNo: chunk.chunkNo,
          source: chunk.source,
          text: chunk.text,
          charStart: chunk.charStart,
          vector: vectors[i]!,
        })),
      );
      this.repo.setIndexed(sessionId, model);
      console.log(
        `[index] session=${sessionId} messages=${messages.length} chunks=${pending.length} provider=${provider} model=${model}`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[index] session=${sessionId} failed: ${message}`);
      return false;
    }
  }
}

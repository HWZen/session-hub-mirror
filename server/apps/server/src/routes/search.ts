import { Hono } from "hono";
import { searchRequestSchema } from "@session-hub/shared";
import type { SqliteDatabase } from "../db/connection.js";
import { searchSessions } from "../db/search.js";
import { EmbeddingUnavailableError, type EmbeddingRegistry } from "../embedding/registry.js";

export interface SearchRouteDeps {
  db: SqliteDatabase;
  registry: EmbeddingRegistry;
}

const DEFAULT_TOP_K = 10;

export function searchRoutes(deps: SearchRouteDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = searchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    const topK = parsed.data.top_k ?? DEFAULT_TOP_K;
    let provider: string;
    let model: string;
    let vector: Float32Array;
    try {
      const output = await deps.registry.embed([parsed.data.query]);
      provider = output.provider;
      model = output.model;
      vector = output.vectors[0]!;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        return c.json({ error: "embedding unavailable", detail: err.message }, 503);
      }
      throw err;
    }
    const results = searchSessions(deps.db, model, vector, topK, parsed.data.filters ?? {});
    return c.json({ model, provider, results });
  });

  return app;
}

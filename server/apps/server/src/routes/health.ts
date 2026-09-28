import { Hono } from "hono";
import { SERVER_VERSION } from "../config.js";
import type { SqliteDatabase } from "../db/connection.js";
import type { EmbeddingRegistry } from "../embedding/registry.js";

export interface HealthRouteDeps {
  db: SqliteDatabase;
  registry: EmbeddingRegistry;
}

export function healthRoutes(deps: HealthRouteDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    let dbOk = true;
    try {
      deps.db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const journalMode = deps.db.pragma("journal_mode", { simple: true });
    const pageCount = Number(deps.db.pragma("page_count", { simple: true }));
    const pageSize = Number(deps.db.pragma("page_size", { simple: true }));
    const sizeBytes = pageCount * pageSize;
    const warnings =
      deps.registry.providers.length === 0 ? ["未配置任何向量提供商，索引与语义检索不可用"] : [];
    return c.json(
      {
        ok: dbOk,
        version: SERVER_VERSION,
        warnings,
        db: { ok: dbOk, journal_mode: journalMode, size_bytes: sizeBytes },
        embedding: deps.registry.status(),
        now: Date.now(),
      },
      dbOk ? 200 : 500,
    );
  });

  return app;
}

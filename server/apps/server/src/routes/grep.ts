import { Hono } from "hono";
import { grepRequestSchema } from "@session-hub/shared";
import type { SqliteDatabase } from "../db/connection.js";
import { grepMessages } from "../db/grep.js";

export interface GrepRouteDeps {
  db: SqliteDatabase;
}

const DEFAULT_LIMIT = 50;
const PARAM_KEYS = [
  "q",
  "case_sensitive",
  "limit",
  "offset",
  "agent",
  "machine",
  "source_id",
  "title",
  "created_from",
  "created_to",
  "updated_from",
  "updated_to",
] as const;

export function grepRoutes(deps: GrepRouteDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const query = c.req.query();
    const raw: Record<string, string> = {};
    for (const key of PARAM_KEYS) {
      const value = query[key];
      if (value !== undefined && value !== "") raw[key] = value;
    }
    const parsed = grepRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
    }
    const { q, case_sensitive, limit, offset, ...filters } = parsed.data;
    const { total, items } = grepMessages(deps.db, q, case_sensitive ?? false, filters, {
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    });
    return c.json({ total, limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0, items });
  });

  return app;
}

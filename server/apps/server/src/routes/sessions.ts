import { Hono } from "hono";
import { sessionFilterSchema, sessionUpsertSchema } from "@session-hub/shared";
import type { SessionRepository } from "../db/sessions.js";
import type { SessionIndexer } from "../indexing.js";

export interface SessionRouteDeps {
  repo: SessionRepository;
  indexer: SessionIndexer;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const FILTER_KEYS = ["agent", "machine", "source_id", "created_from", "created_to", "updated_from", "updated_to"] as const;

function parseBoundedInt(value: string | undefined, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function sessionRoutes(deps: SessionRouteDeps): Hono {
  const app = new Hono();

  app.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = sessionUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    const { id, created } = deps.repo.upsert(parsed.data);
    const indexed = await deps.indexer.indexSession(id);
    return c.json({ id, created, indexed }, created ? 201 : 200);
  });

  app.get("/", (c) => {
    const q = c.req.query();
    const rawFilters: Record<string, string> = {};
    for (const key of FILTER_KEYS) {
      const value = q[key];
      if (value !== undefined && value !== "") rawFilters[key] = value;
    }
    const filters = sessionFilterSchema.safeParse(rawFilters);
    if (!filters.success) {
      return c.json({ error: "invalid filters", issues: filters.error.issues }, 400);
    }
    const limit = parseBoundedInt(q["limit"], 1, MAX_LIMIT, DEFAULT_LIMIT);
    const offset = parseBoundedInt(q["offset"], 0, Number.MAX_SAFE_INTEGER, 0);
    if (limit === null || offset === null) {
      return c.json({ error: `invalid pagination: limit must be 1..${MAX_LIMIT}, offset >= 0` }, 400);
    }
    const { total, items } = deps.repo.list(filters.data, { limit, offset });
    return c.json({ total, limit, offset, items });
  });

  app.get("/:id", (c) => {
    const detail = deps.repo.get(c.req.param("id"));
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  app.delete("/:id", (c) => {
    const ok = deps.repo.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

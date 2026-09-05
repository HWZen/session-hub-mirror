import { Hono } from "hono";
import type { SessionRepository } from "../db/sessions.js";
import type { EmbeddingRegistry } from "../embedding/registry.js";

export interface StatsRouteDeps {
  repo: SessionRepository;
  registry: EmbeddingRegistry;
}

export function statsRoutes(deps: StatsRouteDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(deps.repo.stats(deps.registry.activeModel())));
  return app;
}

import { Hono } from "hono";
import type { SessionRepository } from "../db/sessions.js";

export interface StatsRouteDeps {
  repo: SessionRepository;
}

export function statsRoutes(deps: StatsRouteDeps): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(deps.repo.stats()));
  return app;
}

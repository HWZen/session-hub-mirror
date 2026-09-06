import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import type { SqliteDatabase } from "./db/connection.js";
import type { SessionRepository } from "./db/sessions.js";
import type { EmbeddingRegistry } from "./embedding/registry.js";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { sessionRoutes } from "./routes/sessions.js";
import { settingsRoutes, type SettingsRouteDeps } from "./routes/settings.js";
import { statsRoutes } from "./routes/stats.js";
import { staticRoutes } from "./routes/static.js";

export interface AppDeps {
  db: SqliteDatabase;
  repo: SessionRepository;
  registry: EmbeddingRegistry;
  token: string;
  webDist?: string | undefined;
  settings?: SettingsRouteDeps | undefined;
  onSessionUpserted?: (() => void) | undefined;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("/v1/*", bearerAuth(deps.token));
  app.route("/v1/sessions", sessionRoutes({ repo: deps.repo, onUpserted: deps.onSessionUpserted }));
  app.route("/v1/search", searchRoutes(deps));
  app.route("/v1/stats", statsRoutes(deps));
  if (deps.settings) {
    app.route("/v1/settings", settingsRoutes(deps.settings));
  }
  app.route("/health", healthRoutes(deps));
  if (deps.webDist) {
    app.route("/", staticRoutes(deps.webDist));
  }
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error(`[http] ${c.req.method} ${c.req.path} error: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

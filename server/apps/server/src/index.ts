import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";
import { resolveServerPath } from "./config.js";
import { AutoIndexer } from "./auto-index.js";
import { installGracefulShutdown } from "./shutdown.js";

try {
  const { env, db, repo, indexer, registry, settings } = bootstrap();
  const autoIndexer = new AutoIndexer(repo, indexer, registry, env.SH_AUTO_INDEX_INTERVAL_MS);
  autoIndexer.start();
  const app = createApp({
    db,
    repo,
    registry,
    token: env.SH_AUTH_TOKEN,
    webDist: env.SH_WEB_DIST ? resolveServerPath(env.SH_WEB_DIST) : undefined,
    settings: { ...settings, onProvidersSaved: () => autoIndexer.kick() },
    onSessionUpserted: () => autoIndexer.kick(),
  });
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
    console.log(`[server] listening on ${info.address}:${info.port} db=${env.SH_DB_PATH}`);
  }) as Server;
  installGracefulShutdown({ server, autoIndexer, db, exit: (code) => process.exit(code) });
} catch (err) {
  console.error(`[server] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

import { serve } from "@hono/node-server";
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";
import { resolveServerPath } from "./config.js";

try {
  const { env, db, repo, indexer, registry, settings } = bootstrap();
  const app = createApp({
    db,
    repo,
    indexer,
    registry,
    token: env.SH_AUTH_TOKEN,
    webDist: env.SH_WEB_DIST ? resolveServerPath(env.SH_WEB_DIST) : undefined,
    settings,
  });
  serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
    console.log(`[server] listening on ${info.address}:${info.port} db=${env.SH_DB_PATH}`);
  });
} catch (err) {
  console.error(`[server] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

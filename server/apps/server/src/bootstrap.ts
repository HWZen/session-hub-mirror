import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { SessionRepository } from "./db/sessions.js";
import { createRemoteProviders, EmbeddingRegistry } from "./embedding/registry.js";
import { SessionIndexer } from "./indexing.js";
import { createFileSettingsStore } from "./settings-store.js";
import { loadEnv, resolveServerPath, type ServerEnv } from "./config.js";
import type { SettingsRouteDeps } from "./routes/settings.js";

export interface Bootstrap {
  env: ServerEnv;
  db: ReturnType<typeof createDb>;
  repo: SessionRepository;
  indexer: SessionIndexer;
  registry: EmbeddingRegistry;
  settings: SettingsRouteDeps;
}

export function bootstrap(): Bootstrap {
  const env = loadEnv();
  const db = createDb(resolveServerPath(env.SH_DB_PATH));
  migrate(db);
  const repo = new SessionRepository(db);
  const store = createFileSettingsStore(
    resolveServerPath(env.SH_PROVIDERS_LOCAL_FILE),
    resolveServerPath(env.SH_PROVIDERS_FILE),
  );
  const registry = new EmbeddingRegistry(createRemoteProviders(store.load().providers, process.env), env.SH_EMBED_BATCH_SIZE);
  const indexer = new SessionIndexer(db, repo, registry);
  const settings: SettingsRouteDeps = {
    store,
    registry,
    repo,
    indexer,
    env: process.env,
  };
  return { env, db, repo, indexer, registry, settings };
}

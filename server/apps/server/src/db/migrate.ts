import { EMBEDDING_DIMENSIONS } from "@session-hub/shared";
import type { SqliteDatabase } from "./connection.js";

const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        machine TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        indexed_at INTEGER,
        indexed_model TEXT,
        UNIQUE (agent, machine, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions (agent, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_machine_updated ON sessions (machine, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        ts INTEGER,
        raw TEXT,
        UNIQUE (session_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, idx);

      CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0 (
        message_id INTEGER PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}]
      );
    `,
  },
];

export function migrate(db: SqliteDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const rows = db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>;
  const applied = new Set(rows.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(m.name, Date.now());
    });
    run();
  }
}

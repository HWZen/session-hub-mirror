import type { SqliteDatabase } from "./connection.js";
import { listEmbeddingTables } from "./embeddings.js";

const MIGRATION_0001_SQL = `
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
    embedding float[1024]
  );
`;

const LEGACY_EMBEDDINGS_TABLE = "message_embeddings";
const BGE_M3_TABLE = "message_embeddings_bge_m3";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

function vec0VtabExists(db: SqliteDatabase, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE 'CREATE VIRTUAL TABLE%'")
      .get(name) !== undefined
  );
}

function renameLegacyEmbeddingsTable(db: SqliteDatabase): void {
  if (!tableExists(db, LEGACY_EMBEDDINGS_TABLE)) return;
  if (tableExists(db, BGE_M3_TABLE)) {
    db.exec(`DROP TABLE ${LEGACY_EMBEDDINGS_TABLE}`);
    return;
  }
  db.exec(
    `CREATE VIRTUAL TABLE ${BGE_M3_TABLE} USING vec0 (message_id INTEGER PRIMARY KEY, embedding float[1024])`,
  );
  db.exec(
    `INSERT INTO ${BGE_M3_TABLE} (message_id, embedding) SELECT message_id, embedding FROM ${LEGACY_EMBEDDINGS_TABLE}`,
  );
  db.exec(`DROP TABLE ${LEGACY_EMBEDDINGS_TABLE}`);
}

function dropOrphanShadowTables(db: SqliteDatabase): void {
  const live = new Set(listEmbeddingTables(db));
  const shadowRe = new Set(
    [...live].map((v) => new RegExp(`^${v}_(?:info|chunks|rowids|vector_chunks\\d+)$`)),
  );
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'message_embeddings_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of rows) {
    if (live.has(name) || [...shadowRe].some((re) => re.test(name))) continue;
    db.exec(`DROP TABLE "${name}"`);
  }
}

function repairRenamedVec0Table(db: SqliteDatabase): void {
  const targetShadowInfo = `${BGE_M3_TABLE}_info`;
  const legacyShadowInfo = `${LEGACY_EMBEDDINGS_TABLE}_info`;
  if (
    !vec0VtabExists(db, BGE_M3_TABLE) ||
    tableExists(db, targetShadowInfo) ||
    !tableExists(db, legacyShadowInfo)
  ) {
    return;
  }
  db.exec(`ALTER TABLE ${BGE_M3_TABLE} RENAME TO ${LEGACY_EMBEDDINGS_TABLE}`);
  renameLegacyEmbeddingsTable(db);
  dropOrphanShadowTables(db);
}

const MIGRATIONS: ReadonlyArray<{ name: string; up: (db: SqliteDatabase) => void }> = [
  {
    name: "0001_init",
    up: (db) => {
      db.exec(MIGRATION_0001_SQL);
    },
  },
  {
    name: "0002_model_partioned_embeddings",
    up: (db) => {
      renameLegacyEmbeddingsTable(db);
    },
  },
  {
    name: "0003_repair_vec0_shadow_tables",
    up: (db) => {
      repairRenamedVec0Table(db);
    },
  },
];

export function migrate(db: SqliteDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const rows = db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>;
  const applied = new Set(rows.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(m.name, Date.now());
    });
    run();
  }
}

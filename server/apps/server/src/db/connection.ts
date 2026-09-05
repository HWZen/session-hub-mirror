import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const BUSY_TIMEOUT_MS = 5000;

export type SqliteDatabase = Database.Database;

export function createDb(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = TRUNCATE");
  const journalMode = db.pragma("journal_mode", { simple: true });
  if (journalMode !== "truncate") {
    throw new Error(`journal_mode must be TRUNCATE (SMB/WAL ban), got "${journalMode}"`);
  }
  db.pragma("synchronous = FULL");
  const synchronous = db.pragma("synchronous", { simple: true });
  if (synchronous !== 2) {
    throw new Error(`synchronous must be FULL, got "${synchronous}"`);
  }
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  return db;
}

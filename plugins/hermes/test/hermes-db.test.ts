import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listUnarchivedSessionIds, openHermesDb, readHermesSession } from "../src/hermes-db.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "session-hub-hermes-db-"));
  dbPath = join(directory, "state.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      git_repo_root TEXT,
      started_at REAL NOT NULL,
      last_activity_at REAL NOT NULL,
      archived INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_calls TEXT
    );
  `);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "session-active", "title", "D:/work", "D:/repo", 1_700_000_000, 1_700_000_010, 0,
  );
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "session-archived", "old", null, null, 1_600_000_000, 1_600_000_010, 1,
  );
  const insertMessage = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertMessage.run("m2", "session-active", "assistant", "second", null, null, null);
  insertMessage.run("m1", "session-active", "user", "first", null, null, null);
  db.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("Hermes state.db access", () => {
  it("reads metadata and preserves message rowid order through a read-only connection", () => {
    const db = openHermesDb(dbPath);
    try {
      const entry = readHermesSession(db, "session-active");
      expect(entry?.session).toEqual({
        id: "session-active",
        title: "title",
        cwd: "D:/work",
        git_repo_root: "D:/repo",
        started_at: 1_700_000_000,
        last_activity_at: 1_700_000_010,
      });
      expect(entry?.messages.map((message) => message.content)).toEqual(["second", "first"]);
      expect(() => db.prepare("UPDATE sessions SET title = 'changed'").run()).toThrow();
    } finally {
      db.close();
    }
  });

  it("returns null for an unknown session and lists only unarchived sessions", () => {
    const db = openHermesDb(dbPath);
    try {
      expect(readHermesSession(db, "missing")).toBeNull();
      expect(listUnarchivedSessionIds(db)).toEqual(["session-active"]);
    } finally {
      db.close();
    }
  });
});

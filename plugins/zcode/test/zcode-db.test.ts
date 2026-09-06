import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTopLevelSessionIds, openZcodeDb, readZcodeSession } from "../src/zcode-db.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sh-zcode-db-"));
  dbPath = join(dir, "db.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text primary key,
      title text not null,
      directory text,
      parent_id text,
      time_created integer not null,
      time_updated integer not null
    );
    CREATE TABLE message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      sequence integer,
      data text not null
    );
    CREATE TABLE part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      sequence integer,
      data text not null
    );
  `);
  db.prepare(
    "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("sess_main", "main title", "D:\\work", null, 1000, 2000);
  db.prepare(
    "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("sess_subagent_agent_x", "sub", "D:\\work", "sess_main", 1100, 1200);

  const insMsg = db.prepare(
    "INSERT INTO message (id, session_id, time_created, sequence, data) VALUES (?, ?, ?, ?, ?)",
  );
  insMsg.run(
    "msg_2",
    "sess_main",
    1050,
    null,
    JSON.stringify({ role: "assistant", time: { created: 1050 }, semantics: { kind: "assistant_response" } }),
  );
  insMsg.run(
    "msg_1",
    "sess_main",
    1000,
    null,
    JSON.stringify({ role: "user", time: { created: 1000 }, semantics: { kind: "user_prompt" } }),
  );

  const insPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, sequence, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insPart.run("p2", "msg_1", "sess_main", 1000, 2, JSON.stringify({ type: "text", text: "world" }));
  insPart.run("p1", "msg_1", "sess_main", 1000, 1, JSON.stringify({ type: "text", text: "hello" }));
  insPart.run("p3", "msg_2", "sess_main", 1050, null, JSON.stringify({ type: "text", text: "done" }));
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readZcodeSession", () => {
  it("reads session metadata", () => {
    const db = openZcodeDb(dbPath);
    try {
      const entry = readZcodeSession(db, "sess_main");
      expect(entry).not.toBeNull();
      expect(entry!.session).toEqual({
        id: "sess_main",
        title: "main title",
        directory: "D:\\work",
        time_created: 1000,
        time_updated: 2000,
      });
    } finally {
      db.close();
    }
  });

  it("orders messages by time and parts by sequence", () => {
    const db = openZcodeDb(dbPath);
    try {
      const entry = readZcodeSession(db, "sess_main")!;
      expect(entry.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
      const firstParts = entry.messages[0]!.parts as Array<Record<string, unknown>>;
      expect(firstParts.map((p) => p["text"])).toEqual(["hello", "world"]);
    } finally {
      db.close();
    }
  });

  it("returns null for unknown session", () => {
    const db = openZcodeDb(dbPath);
    try {
      expect(readZcodeSession(db, "sess_missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("listTopLevelSessionIds", () => {
  it("skips subagent child sessions", () => {
    const db = openZcodeDb(dbPath);
    try {
      expect(listTopLevelSessionIds(db).map((s) => s.id)).toEqual(["sess_main"]);
    } finally {
      db.close();
    }
  });
});

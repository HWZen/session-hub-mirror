import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs, readSessionsFromDb, runBackfill, type BackfillOptions } from "../src/backfill.js";
import { transformSession } from "../src/plugin.js";

let dir: string;
let dbPath: string;

function insertJson(db: Database.Database, table: string, data: unknown): number {
  const info = db.prepare(`INSERT INTO ${table} (data) VALUES (?)`).run(JSON.stringify(data));
  return Number(info.lastInsertRowid);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "session-hub-backfill-"));
  dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT
    );
    CREATE TABLE message (
      id INTEGER PRIMARY KEY, session_id TEXT, data TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE part (
      id INTEGER PRIMARY KEY, message_id INTEGER, session_id TEXT,
      data TEXT, time_created INTEGER, time_updated INTEGER
    );
  `);
  const insSession = db.prepare("INSERT INTO session (id, title, directory, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)");
  insSession.run("ses_old", "old one", "/work/a", 1000, 2000, null);
  insSession.run("ses_new", "new one", "/work/b", 3000, 5000, null);
  insSession.run("ses_child", "child agent", "/work/b", 3100, 5200, "ses_new");

  const m1 = insertJson(db, "message", { role: "user", time: { created: 1100 } });
  db.prepare("UPDATE message SET session_id = ?, time_created = ? WHERE id = ?").run("ses_old", 1100, m1);
  const p11 = insertJson(db, "part", { type: "text", text: "hello", synthetic: true });
  const p12 = insertJson(db, "part", { type: "text", text: "hello real" });
  const p13 = insertJson(db, "part", { type: "tool", state: { status: "done", output: "42" } });
  db.prepare("UPDATE part SET message_id = ?, session_id = ?").run(m1, "ses_old");
  void p11;
  void p13;
  void p12;

  const m2 = insertJson(db, "message", { role: "assistant", time: { created: 1200 } });
  db.prepare("UPDATE message SET session_id = ? WHERE id = ?").run("ses_old", m2);
  const p2 = insertJson(db, "part", { type: "text", text: "answer" });
  void p2;
  db.prepare("UPDATE part SET message_id = ? WHERE id = ?").run(m2, p2);

  const m3 = insertJson(db, "message", { role: "user", time: { created: 3200 } });
  db.prepare("UPDATE message SET session_id = ? WHERE id = ?").run("ses_new", m3);
  const p3 = insertJson(db, "part", { type: "text", text: "why is it slow" });
  db.prepare("UPDATE part SET message_id = ? WHERE id = ?").run(m3, p3);
  const brokenJson = "not{json";
  db.prepare("INSERT INTO message (id, session_id, data) VALUES (1100, 'ses_new', ?)").run(brokenJson);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readSessionsFromDb", () => {
  it("assembles session -> message -> part structures from the fixture db", () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const entries = readSessionsFromDb(db);
      expect(entries).toHaveLength(3);
      const old = entries.find((e) => e.session.id === "ses_old")!;
      expect(old.messages).toHaveLength(2);
      expect(old.messages[0]!.role).toBe("user");
      expect(old.messages[0]!.time_created).toBe(1100);
      expect(old.messages[0]!.parts).toHaveLength(3);
      expect(old.messages[1]!.role).toBe("assistant");

      const payload = transformSession(old.session, old.messages, "M1");
      expect(payload.source_id).toBe("ses_old");
      expect(payload.messages[0]!.text).toBe("hello real");
      expect(payload.messages[0]!.raw).toHaveLength(3);

      const child = entries.find((e) => e.session.id === "ses_child")!;
      expect(child.messages).toHaveLength(0);
      expect(transformSession(child.session, child.messages, "M1").updated_at).toBe(5200);
    } finally {
      db.close();
    }
  });

  it("filters sessions older than since", () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const entries = readSessionsFromDb(db, 5000);
      expect(entries.map((e) => e.session.id)).toEqual(["ses_new", "ses_child"]);
    } finally {
      db.close();
    }
  });
});

async function withFixtureDb(options: { since?: number; dryRun?: boolean }, upload: (payload: unknown) => Promise<{ ok: boolean; status: number }>) {
  const opts: BackfillOptions = {
    url: options.dryRun ? "" : "http://stub",
    token: options.dryRun ? "" : "t",
    db: dbPath,
    ...(options.since === undefined ? {} : { since: options.since }),
    dryRun: options.dryRun ?? false,
  };
  return runBackfill(opts, { upload });
}

describe("runBackfill", () => {
  it("uploads every session and reports counters", async () => {
    const uploaded: unknown[] = [];
    const counters = await withFixtureDb({}, async (payload) => {
      uploaded.push(payload);
      return { ok: true, status: 201 };
    });
    expect(counters).toEqual({ sessions: 3, uploaded: 3, failed: 0, skipped_since: 0 });
    expect(uploaded).toHaveLength(3);
  });

  it("counts failures without throwing", async () => {
    const counters = await withFixtureDb({}, async () => ({ ok: false, status: 500 }));
    expect(counters.uploaded).toBe(0);
    expect(counters.failed).toBe(3);
  });

  it("respects since filter and dry-run", async () => {
    const uploaded: unknown[] = [];
    const dry = await withFixtureDb({ dryRun: true }, async () => {
      throw new Error("must not upload");
    });
    expect(dry.sessions).toBe(3);
    expect(uploaded).toHaveLength(0);
    void uploaded;

    const counters = await withFixtureDb({ since: 5000 }, async () => {
      uploaded.push(1);
      return { ok: true, status: 200 };
    });
    expect(counters).toEqual({ sessions: 3, uploaded: 2, failed: 0, skipped_since: 1 });
    expect(uploaded).toHaveLength(2);
  });
});

describe("parseArgs", () => {
  it("parses space and equals forms", () => {
    const parsed = parseArgs(["--url", "http://x", "--token=t", "--db", "D:\\a.db", "--dry-run", "extra"]);
    expect(parsed).toEqual({
      url: "http://x",
      token: "t",
      db: "D:\\a.db",
      since: undefined,
      dryRun: true,
    });
  });

  it("returns null without url/token", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["--url", "http://x"])).toBeNull();
    expect(parseArgs(["--url", "http://x", "--token", "t", "--since", "bad"])).toBeNull();
  });

  it("registers a trailing valueless flag", () => {
    expect(parseArgs(["--url", "http://x", "--token", "t", "--dry-run"])).toMatchObject({ dryRun: true });
  });
});

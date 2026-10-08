import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHubConfig } from "../src/config.js";
import { parseArgs, runBackfill } from "../src/backfill.js";
import { readLastUploadedAt } from "../src/throttle.js";
import type { TransformedSession } from "../src/transform.js";

const directories: string[] = [];
const CONFIG: SessionHubConfig = { baseUrl: "https://hub.example.test", token: "test-token", timeoutMs: 1000 };

function makeProfile(sessions: Array<{ id: string; archived: number }>): string {
  const profileHome = mkdtempSync(join(tmpdir(), "session-hub-hermes-backfill-"));
  directories.push(profileHome);
  const db = new Database(join(profileHome, "state.db"));
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
  for (const [index, session] of sessions.entries()) {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      session.id, session.id, null, null, 1_700_000_000 + index, 1_700_000_010 + index, session.archived,
    );
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      `m-${session.id}`, session.id, "user", `content-${session.id}`, null, null, null,
    );
  }
  db.close();
  return profileHome;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("backfill", () => {
  it("defaults to all four profiles and accepts a targeted profile/session", () => {
    expect(parseArgs([], "C:/profiles")?.profileHomes).toEqual([
      "C:/profiles/default",
      "C:/profiles/dev",
      "C:/profiles/qa",
      "C:/profiles/operations",
    ]);
    expect(parseArgs(["--profile", "C:/profiles/dev", "--session", "s1"])).toEqual({
      profileHomes: [resolve("C:/profiles/dev")],
      sessionId: "s1",
    });
    expect(parseArgs(["--profile"])).toBeNull();
  });

  it("uploads all non-archived sessions sequentially and marks successful ones", async () => {
    const profileHome = makeProfile([
      { id: "s1", archived: 0 },
      { id: "s2", archived: 1 },
      { id: "s3", archived: 0 },
    ]);
    const uploaded: TransformedSession[] = [];
    const counters = await runBackfill(
      { profileHomes: [profileHome] },
      {
        config: CONFIG,
        now: () => 2_000_000,
        upload: async (_config, payload) => {
          uploaded.push(payload);
          return { ok: true, status: 201 };
        },
      },
    );
    expect(counters).toEqual({ profiles: 1, sessions: 2, uploaded: 2, failed: 0 });
    expect(uploaded.map((payload) => payload.source_id)).toEqual(["s1", "s3"]);
    expect(readLastUploadedAt(profileHome, "s1")).toBe(2_000_000);
  });

  it("counts an unmatched requested session as a failure", async () => {
    const profileHome = makeProfile([{ id: "s1", archived: 0 }]);
    const counters = await runBackfill(
      { profileHomes: [profileHome], sessionId: "missing" },
      { config: CONFIG, upload: async () => ({ ok: true, status: 200 }) },
    );
    expect(counters).toEqual({ profiles: 1, sessions: 0, uploaded: 0, failed: 1 });
  });
});

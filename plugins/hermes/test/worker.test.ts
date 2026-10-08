import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHubConfig } from "../src/config.js";
import { readLastUploadedAt } from "../src/throttle.js";
import { syncSession } from "../src/worker.js";
import type { TransformedSession } from "../src/transform.js";

const directories: string[] = [];
const CONFIG: SessionHubConfig = { baseUrl: "https://hub.example.test", token: "test-token", timeoutMs: 1000 };

function makeProfile(): string {
  const profileHome = mkdtempSync(join(tmpdir(), "session-hub-hermes-worker-"));
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
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "s1", "title", "D:/work", null, 1_700_000_000, 1_700_000_010, 0,
  );
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "m1", "s1", "user", "hello", null, null, null,
  );
  db.close();
  return profileHome;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("syncSession", () => {
  it("reads the profile database and records a throttle marker only after success", async () => {
    const profileHome = makeProfile();
    let uploaded: TransformedSession | null = null;
    const outcome = await syncSession("s1", profileHome, {
      config: CONFIG,
      now: () => 1_800_000,
      upload: async (_config, payload) => {
        uploaded = payload;
        return { ok: true, status: 200 };
      },
    });
    expect(outcome).toEqual({ ok: true, detail: "status=200", messages: 1 });
    expect(uploaded).toMatchObject({
      agent: "hermes",
      source_id: "s1",
      cwd: "D:/work",
      messages: [{ role: "user", text: "hello" }],
    });
    expect(readLastUploadedAt(profileHome, "s1")).toBe(1_800_000);
  });

  it("does not update the marker when the server rejects the upsert", async () => {
    const profileHome = makeProfile();
    const outcome = await syncSession("s1", profileHome, {
      config: CONFIG,
      upload: async () => ({ ok: false, status: 503 }),
    });
    expect(outcome.ok).toBe(false);
    expect(readLastUploadedAt(profileHome, "s1")).toBeNull();
  });

  it("reports a session that is absent from the source database", async () => {
    const profileHome = makeProfile();
    const outcome = await syncSession("missing", profileHome, {
      config: CONFIG,
      upload: async () => ({ ok: true, status: 200 }),
    });
    expect(outcome).toEqual({ ok: false, detail: "session not found", messages: 0 });
  });
});

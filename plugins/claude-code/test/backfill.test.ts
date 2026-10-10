import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillSessions } from "../src/backfill.js";
import type { SessionUpsertPayload } from "../src/transform.js";
import type { SessionHubConfig, UploadResult } from "../src/config.js";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

const config: SessionHubConfig = { baseUrl: "http://127.0.0.1:1", token: "t", timeoutMs: 1000 };

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sh-cc-bf-"));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(relative: string, lines: unknown[]): void {
  const dir = tempDirs[tempDirs.length - 1]!;
  const fullPath = join(dir, relative);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function userEntry(text: string, timestamp: string): unknown {
  return { type: "user", uuid: `u-${text}`, sessionId: text, cwd: "C:\\repo", timestamp, message: { role: "user", content: text } };
}

function okUpload(): {
  upload: (config: SessionHubConfig, payload: SessionUpsertPayload) => Promise<UploadResult>;
  payloads: SessionUpsertPayload[];
} {
  const payloads: SessionUpsertPayload[] = [];
  const upload = vi.fn(async (_config: SessionHubConfig, payload: SessionUpsertPayload): Promise<UploadResult> => {
    payloads.push(payload);
    return { ok: true, status: 200, body: null };
  });
  return { upload, payloads };
}

describe("backfillSessions", () => {
  it("scans project dirs, uploads sessions, skips subagents and non-jsonl files", async () => {
    fixtureDir();
    writeJsonl("projA/sess-1.jsonl", [
      userEntry("hello world", "2026-10-09T06:00:00.000Z"),
    ]);
    writeJsonl("projB/sess-2.jsonl", [
      userEntry("second session", "2026-10-09T07:00:00.000Z"),
    ]);
    writeJsonl("projA/sess-1/subagents/agent-1.jsonl", [
      userEntry("sidechain", "2026-10-09T06:30:00.000Z"),
    ]);
    writeJsonl("projA/notes.txt", [{ not: "jsonl" }]);
    writeJsonl("projA/empty.jsonl", []);

    const { upload, payloads } = okUpload();
    const result = await backfillSessions({ dryRun: false }, { config, upload, projectsDir: tempDirs[0]! });

    expect(payloads.map((p) => p.source_id).sort()).toEqual(["hello world", "second session"]);
    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("dry-run uploads nothing", async () => {
    fixtureDir();
    writeJsonl("projA/sess-1.jsonl", [userEntry("hello", "2026-10-09T06:00:00.000Z")]);
    const { upload, payloads } = okUpload();
    const result = await backfillSessions({ dryRun: true }, { config, upload, projectsDir: tempDirs[0]! });
    expect(payloads).toHaveLength(0);
    expect(result.processed).toBe(1);
  });

  it("filters by --since on first entry timestamp", async () => {
    fixtureDir();
    writeJsonl("projA/old.jsonl", [userEntry("old", "2026-10-01T00:00:00.000Z")]);
    writeJsonl("projA/new.jsonl", [userEntry("new", "2026-10-09T00:00:00.000Z")]);
    const { upload, payloads } = okUpload();
    const result = await backfillSessions(
      { dryRun: false, since: Date.parse("2026-10-05T00:00:00.000Z") },
      { config, upload, projectsDir: tempDirs[0]! },
    );
    expect(payloads.map((p) => p.source_id)).toEqual(["new"]);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("does nothing when unconfigured", async () => {
    fixtureDir();
    writeJsonl("projA/sess-1.jsonl", [userEntry("hello", "2026-10-09T06:00:00.000Z")]);
    const { upload, payloads } = okUpload();
    const result = await backfillSessions({ dryRun: false }, { config: null, upload, projectsDir: tempDirs[0]! });
    expect(payloads).toHaveLength(0);
    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });
  });

  it("counts failed uploads", async () => {
    fixtureDir();
    writeJsonl("projA/sess-1.jsonl", [userEntry("hello", "2026-10-09T06:00:00.000Z")]);
    const upload = vi.fn(async (): Promise<UploadResult> => ({ ok: false, status: 500, body: null }));
    const result = await backfillSessions({ dryRun: false }, { config, upload, projectsDir: tempDirs[0]! });
    expect(result).toMatchObject({ processed: 0, failed: 1 });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkbuddyTranscripts, runBackfill, type BackfillDeps } from "../src/workbuddy/backfill.js";
import type { SessionUpsertInput } from "@session-hub/shared";
import type { UploadResult } from "../src/workbuddy/upload.js";

const transcript = [
  JSON.stringify({ timestamp: "2026-08-01T10:00:00.000Z", message: { role: "user", content: "<user_query>backfill me</user_query>" } }),
  JSON.stringify({ timestamp: "2026-08-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
].join("\n");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wb-backfill-"));
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(root, "proj-b"), { recursive: true });
  writeFileSync(join(root, "proj-a", "ses-1.jsonl"), transcript);
  writeFileSync(join(root, "proj-a", "notes.txt"), "not a transcript");
  writeFileSync(join(root, "proj-b", "ses-2.jsonl"), transcript);
  writeFileSync(join(root, "proj-b", "ses-3.jsonl"), transcript);
  writeFileSync(join(root, "proj-b", "ses-empty.jsonl"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDeps(failFor?: string): BackfillDeps & { uploaded: SessionUpsertInput[] } {
  const uploaded: SessionUpsertInput[] = [];
  return {
    uploaded,
    config: { baseUrl: "http://hub.local", token: "tok", timeoutMs: 2000 },
    machine: "M1",
    projectsDir: root,
    listTranscripts: (dir) => listWorkbuddyTranscripts(dir),
    readTranscript: (p) => readFileSync(p, "utf8"),
    upload: async (_config, payload) => {
      if (failFor !== undefined && payload.source_id === failFor) {
        throw new Error("boom");
      }
      uploaded.push(payload);
      const result: UploadResult = { ok: true, status: 201, body: { id: payload.source_id } };
      return result;
    },
  };
}

describe("runBackfill", () => {
  it("walks project dirs, uploads transcripts and skips empty files", async () => {
    const deps = makeDeps();
    const stats = await runBackfill(deps);
    expect(stats.total).toBe(4);
    expect(stats.uploaded).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.failed).toBe(0);
    const ids = deps.uploaded.map((p) => p.source_id).sort();
    expect(ids).toEqual(["ses-1", "ses-2", "ses-3"]);
    expect(deps.uploaded[0]).toMatchObject({ agent: "workbuddy", machine: "M1" });
    expect(deps.uploaded[0]!.messages[0]).toMatchObject({ role: "user", text: "backfill me" });
  });

  it("continues after upload failure and reports the failed session", async () => {
    const deps = makeDeps("ses-2");
    const stats = await runBackfill(deps);
    expect(stats.uploaded).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.failures[0]).toContain("ses-2");
    expect(deps.uploaded.map((p) => p.source_id).sort()).toEqual(["ses-1", "ses-3"]);
  });

  it("reports zero totals on missing projects dir", async () => {
    const deps = makeDeps();
    deps.projectsDir = join(root, "does-not-exist");
    const stats = await runBackfill(deps);
    expect(stats.total).toBe(0);
    expect(stats.uploaded).toBe(0);
    expect(stats.failed).toBe(0);
  });
});

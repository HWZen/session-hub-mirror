import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOptions, runBackfill } from "../src/backfill.js";
import type { TransformedSession } from "../src/transform.js";

const tempDirs: string[] = [];
const fixturePath = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/(.:)/, "$1");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createCodexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  tempDirs.push(home);
  const day = join(home, "sessions", "2026", "09", "18");
  mkdirSync(day, { recursive: true });
  copyFileSync(fixturePath("desktop-rollout.jsonl"), join(day, "rollout-desktop.jsonl"));
  copyFileSync(fixturePath("cli-rollout.jsonl"), join(day, "rollout-cli.jsonl"));
  writeFileSync(
    join(day, "rollout-subagent.jsonl"),
    '{"timestamp":"2026-09-18T03:00:00Z","type":"session_meta","payload":{"id":"44444444-4444-4444-8444-444444444444","timestamp":"2026-09-18T03:00:00Z","source":{"subagent":{"other":"review"}}}}\n',
  );
  writeFileSync(
    join(home, "session_index.jsonl"),
    '{"id":"11111111-1111-4111-8111-111111111111","thread_name":"Desktop title","updated_at":"2026-09-18T04:00:00Z"}\n',
  );
  return home;
}

describe("resolveOptions", () => {
  it("allows dry-run without server credentials", () => {
    expect(resolveOptions(["--codex-home", "X", "--dry-run"], {}, "missing.json")).toEqual({
      codexHome: "X",
      dryRun: true,
    });
  });

  it("requires credentials for upload mode", () => {
    expect(resolveOptions([], {}, "missing.json")).toBeNull();
    expect(resolveOptions(["--since", "not-a-date", "--dry-run"], {}, "missing.json")).toBeNull();
  });
});

describe("runBackfill", () => {
  it("scans, deduplicates and skips subagent rollouts in dry-run", async () => {
    const codexHome = createCodexHome();
    expect(await runBackfill({ codexHome, dryRun: true })).toEqual({
      files: 3,
      sessions: 2,
      uploaded: 0,
      failed: 0,
      skipped_since: 0,
      skipped_subagents: 1,
      invalid_files: 0,
    });
  });

  it("uploads transformed snapshots with indexed titles", async () => {
    const codexHome = createCodexHome();
    const payloads: TransformedSession[] = [];
    const counters = await runBackfill(
      { codexHome, dryRun: false, url: "http://hub.test", token: "token" },
      { upload: async (payload) => {
        payloads.push(payload);
        return { ok: true, status: 201 };
      } },
    );
    expect(counters.uploaded).toBe(2);
    expect(payloads.find((payload) => payload.source_id.startsWith("1111"))?.title).toBe("Desktop title");
    expect(readFileSync(join(codexHome, "session_index.jsonl"), "utf8")).toContain("Desktop title");
  });
});

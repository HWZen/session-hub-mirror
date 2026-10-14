import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRolloutText, readTitleIndex, toTimestampMs } from "../src/parse.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parseRolloutText", () => {
  it("parses desktop item_completed events and tolerates a damaged tail", () => {
    const parsed = parseRolloutText(fixture("desktop-rollout.jsonl"), "rollout-desktop.jsonl")!;
    expect(parsed.sourceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.cwd).toBe("D:\\workspace\\demo");
    expect(parsed.eventItems.map((entry) => entry.item["type"])).toEqual([
      "UserMessage",
      "Reasoning",
      "CommandExecution",
      "Extension",
      "AgentMessage",
      "FileChange",
      "AgentMessage",
    ]);
    expect(parsed.stats).toMatchObject({ invalidLines: 1, unknownEvents: 0, usedLegacyFallback: false });
    expect(parsed.isSubagent).toBe(false);
  });

  it("selects response_item fallback and tracks encrypted-only reasoning", () => {
    const parsed = parseRolloutText(fixture("cli-legacy-rollout.jsonl"), "rollout-cli.jsonl")!;
    expect(parsed.stats.usedLegacyFallback).toBe(true);
    expect(parsed.stats.skippedEncryptedReasoning).toBe(1);
    expect(parsed.legacyItems).toHaveLength(7);
  });

  it("parses the current Codex CLI exec item stream", () => {
    const parsed = parseRolloutText(fixture("cli-rollout.jsonl"), "rollout-cli.jsonl")!;
    expect(parsed.sourceId).toBe("55555555-5555-4555-8555-555555555555");
    expect(parsed.stats.usedLegacyFallback).toBe(false);
    expect(parsed.eventItems.map((entry) => entry.item["type"])).toEqual(["UserMessage", "AgentMessage"]);
  });

  it("falls back to the UUID in the filename", () => {
    const parsed = parseRolloutText(
      '{"timestamp":"2026-01-01T00:00:00Z","type":"world_state","payload":{}}',
      "rollout-2026-01-01T00-00-00-33333333-3333-4333-8333-333333333333.jsonl",
    )!;
    expect(parsed.sourceId).toBe("33333333-3333-4333-8333-333333333333");
  });
});

describe("readTitleIndex", () => {
  it("keeps the newest valid title per session", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-index-"));
    tempDirs.push(directory);
    const path = join(directory, "session_index.jsonl");
    writeFileSync(path, [
      '{"id":"s1","thread_name":"Old","updated_at":"2026-01-01T00:00:00Z"}',
      "bad",
      '{"id":"s1","thread_name":"New","updated_at":"2026-01-02T00:00:00Z"}',
    ].join("\n"));
    expect(readTitleIndex(path).get("s1")?.title).toBe("New");
  });
});

it("normalizes seconds, milliseconds and ISO timestamps", () => {
  expect(toTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
  expect(toTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  expect(toTimestampMs("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
});

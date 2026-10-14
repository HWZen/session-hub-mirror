import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractHookPayload, waitForStableRollout } from "../src/worker.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("worker", () => {
  it("validates Stop hook payloads", () => {
    expect(extractHookPayload({
      session_id: "s1",
      transcript_path: "rollout.jsonl",
      cwd: "D:/repo",
      turn_id: "turn-1",
    })).toEqual({ sessionId: "s1", transcriptPath: "rollout.jsonl", cwd: "D:/repo", turnId: "turn-1" });
    expect(extractHookPayload({ session_id: "s1" })).toBeNull();
  });

  it("reads a stable rollout containing the requested turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-worker-"));
    tempDirs.push(directory);
    const path = join(directory, "rollout.jsonl");
    const source = new URL("./fixtures/desktop-rollout.jsonl", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
    copyFileSync(source, path);
    const parsed = await waitForStableRollout(path, "turn-1", 100, 10);
    expect(parsed?.sourceId).toBe("11111111-1111-4111-8111-111111111111");
  });
});

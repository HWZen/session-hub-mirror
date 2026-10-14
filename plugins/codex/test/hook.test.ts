import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forwardToWorker, queueDirectory } from "../src/hook.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hook queue", () => {
  it("uses PLUGIN_DATA and starts a detached worker with metadata only", () => {
    const pluginData = mkdtempSync(join(tmpdir(), "codex-plugin-data-"));
    tempDirs.push(pluginData);
    let payloadPath = "";
    const spawnFn = ((command: string, args: readonly string[]) => {
      expect(command).toBe(process.execPath);
      payloadPath = args[1] ?? "";
      return { unref() {} };
    }) as unknown as typeof spawn;
    expect(forwardToWorker(
      JSON.stringify({ session_id: "s1", transcript_path: "C:/sessions/rollout.jsonl" }),
      { PLUGIN_DATA: pluginData },
      spawnFn,
    )).toBe(true);
    expect(queueDirectory({ PLUGIN_DATA: pluginData })).toBe(join(pluginData, "queue"));
    expect(existsSync(payloadPath)).toBe(true);
    expect(JSON.parse(readFileSync(payloadPath, "utf8"))).toEqual({
      session_id: "s1",
      transcript_path: "C:/sessions/rollout.jsonl",
    });
  });

  it("ignores malformed input", () => {
    expect(forwardToWorker("not-json", {}, spawn)).toBe(false);
  });
});

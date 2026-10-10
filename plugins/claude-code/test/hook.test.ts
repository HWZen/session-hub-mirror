import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { forwardToWorker } from "../src/hook.js";

interface SpawnCall {
  command: unknown;
  args: string[];
  options: Record<string, unknown>;
  unrefed: boolean;
}

function fakeSpawn(): { spawn: typeof import("node:child_process").spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn((command: unknown, args: unknown, options: unknown) => {
    const call: SpawnCall = {
      command,
      args: args as string[],
      options: options as Record<string, unknown>,
      unrefed: false,
    };
    calls.push(call);
    return { unref: () => { call.unrefed = true; } } as unknown as ChildProcess;
  });
  return { spawn: spawn as unknown as typeof import("node:child_process").spawn, calls };
}

const validPayload = JSON.stringify({
  session_id: "sess-1",
  transcript_path: "C:\\t\\sess-1.jsonl",
  cwd: "C:\\repo",
  hook_event_name: "Stop",
});

function cleanup(calls: SpawnCall[]): void {
  for (const call of calls) {
    const tmp = call.args[1];
    if (tmp && existsSync(tmp)) unlinkSync(tmp);
  }
}

describe("forwardToWorker", () => {
  it("spawns a detached worker with the payload file and unrefs it", () => {
    const fake = fakeSpawn();
    forwardToWorker(validPayload, fake.spawn);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toMatch(/worker\.js$/);
    expect(call.args[1]).toMatch(/session-hub-claude-code-.*\.json$/);
    expect(call.options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(call.unrefed).toBe(true);
    const payload = JSON.parse(readFileSync(call.args[1]!, "utf8"));
    expect(payload.session_id).toBe("sess-1");
    cleanup(fake.calls);
  });

  it("does not spawn on invalid JSON", () => {
    const fake = fakeSpawn();
    forwardToWorker("not json", fake.spawn);
    expect(fake.calls).toHaveLength(0);
  });

  it("does not spawn when session_id or transcript_path is missing", () => {
    const fake = fakeSpawn();
    forwardToWorker(JSON.stringify({ session_id: "s" }), fake.spawn);
    forwardToWorker(JSON.stringify({ transcript_path: "C:\\t" }), fake.spawn);
    forwardToWorker(JSON.stringify({ other: 1 }), fake.spawn);
    forwardToWorker(JSON.stringify({ session_id: 1, transcript_path: "C:\\t" }), fake.spawn);
    expect(fake.calls).toHaveLength(0);
  });
});

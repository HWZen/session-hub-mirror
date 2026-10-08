import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardToWorker, parseHookPayload, profileHomeFromArgs, shouldScheduleUpload } from "../src/hook.js";
import { recordSuccessfulUpload } from "../src/throttle.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-hub-hermes-hook-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Hermes shell hook", () => {
  it("accepts only supported events with a session id", () => {
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "post_api_request", session_id: "s1" }))).toEqual({
      sessionId: "s1",
      event: "post_api_request",
    });
    expect(parseHookPayload("not-json")).toBeNull();
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "post_api_request" }))).toBeNull();
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "pre_tool_call", session_id: "s1" }))).toBeNull();
  });

  it("resolves the explicit profile home and checks the 60-second gate", () => {
    const home = tempDirectory();
    expect(profileHomeFromArgs(["--profile", home])).toBe(home);
    expect(profileHomeFromArgs([])).toBeNull();
    recordSuccessfulUpload(home, "s1", 100_000);
    expect(shouldScheduleUpload({ sessionId: "s1", event: "post_api_request" }, home, 159_999)).toBe(false);
    expect(shouldScheduleUpload({ sessionId: "s1", event: "post_api_request" }, home, 160_000)).toBe(true);
    expect(shouldScheduleUpload({ sessionId: "s1", event: "on_session_end" }, home, 100_001)).toBe(true);
  });

  it("stores only event identity and spawns a detached worker", () => {
    const home = tempDirectory();
    const payload = JSON.stringify({
      hook_event_name: "post_api_request",
      session_id: "s2",
      extra: { assistant_message: "private content must not be copied" },
    });
    const child = { unref: vi.fn() } as unknown as ChildProcess;
    const spawnMock = vi.fn((_command: string, _args: string[], _options: unknown) => child);
    expect(forwardToWorker(payload, home, spawnMock as unknown as typeof spawn, "worker.js")).toBe(true);
    expect(forwardToWorker(payload, home, spawnMock as unknown as typeof spawn, "worker.js")).toBe(false);
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(args[0]).toBe("worker.js");
    expect(args[2]).toBe("--profile");
    expect(args[3]).toBe(home);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    const payloadPath = args[1] as string;
    const savedPayload = readFileSync(payloadPath, "utf8");
    expect(JSON.parse(savedPayload)).toEqual({ session_id: "s2", hook_event_name: "post_api_request" });
    expect(savedPayload).not.toContain("private content");
    unlinkSync(payloadPath);
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

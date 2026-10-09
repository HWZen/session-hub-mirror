import { describe, expect, it } from "vitest";
import { isAbsoluteWorkerCwd, parsePluginConfig } from "../src/config.js";

describe("parsePluginConfig", () => {
  it("normalizes the Session Hub URL and requires explicit machine and worker cwd", () => {
    expect(parsePluginConfig({
      baseUrl: "https://hub.example.test/root/",
      token: "private-token",
      machine: "  DESKTOP-A  ",
      workerCwd: "D:\\session-hub\\plugins\\dsh",
    })).toEqual({
      baseUrl: "https://hub.example.test/root",
      token: "private-token",
      machine: "DESKTOP-A",
      timeoutMs: 15_000,
      workerCwd: "D:\\session-hub\\plugins\\dsh",
      reconcileOnStart: true,
      concurrency: 2,
    });
  });

  it("fails open for missing credentials, invalid schemes, or relative worker cwd", () => {
    expect(parsePluginConfig({})).toBeNull();
    expect(parsePluginConfig({ baseUrl: "ftp://hub.test", token: "x", machine: "m", workerCwd: "D:\\work" })).toBeNull();
    expect(parsePluginConfig({ baseUrl: "http://hub.test", token: "x", machine: "m", workerCwd: "." })).toBeNull();
    expect(parsePluginConfig({ baseUrl: "http://user:pass@hub.test", token: "x", machine: "m", workerCwd: "/tmp" })).toBeNull();
  });

  it("accepts absolute Windows, UNC, and POSIX worker directories", () => {
    expect(isAbsoluteWorkerCwd("C:\\work\\plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("\\\\server\\share\\plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("/opt/session-hub/plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("relative\\plugin")).toBe(false);
  });

  it("rejects unsupported timeout and concurrency values", () => {
    expect(parsePluginConfig({
      baseUrl: "http://hub.test",
      token: "x",
      machine: "m",
      workerCwd: "/tmp",
      concurrency: 5,
    })).toBeNull();
  });
});

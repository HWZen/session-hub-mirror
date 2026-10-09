import { describe, expect, it } from "vitest";
import { isAbsoluteWorkerCwd, normalizeBaseUrl, parseExplicitConfig } from "../src/config.js";

describe("parseExplicitConfig", () => {
  it("keeps explicit values, defaults the tuning fields, and trims whitespace", () => {
    expect(parseExplicitConfig({
      baseUrl: "https://hub.example.test/root/",
      token: "  private-token  ",
      machine: "  DESKTOP-A  ",
      workerCwd: " D:\\session-hub\\plugins\\dsh ",
    })).toEqual({
      ok: true,
      config: {
        baseUrl: "https://hub.example.test/root",
        token: "private-token",
        machine: "DESKTOP-A",
        timeoutMs: 15_000,
        workerCwd: "D:\\session-hub\\plugins\\dsh",
        reconcileOnStart: true,
        concurrency: 2,
      },
    });
  });

  it("accepts an empty or absent Config so every field can come from the shared config", () => {
    const expected = {
      ok: true,
      config: {
        baseUrl: undefined,
        token: undefined,
        machine: undefined,
        timeoutMs: 15_000,
        workerCwd: undefined,
        reconcileOnStart: true,
        concurrency: 2,
      },
    };
    expect(parseExplicitConfig({})).toEqual(expected);
    expect(parseExplicitConfig(undefined)).toEqual(expected);
  });

  it("treats blank strings as absent instead of invalid", () => {
    expect(parseExplicitConfig({ baseUrl: "   ", token: " ", machine: "", workerCwd: "  " })).toEqual({
      ok: true,
      config: {
        baseUrl: undefined,
        token: undefined,
        machine: undefined,
        timeoutMs: 15_000,
        workerCwd: undefined,
        reconcileOnStart: true,
        concurrency: 2,
      },
    });
  });

  it("carries tuning overrides and an explicit worker cwd", () => {
    expect(parseExplicitConfig({
      timeoutMs: 2_000,
      reconcileOnStart: false,
      concurrency: 4,
      workerCwd: "/opt/session-hub",
    })).toEqual({
      ok: true,
      config: {
        baseUrl: undefined,
        token: undefined,
        machine: undefined,
        timeoutMs: 2_000,
        workerCwd: "/opt/session-hub",
        reconcileOnStart: false,
        concurrency: 4,
      },
    });
  });

  it("rejects an explicit base URL, worker cwd, or tuning value that cannot be honored", () => {
    const invalid = { ok: false, category: "configuration_invalid" };
    expect(parseExplicitConfig({ baseUrl: "ftp://hub.test" })).toEqual(invalid);
    expect(parseExplicitConfig({ baseUrl: "http://user:pass@hub.test" })).toEqual(invalid);
    expect(parseExplicitConfig({ workerCwd: "." })).toEqual(invalid);
    expect(parseExplicitConfig({ workerCwd: "relative\\plugin" })).toEqual(invalid);
    expect(parseExplicitConfig({ concurrency: 5 })).toEqual(invalid);
    expect(parseExplicitConfig({ concurrency: 0 })).toEqual(invalid);
    expect(parseExplicitConfig({ timeoutMs: 0 })).toEqual(invalid);
    expect(parseExplicitConfig({ token: 42 })).toEqual(invalid);
    expect(parseExplicitConfig("not-a-config")).toEqual(invalid);
  });

  it("accepts absolute Windows, UNC, and POSIX worker directories", () => {
    expect(isAbsoluteWorkerCwd("C:\\work\\plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("\\\\server\\share\\plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("/opt/session-hub/plugin")).toBe(true);
    expect(isAbsoluteWorkerCwd("relative\\plugin")).toBe(false);
  });

  it("normalizes Session Hub URLs and rejects credentials or non-http schemes", () => {
    expect(normalizeBaseUrl(" https://hub.example.test:5202/root/ ")).toBe("https://hub.example.test:5202/root");
    expect(normalizeBaseUrl("http://[::1]:7428")).toBe("http://[::1]:7428");
    expect(normalizeBaseUrl("ftp://hub.test")).toBeNull();
    expect(normalizeBaseUrl("http://hub.test:70000")).toBeNull();
    expect(normalizeBaseUrl("http://user:pass@hub.test")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });
});

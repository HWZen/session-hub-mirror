import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function writeConfig(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sh-cc-cfg-"));
  tempDirs.push(dir);
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

describe("loadConfig", () => {
  it("reads baseUrl and token from env", () => {
    const config = loadConfig(
      { SESSION_HUB_URL: "http://127.0.0.1:7428", SESSION_HUB_TOKEN: "tok-env" },
      writeConfig({ baseUrl: "http://from-file", token: "tok-file" }),
    );
    expect(config).toEqual({ baseUrl: "http://127.0.0.1:7428", token: "tok-env", timeoutMs: 15_000 });
  });

  it("reads from config file when env is unset", () => {
    const config = loadConfig({}, writeConfig({ baseUrl: "http://127.0.0.1:7428/", token: "tok-file" }));
    expect(config).toEqual({ baseUrl: "http://127.0.0.1:7428", token: "tok-file", timeoutMs: 15_000 });
  });

  it("env overrides file per field", () => {
    const config = loadConfig(
      { SESSION_HUB_TOKEN: "tok-env" },
      writeConfig({ baseUrl: "http://127.0.0.1:7428", token: "tok-file" }),
    );
    expect(config).toEqual({ baseUrl: "http://127.0.0.1:7428", token: "tok-env", timeoutMs: 15_000 });
  });

  it("applies timeoutMs from file even when env provides credentials", () => {
    const config = loadConfig(
      { SESSION_HUB_URL: "http://127.0.0.1:7428", SESSION_HUB_TOKEN: "tok-env" },
      writeConfig({ timeoutMs: 5000 }),
    );
    expect(config?.timeoutMs).toBe(5000);
  });

  it("returns null when nothing is configured", () => {
    expect(loadConfig({}, join(tmpdir(), "sh-cc-does-not-exist.json"))).toBeNull();
  });

  it("returns null when baseUrl is missing or invalid", () => {
    expect(loadConfig({ SESSION_HUB_TOKEN: "t" }, writeConfig({}))).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "not a url", SESSION_HUB_TOKEN: "t" }, writeConfig({}))).toBeNull();
  });

  it("returns null when token is empty", () => {
    expect(loadConfig({ SESSION_HUB_URL: "http://x", SESSION_HUB_TOKEN: "" }, writeConfig({}))).toBeNull();
  });
});

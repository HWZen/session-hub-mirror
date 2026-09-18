import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("prefers environment variables and normalizes the URL", () => {
    expect(loadConfig({ SESSION_HUB_URL: "http://hub:7428/", SESSION_HUB_TOKEN: "secret" })).toEqual({
      baseUrl: "http://hub:7428",
      token: "secret",
      timeoutMs: 15_000,
    });
  });

  it("reads the shared config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-config-"));
    tempDirs.push(directory);
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "http://localhost:5328", token: "file-token", timeoutMs: 99 }));
    expect(loadConfig({}, path)).toEqual({ baseUrl: "http://localhost:5328", token: "file-token", timeoutMs: 99 });
  });

  it("returns null for incomplete or invalid configuration", () => {
    expect(loadConfig({}, "missing.json")).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "bad", SESSION_HUB_TOKEN: "x" }, "missing.json")).toBeNull();
  });
});

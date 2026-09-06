import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const tmpDirs: string[] = [];

function tempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sh-zcode-config-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("prefers env over config file", () => {
    const path = tempConfig({ baseUrl: "https://file.example.com", token: "file-token" });
    const config = loadConfig(
      { SESSION_HUB_URL: "https://env.example.com", SESSION_HUB_TOKEN: "env-token" },
      path,
    );
    expect(config).toEqual({ baseUrl: "https://env.example.com", token: "env-token", timeoutMs: 15000 });
  });

  it("falls back to config file and respects timeoutMs", () => {
    const path = tempConfig({ baseUrl: "https://file.example.com/", token: "file-token", timeoutMs: 999 });
    const config = loadConfig({}, path);
    expect(config).toEqual({ baseUrl: "https://file.example.com", token: "file-token", timeoutMs: 999 });
  });

  it("returns null when neither env nor file provides values", () => {
    expect(loadConfig({}, join(tmpdir(), "definitely-missing.json"))).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "https://x.example.com" }, join(tmpdir(), "missing.json"))).toBeNull();
  });

  it("rejects invalid baseUrl", () => {
    const path = tempConfig({ baseUrl: ":://bad", token: "t" });
    expect(loadConfig({}, path)).toBeNull();
  });
});

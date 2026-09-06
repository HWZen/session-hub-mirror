import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveOptions } from "../src/backfill.js";

describe("parseArgs", () => {
  it("parses url/token", () => {
    const raw = parseArgs(["--url", "https://hub.example.com", "--token", "tok"]);
    expect(raw).toEqual({ url: "https://hub.example.com", token: "tok", dryRun: false });
  });

  it("parses --key=value form, db, since and dry-run", () => {
    const raw = parseArgs([
      "--url=https://hub.example.com",
      "--token=tok",
      "--db=D:\\x\\db.sqlite",
      "--since=123",
      "--dry-run",
    ]);
    expect(raw).toEqual({
      url: "https://hub.example.com",
      token: "tok",
      db: "D:\\x\\db.sqlite",
      since: 123,
      dryRun: true,
    });
  });

  it("returns null on bad since and tolerates missing url/token", () => {
    expect(parseArgs(["--since", "abc"])).toBeNull();
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseArgs([])).toEqual({ dryRun: false });
  });
});

describe("resolveOptions", () => {
  it("merges args, env and defaults", () => {
    const options = resolveOptions(
      ["--url=https://hub.example.com", "--dry-run"],
      { SESSION_HUB_TOKEN: "env-token" },
      join(tmpdir(), "definitely-missing.json"),
    );
    expect(options).toMatchObject({
      url: "https://hub.example.com",
      token: "env-token",
      db: expect.stringContaining(join(".zcode", "cli", "db", "db.sqlite")),
      dryRun: true,
    });
  });

  it("falls back to config file when args provide neither url nor token", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-zcode-backfill-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ baseUrl: "https://file.example.com", token: "file-token" }));
      const options = resolveOptions([], {}, configPath);
      expect(options).toMatchObject({ url: "https://file.example.com", token: "file-token", dryRun: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no source provides url/token", () => {
    expect(resolveOptions([], {}, join(tmpdir(), "definitely-missing.json"))).toBeNull();
  });
});

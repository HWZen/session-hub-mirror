import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/backfill.js";

describe("parseArgs", () => {
  it("parses url/token and defaults", () => {
    const options = parseArgs(["--url", "https://hub.example.com", "--token", "tok"]);
    expect(options).toEqual({
      url: "https://hub.example.com",
      token: "tok",
      db: expect.stringContaining(join(".zcode", "cli", "db", "db.sqlite")),
      dryRun: false,
    });
  });

  it("parses --key=value form, db, since and dry-run", () => {
    const options = parseArgs([
      "--url=https://hub.example.com",
      "--token=tok",
      "--db=D:\\x\\db.sqlite",
      "--since=123",
      "--dry-run",
    ]);
    expect(options).toMatchObject({
      url: "https://hub.example.com",
      token: "tok",
      db: "D:\\x\\db.sqlite",
      since: 123,
      dryRun: true,
    });
  });

  it("returns null without url/token and rejects bad since", () => {
    expect(parseArgs(["--url", "https://x"])).toBeNull();
    expect(parseArgs(["--token", "t"])).toBeNull();
    expect(parseArgs(["--url", "https://x", "--token", "t", "--since", "abc"])).toBeNull();
  });
});

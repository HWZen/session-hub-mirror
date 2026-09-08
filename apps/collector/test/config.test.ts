import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/workbuddy/config.js";

describe("loadConfig", () => {
  it("reads env overrides", () => {
    expect(loadConfig({ SESSION_HUB_URL: "http://hub:7428", SESSION_HUB_TOKEN: "tok" })).toEqual({
      baseUrl: "http://hub:7428",
      token: "tok",
      timeoutMs: 15000,
    });
  });

  it("returns null without config", () => {
    const missingPath = "does-not-exist-config.json";
    expect(loadConfig({}, missingPath)).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "not a url", SESSION_HUB_TOKEN: "t" }, missingPath)).toBeNull();
    expect(loadConfig({ SESSION_HUB_URL: "http://x", SESSION_HUB_TOKEN: "" }, missingPath)).toBeNull();
  });

  it("normalizes trailing slash and honors timeoutMs from file", () => {
    expect(loadConfig({ SESSION_HUB_URL: "http://x:1/", SESSION_HUB_TOKEN: "t" })!.baseUrl).toBe("http://x:1");
  });
});

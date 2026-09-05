import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, TEST_TOKEN } from "./helpers.js";

describe("static web hosting", () => {
  it("serves index.html and SPA fallback while API 404s stay JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "session-hub-web-"));
    writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="app"></div>');
    const { app } = buildApp(TEST_TOKEN, undefined, dir);

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('id="app"');

    const spa = await app.request("/sessions");
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="app"');

    const apiMissNoAuth = await app.request("/v1/unknown");
    expect(apiMissNoAuth.status).toBe(401);
    const apiMiss = await app.request("/v1/unknown", {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(apiMiss.status).toBe(404);
    expect(await apiMiss.json()).toEqual({ error: "not found" });

    const healthMiss = await app.request("/health/sub");
    expect(healthMiss.status).toBe(404);
  });

  it("without webDist everything falls through to JSON 404", async () => {
    const { app } = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

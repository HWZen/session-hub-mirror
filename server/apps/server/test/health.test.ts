import { describe, expect, it } from "vitest";
import { buildApp } from "./helpers.js";

describe("health", () => {
  it("无需鉴权并暴露版本号", async () => {
    const { app } = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; version: string; db: { journal_mode: string } };
    expect(data.ok).toBe(true);
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.db.journal_mode).toBe("truncate");
  });
});

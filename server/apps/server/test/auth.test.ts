import { describe, expect, it } from "vitest";
import { TEST_TOKEN, buildApp, sessionBody } from "./helpers.js";

describe("bearer auth", () => {
  it("rejects missing or wrong token on /v1/*", async () => {
    const { app } = buildApp();
    const noAuth = await app.request("/v1/sessions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionBody()),
    });
    expect(noAuth.status).toBe(401);
    const wrongToken = await app.request("/v1/sessions", {
      headers: { authorization: "Bearer totally-wrong-token" },
    });
    expect(wrongToken.status).toBe(401);
    const searchNoAuth = await app.request("/v1/search", { method: "POST" });
    expect(searchNoAuth.status).toBe(401);
  });

  it("accepts valid token and keeps /health open", async () => {
    const { app } = buildApp();
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; db: { journal_mode: string }; embedding: { model: string } };
    expect(body.ok).toBe(true);
    expect(body.db.journal_mode).toBe("truncate");
    expect(body.embedding.model).toBe("bge-m3");
    const list = await app.request("/v1/sessions", {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(list.status).toBe(200);
  });
});

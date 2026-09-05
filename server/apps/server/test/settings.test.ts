import { describe, expect, it } from "vitest";
import {
  BadDimEmbedProvider,
  FakeEmbedProvider,
  TEST_TOKEN,
  buildApp,
  makeSettingsDeps,
  putSession,
  sessionBody,
} from "./helpers.js";

function settingsRequest(
  app: ReturnType<typeof buildApp>["app"],
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(`/v1/settings${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("settings providers", () => {
  it("GET 返回空链信息", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    const res = await settingsRequest(app, "GET", "/providers");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      file: string;
      providers: unknown[];
    };
    expect(data.providers).toEqual([]);
  });

  it("PUT 内联密钥后 GET 掩码返回，不泄露完整密钥", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    const put = await settingsRequest(app, "PUT", "/providers", {
      providers: [
        { name: "gpu-a", baseUrl: "http://127.0.0.1:9100/v1", apiKey: "sk-secret-abcdef1234", weight: 100, enabled: true, timeoutMs: 20000 },
      ],
    });
    expect(put.status).toBe(200);
    const res = await settingsRequest(app, "GET", "/providers");
    const text = await res.text();
    expect(text).not.toContain("sk-secret-abcdef1234");
    const data = JSON.parse(text) as {
      providers: Array<{ keySource: string; keyMasked: string | null }>;
    };
    expect(data.providers[0]!.keySource).toBe("inline");
    expect(data.providers[0]!.keyMasked).toBe("****1234");
  });

  it("PUT 留空 apiKey 保留旧密钥，非空则覆盖", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    await settingsRequest(app, "PUT", "/providers", {
      providers: [{ name: "gpu-a", baseUrl: "http://127.0.0.1:9100/v1", apiKey: "sk-old-key-9999", weight: 100, enabled: true }],
    });
    await settingsRequest(app, "PUT", "/providers", {
      providers: [{ name: "gpu-a", baseUrl: "http://127.0.0.1:9100/v1", weight: 100, enabled: true }],
    });
    const kept = JSON.parse(await (await settingsRequest(app, "GET", "/providers")).text()) as {
      providers: Array<{ keyMasked: string | null }>;
    };
    expect(kept.providers[0]!.keyMasked).toBe("****9999");
    await settingsRequest(app, "PUT", "/providers", {
      providers: [{ name: "gpu-a", baseUrl: "http://127.0.0.1:9100/v1", apiKey: "sk-new-key-7777", weight: 100, enabled: true }],
    });
    const rotated = JSON.parse(await (await settingsRequest(app, "GET", "/providers")).text()) as {
      providers: Array<{ keyMasked: string | null }>;
    };
    expect(rotated.providers[0]!.keyMasked).toBe("****7777");
  });

  it("PUT apiKeyEnv 存在于环境时标记 env 来源且不泄露值", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) =>
      makeSettingsDeps(parts, { env: { SH_EMBED_TEST: "sk-env-8888" } }),
    );
    await settingsRequest(app, "PUT", "/providers", {
      providers: [{ name: "cloud", baseUrl: "https://api.example.com/v1", apiKeyEnv: "SH_EMBED_TEST", weight: 50, enabled: true }],
    });
    const text = await (await settingsRequest(app, "GET", "/providers")).text();
    expect(text).not.toContain("sk-env-8888");
    const data = JSON.parse(text) as { providers: Array<{ keySource: string; keyMasked: string | null }> };
    expect(data.providers[0]!.keySource).toBe("env");
    expect(data.providers[0]!.keyMasked).toBeNull();
  });

  it("PUT 重名提供商返回 400", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    const res = await settingsRequest(app, "PUT", "/providers", {
      providers: [
        { name: "dup", baseUrl: "http://127.0.0.1:9100/v1", weight: 100, enabled: true },
        { name: "dup", baseUrl: "http://127.0.0.1:9101/v1", weight: 50, enabled: true },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("PUT 后无需重启即生效（health 反映新链）", async () => {
    const { app } = buildApp(TEST_TOKEN, [new FakeEmbedProvider("fake")], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    await settingsRequest(app, "PUT", "/providers", {
      providers: [{ name: "zeta", baseUrl: "http://127.0.0.1:9100/v1", weight: 200, enabled: true }],
    });
    const health = (await (await app.request("/health")).json()) as {
      embedding: { providers: Array<{ name: string }> };
    };
    expect(health.embedding.providers.map((p) => p.name)).toEqual(["zeta"]);
  });

  it("未保存的非法 body 返回 400", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    const res = await settingsRequest(app, "PUT", "/providers", { providers: [{ name: "x" }] });
    expect(res.status).toBe(400);
  });
});

describe("settings provider test", () => {
  it("探针成功返回维度与延迟", async () => {
    const { app } = buildApp(TEST_TOKEN, [new FakeEmbedProvider("fake")], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    const res = await settingsRequest(app, "POST", "/providers/test", { name: "fake" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; dim: number | null; latencyMs: number | null };
    expect(data.ok).toBe(true);
    expect(data.dim).toBe(1024);
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("维度不符返回失败详情", async () => {
    const { app } = buildApp(TEST_TOKEN, [new BadDimEmbedProvider("bad-dim")], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    const res = await settingsRequest(app, "POST", "/providers/test", { name: "bad-dim" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error: string | null };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("512-dim");
  });

  it("未知提供商返回 404", async () => {
    const { app } = buildApp(TEST_TOKEN, undefined, undefined, (parts) => makeSettingsDeps(parts));
    const res = await settingsRequest(app, "POST", "/providers/test", { name: "ghost" });
    expect(res.status).toBe(404);
  });
});

describe("settings reindex", () => {
  it("为未索引会话补建向量", async () => {
    const { app, db } = buildApp(TEST_TOKEN, [new FakeEmbedProvider("fake")], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    const put = await putSession(app, sessionBody());
    expect(((await put.json()) as { indexed: boolean }).indexed).toBe(true);
    db.prepare("UPDATE sessions SET indexed_at = NULL").run();
    const res = await settingsRequest(app, "POST", "/reindex");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { total: number; indexed: number; failed: number; remaining: number };
    expect(data).toEqual({ total: 1, indexed: 1, failed: 0, remaining: 0 });
  });
});

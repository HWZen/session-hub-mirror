import { describe, expect, it } from "vitest";
import {
  EmbeddingRegistry,
  EmbeddingUnavailableError,
  createRemoteProviders,
  parseOpenAIEmbeddings,
} from "../src/embedding/registry.js";
import { BadDimEmbedProvider, FailingEmbedProvider, FakeEmbedProvider, hashVector } from "./helpers.js";

describe("embedding registry", () => {
  it("fails over from a broken provider to the next one", async () => {
    const failing = new FailingEmbedProvider("first");
    const fake = new FakeEmbedProvider("second");
    const registry = new EmbeddingRegistry([failing, fake]);
    const out = await registry.embed(["hello"]);
    expect(out.provider).toBe("second");
    expect(out.model).toBe("bge-m3");
    expect(out.vectors[0]!.length).toBe(1024);
    expect(failing.calls).toBe(1);
    expect(failing.lastError).toBe("boom");
  });

  it("skips providers in cooldown and retries after it expires", async () => {
    const failing = new FailingEmbedProvider("first");
    const fake = new FakeEmbedProvider("second");
    const registry = new EmbeddingRegistry([failing, fake]);
    await registry.embed(["a"]);
    await registry.embed(["b"]);
    expect(failing.calls).toBe(1);
    failing.cooldownUntil = Date.now() - 1;
    await registry.embed(["c"]);
    expect(failing.calls).toBe(2);
  });

  it("activeModel is the model of the highest-weight provider", () => {
    const bge = new FakeEmbedProvider("low-bge", "bge-m3", 10);
    const qwen = new FakeEmbedProvider("high-qwen", "qwen3-embedding:8b", 100);
    expect(new EmbeddingRegistry([bge, qwen]).activeModel()).toBe("qwen3-embedding:8b");
    expect(new EmbeddingRegistry([qwen, bge]).activeModel()).toBe("qwen3-embedding:8b");
    expect(new EmbeddingRegistry([]).activeModel()).toBeNull();
  });

  it("embed skips providers with a different model and never crosses model spaces", async () => {
    const bge = new FakeEmbedProvider("low-bge", "bge-m3", 10);
    const qwen = new FakeEmbedProvider("high-qwen", "qwen3-embedding:8b", 100, 4096);
    const registry = new EmbeddingRegistry([bge, qwen]);
    const out = await registry.embed(["hello"]);
    expect(out.provider).toBe("high-qwen");
    expect(out.model).toBe("qwen3-embedding:8b");
    expect(out.vectors[0]!.length).toBe(4096);
    expect(bge.calls).toBe(0);
  });

  it("fails over only within the same model space", async () => {
    const failingQwen = new FailingEmbedProvider("qwen-broken", "qwen3-embedding:8b", 100);
    const qwen = new FakeEmbedProvider("qwen-backup", "qwen3-embedding:8b", 90, 4096);
    const bge = new FakeEmbedProvider("bge", "bge-m3", 10);
    const registry = new EmbeddingRegistry([failingQwen, bge, qwen]);
    const out = await registry.embed(["hello"]);
    expect(out.provider).toBe("qwen-backup");
    expect(out.model).toBe("qwen3-embedding:8b");
    expect(bge.calls).toBe(0);
  });

  it("throws when no same-model provider succeeds", async () => {
    const failingQwen = new FailingEmbedProvider("qwen-broken", "qwen3-embedding:8b", 100);
    const bge = new FakeEmbedProvider("bge", "bge-m3", 10);
    const registry = new EmbeddingRegistry([failingQwen, bge]);
    await expect(registry.embed(["x"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(bge.calls).toBe(0);
  });

  it("rejects vectors inconsistent with the established model space and falls through", async () => {
    const bad = new BadDimEmbedProvider("bad");
    const good = new FakeEmbedProvider("good");
    const registry = new EmbeddingRegistry([bad, good]);
    const probe = await registry.testProvider("good");
    expect(probe.ok).toBe(true);
    expect(probe.dim).toBe(1024);
    const out = await registry.embed(["x"]);
    expect(out.provider).toBe("good");
    expect(bad.lastError).toContain("512-dim");
  });

  it("throws EmbeddingUnavailableError when everything fails", async () => {
    const registry = new EmbeddingRegistry([new FailingEmbedProvider("f1"), new FailingEmbedProvider("f2")]);
    await expect(registry.embed(["x"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("deterministic vectors: same text gives zero distance to itself", () => {
    const a = hashVector("same text");
    const b = hashVector("same text");
    let dist = 0;
    for (let i = 0; i < a.length; i++) dist += (a[i]! - b[i]!) ** 2;
    expect(Math.sqrt(dist)).toBeCloseTo(0, 5);
  });

  it("status reports active model and per-provider model", () => {
    const failing = new FailingEmbedProvider("failing-bge", "bge-m3", 100);
    const qwen = new FakeEmbedProvider("qwen", "qwen3-embedding:8b", 500);
    const registry = new EmbeddingRegistry([failing, qwen]);
    const before = registry.status();
    expect(before.model).toBe("qwen3-embedding:8b");
    expect(before.current).toBeNull();
    expect(before.providers.map((p) => p.model)).toEqual(["bge-m3", "qwen3-embedding:8b"]);
    expect(before.providers[0]!.ready).toBe(true);
  });

  it("testProvider returns each provider's own model and dim", async () => {
    const bge = new FakeEmbedProvider("bge", "bge-m3", 10, 1024);
    const qwen = new FakeEmbedProvider("qwen", "qwen3-embedding:8b", 100, 4096);
    const registry = new EmbeddingRegistry([bge, qwen]);
    const bgeResult = await registry.testProvider("bge");
    expect(bgeResult).toMatchObject({ ok: true, model: "bge-m3", dim: 1024 });
    const qwenResult = await registry.testProvider("qwen");
    expect(qwenResult).toMatchObject({ ok: true, model: "qwen3-embedding:8b", dim: 4096 });
  });
});

describe("remote provider config", () => {
  it("orders by weight desc, filters disabled, resolves apiKeyEnv", () => {
    const providers = createRemoteProviders(
      [
        { name: "low", baseUrl: "http://h1/v1", model: "bge-m3", weight: 10, enabled: true },
        { name: "high", baseUrl: "http://h2/v1", model: "qwen3-embedding:8b", apiKeyEnv: "MY_KEY", weight: 90, enabled: true },
        { name: "off", baseUrl: "http://h3/v1", model: "bge-m3", weight: 99, enabled: false },
      ],
      { MY_KEY: "secret-key" },
    );
    expect(providers.map((p) => p.name)).toEqual(["high", "low"]);
    expect(providers[0]!.config.name).toBe("high");
    expect(providers[0]!.model).toBe("qwen3-embedding:8b");
  });

  it("returns [] when nothing enabled", () => {
    const providers = createRemoteProviders(
      [{ name: "off", baseUrl: "http://h/v1", model: "bge-m3", enabled: false }],
      {},
    );
    expect(providers).toHaveLength(0);
  });
});

describe("openai embeddings response parsing", () => {
  it("parses vectors by index", () => {
    const out = parseOpenAIEmbeddings(
      {
        data: [
          { index: 1, embedding: [1, 0, 0] },
          { index: 0, embedding: [0, 1, 0] },
        ],
      },
      2,
    );
    expect(out[0]![0]).toBe(0);
    expect(out[1]![0]).toBe(1);
  });

  it("falls back to order when index missing", () => {
    const out = parseOpenAIEmbeddings({ data: [{ embedding: [5] }, { embedding: [6] }] }, 2);
    expect(out[0]![0]).toBe(5);
    expect(out[1]![0]).toBe(6);
  });

  it("rejects malformed responses", () => {
    expect(() => parseOpenAIEmbeddings({}, 1)).toThrow();
    expect(() => parseOpenAIEmbeddings({ data: [{ embedding: [1] }, { embedding: [2] }] }, 1)).toThrow();
    expect(() => parseOpenAIEmbeddings({ data: [{ embedding: "no" }] }, 1)).toThrow();
    expect(() => parseOpenAIEmbeddings({ data: [{ index: 3, embedding: [1] }] }, 1)).toThrow();
  });
});

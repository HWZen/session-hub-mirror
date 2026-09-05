import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../src/db/connection.js";
import { AutoIndexer } from "../src/auto-index.js";
import {
  FakeEmbedProvider,
  FailingEmbedProvider,
  TEST_TOKEN,
  buildApp,
  makeSettingsDeps,
  postSearch,
  putSession,
  sessionBody,
} from "./helpers.js";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function vectorCount(db: SqliteDatabase, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("auto indexer runOnce", () => {
  it("模型 A 索引后切到模型 B：切换不破坏旧数据，runOnce 一轮后 B 空间可检索、stats 未索引归零", async () => {
    const { app, db, repo, registry, indexer } = buildApp(
      TEST_TOKEN,
      [new FakeEmbedProvider("pa", "model-a", 100, 16)],
      undefined,
      (parts) => makeSettingsDeps(parts),
    );
    const put1 = await putSession(app, sessionBody({ source_id: "s1" }));
    expect(((await put1.json()) as { indexed: boolean }).indexed).toBe(true);
    const put2 = await putSession(
      app,
      sessionBody({
        source_id: "s2",
        title: "second",
        messages: [{ role: "user", text: "cooking pasta tonight", ts: 1 }],
      }),
    );
    expect(((await put2.json()) as { indexed: boolean }).indexed).toBe(true);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(3);

    registry.replaceRemoteProviders([new FakeEmbedProvider("pb", "model-b", 100, 16)]);
    expect(repo.listUnindexed(10, "model-b")).toHaveLength(2);
    expect(vectorCount(db, "message_embeddings_model_a")).toBe(3);

    const auto = new AutoIndexer(repo, indexer, registry, 30_000);
    await expect(auto.runOnce()).resolves.toBe(2);

    const searchB = await postSearch(app, { query: "hello world" });
    const bodyB = (await searchB.json()) as { model: string; results: Array<{ session: { source_id: string } }> };
    expect(bodyB.model).toBe("model-b");
    expect(bodyB.results).toHaveLength(2);
    expect(bodyB.results[0]!.session.source_id).toBe("s1");

    const stats = (await (await app.request("/v1/stats", { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).json()) as {
      indexed: number;
      unindexed: number;
    };
    expect(stats.indexed).toBe(2);
    expect(stats.unindexed).toBe(0);
    expect(vectorCount(db, "message_embeddings_model_b")).toBe(3);
    expect(repo.listUnindexed(10, "model-b")).toHaveLength(0);
  });

  it("无 provider（activeModel null）时 runOnce 不动作不报错", async () => {
    const { app, repo, registry, indexer } = buildApp(TEST_TOKEN, [], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    const put = await putSession(app, sessionBody());
    expect(((await put.json()) as { indexed: boolean }).indexed).toBe(false);
    const auto = new AutoIndexer(repo, indexer, registry, 30_000);
    await expect(auto.runOnce()).resolves.toBe(0);
    expect(repo.listUnindexed(10, null)).toHaveLength(1);
  });

  it("provider 全失败时 runOnce 不抛异常、会话保持未索引，下一轮恢复后消化", async () => {
    const { app, repo, registry, indexer } = buildApp(
      TEST_TOKEN,
      [new FailingEmbedProvider("failing", "bge-m3", 2000)],
      undefined,
      (parts) => makeSettingsDeps(parts),
    );
    const put = await putSession(app, sessionBody());
    expect(((await put.json()) as { indexed: boolean }).indexed).toBe(false);
    const auto = new AutoIndexer(repo, indexer, registry, 30_000);
    await expect(auto.runOnce()).resolves.toBe(0);
    expect(repo.listUnindexed(10, "bge-m3")).toHaveLength(1);

    registry.replaceRemoteProviders([new FakeEmbedProvider("good", "bge-m3", 100)]);
    await expect(auto.runOnce()).resolves.toBe(1);
    expect(repo.listUnindexed(10, "bge-m3")).toHaveLength(0);
    const search = await postSearch(app, { query: "hello world" });
    const body = (await search.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });
});

describe("auto indexer scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kick 在 interval 未到时提前触发下一轮", async () => {
    vi.useFakeTimers();
    const provider = new FakeEmbedProvider("fake");
    const { app, db, repo, registry, indexer } = buildApp(TEST_TOKEN, [provider], undefined, (parts) =>
      makeSettingsDeps(parts),
    );
    const auto = new AutoIndexer(repo, indexer, registry, 60_000);
    auto.start();
    await vi.advanceTimersByTimeAsync(0);
    const put = await putSession(app, sessionBody());
    expect(((await put.json()) as { indexed: boolean }).indexed).toBe(true);
    expect(provider.calls).toBe(1);

    db.prepare("UPDATE sessions SET indexed_at = NULL").run();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(provider.calls).toBe(1);
    expect(repo.listUnindexed(10, "bge-m3")).toHaveLength(1);

    auto.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(2);
    expect(repo.listUnindexed(10, "bge-m3")).toHaveLength(0);

    auto.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(provider.calls).toBe(2);
  });
});

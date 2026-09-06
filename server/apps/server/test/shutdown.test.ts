import { existsSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUpsertInput } from "@session-hub/shared";
import { AutoIndexer } from "../src/auto-index.js";
import type { SqliteDatabase } from "../src/db/connection.js";
import { SessionRepository } from "../src/db/sessions.js";
import { EmbeddingRegistry } from "../src/embedding/registry.js";
import { SessionIndexer } from "../src/indexing.js";
import {
  createShutdownRunner,
  INDEX_GRACE_MS,
  installGracefulShutdown,
  REQUEST_DRAIN_TIMEOUT_MS,
  SHUTDOWN_SIGNALS,
  type ShutdownRunnerDeps,
} from "../src/shutdown.js";
import { FakeEmbedProvider, makeDb, sessionBody } from "./helpers.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeFakeServer(order?: string[]) {
  const closeCallbacks: Array<(err?: Error) => void> = [];
  const mock = {
    close: vi.fn((cb?: (err?: Error) => void) => {
      order?.push("server.close");
      if (cb) closeCallbacks.push(cb);
    }),
    closeIdleConnections: vi.fn(() => order?.push("server.closeIdleConnections")),
    closeAllConnections: vi.fn(),
    getConnections: vi.fn((cb: (err: Error | null, count: number) => void) => cb(null, 0)),
  };
  return {
    mock,
    server: mock as unknown as Server,
    finishClose: () => {
      while (closeCallbacks.length > 0) closeCallbacks.shift()!();
    },
  };
}

function makeFakeIndexer(hold = false) {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const mock = {
    stop: vi.fn(),
    whenIdle: vi.fn(() => (hold ? gate : Promise.resolve())),
  };
  return { mock, indexer: mock as unknown as AutoIndexer, settleIdle: resolve };
}

function makeFakeDb() {
  const close = vi.fn();
  return { close, db: { close } as unknown as SqliteDatabase };
}

describe("shutdown runner（单元，fake 依赖）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按序列执行：stop → closeIdleConnections → close 排水 → whenIdle → db.close → exit(0)", async () => {
    const order: string[] = [];
    const { server, finishClose } = makeFakeServer(order);
    const { mock: indexerMock, indexer } = makeFakeIndexer(false);
    indexerMock.stop.mockImplementation(() => order.push("autoIndexer.stop"));
    indexerMock.whenIdle.mockImplementation(() => {
      order.push("autoIndexer.whenIdle");
      return Promise.resolve();
    });
    const { close: dbClose, db } = makeFakeDb();
    dbClose.mockImplementation(() => order.push("db.close"));
    const exit = vi.fn((code: number) => order.push(`exit(${code})`));

    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p = run("SIGTERM");
    await flushMacrotask();
    expect(order).toEqual(["autoIndexer.stop", "server.closeIdleConnections", "server.close"]);
    finishClose();
    await p;
    expect(order).toEqual([
      "autoIndexer.stop",
      "server.closeIdleConnections",
      "server.close",
      "autoIndexer.whenIdle",
      "db.close",
      "exit(0)",
    ]);
  });

  it("重复调用复用同一 promise，序列只执行一次、exit 只调一次", async () => {
    const { server, finishClose } = makeFakeServer();
    const { mock: indexerMock, indexer } = makeFakeIndexer(false);
    const { close: dbClose, db } = makeFakeDb();
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p1 = run("SIGINT");
    const p2 = run("SIGTERM");
    expect(p2).toBe(p1);
    await flushMacrotask();
    finishClose();
    await p1;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(indexerMock.stop).toHaveBeenCalledTimes(1);
    expect(indexerMock.whenIdle).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("在途请求超过 REQUEST_DRAIN_TIMEOUT_MS：closeAllConnections 强断，仍走完序列 exit(0)", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { mock, server } = makeFakeServer();
    const { indexer } = makeFakeIndexer(false);
    const { db } = makeFakeDb();
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p = run("SIGTERM");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(REQUEST_DRAIN_TIMEOUT_MS);
    await p;
    expect(mock.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("force closed"));
  });

  it("索引 round 超过 INDEX_GRACE_MS：放弃等待，仍 db.close + exit(0)", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, finishClose } = makeFakeServer();
    const { indexer } = makeFakeIndexer(true);
    const { close: dbClose, db } = makeFakeDb();
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p = run("SIGINT");
    await flushMicrotasks();
    finishClose();
    await vi.advanceTimersByTimeAsync(INDEX_GRACE_MS);
    await p;
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("index round exceeded"));
  });

  it("whenIdle 在宽限期内完成：不放弃、正常 exit(0)", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { server, finishClose } = makeFakeServer();
    const { indexer, settleIdle } = makeFakeIndexer(true);
    const { db } = makeFakeDb();
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p = run("SIGINT");
    await flushMicrotasks();
    finishClose();
    await vi.advanceTimersByTimeAsync(INDEX_GRACE_MS - 100);
    settleIdle();
    await p;
    expect(exit).toHaveBeenCalledWith(0);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("index round exceeded"));
  });

  it("db.close 抛错不阻断退出，仍 exit(0)", async () => {
    const { server, finishClose } = makeFakeServer();
    const { indexer } = makeFakeIndexer(false);
    const db = {
      close: vi.fn(() => {
        throw new Error("database is locked");
      }),
    } as unknown as SqliteDatabase;
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    const p = run("SIGTERM");
    await flushMacrotask();
    finishClose();
    await p;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("序列中途意外抛错（server.close 同步抛出）：exit(1)", async () => {
    const { server } = makeFakeServer();
    server.close = (() => {
      throw new Error("close exploded");
    }) as never;
    const { indexer } = makeFakeIndexer(false);
    const { db } = makeFakeDb();
    const exit = vi.fn();
    const run = createShutdownRunner({ server, autoIndexer: indexer, db, exit });
    await expect(run("SIGTERM")).resolves.toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("installGracefulShutdown（信号注册层）", () => {
  it("注册四个信号；第一次信号启动 runner，第二次信号立即 exit(1)", async () => {
    const handlers = new Map<string, () => void>();
    const proc = {
      on: vi.fn((signal: NodeJS.Signals, fn: () => void) => {
        handlers.set(signal, fn);
      }),
    } as unknown as Pick<NodeJS.Process, "on">;
    const { server, finishClose } = makeFakeServer();
    const { mock: indexerMock, indexer } = makeFakeIndexer(false);
    const { db } = makeFakeDb();
    const exit = vi.fn();
    installGracefulShutdown({ server, autoIndexer: indexer, db, exit }, proc);
    expect([...handlers.keys()].sort()).toEqual([...SHUTDOWN_SIGNALS].sort());

    const sigint = handlers.get("SIGINT")!;
    sigint();
    await flushMicrotasks();
    expect(indexerMock.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    sigint();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    finishClose();
  });
});

describe("shutdown runner（进程内集成：真实 http server + 临时 db）", () => {
  async function listen(app: Hono): Promise<{ server: Server; port: number }> {
    let server!: Server;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return { server, port };
  }

  function buildFixture(): { db: SqliteDatabase; repo: SessionRepository; autoIndexer: AutoIndexer } {
    const db = makeDb();
    const repo = new SessionRepository(db);
    const registry = new EmbeddingRegistry([new FakeEmbedProvider("fake")]);
    const indexer = new SessionIndexer(db, repo, registry);
    return { db, repo, autoIndexer: new AutoIndexer(repo, indexer, registry, 60_000) };
  }

  it("无在途请求：端口停止接受连接、db 可重开且数据在、无 -journal 残留、未索引被补完、exit(0)", async () => {
    const { db, repo, autoIndexer } = buildFixture();
    const dbPath = db.name;
    repo.upsert(sessionBody() as unknown as SessionUpsertInput);
    autoIndexer.start();

    const { server, port } = await listen(new Hono().get("/ping", (c) => c.json({ ok: true })));

    const ping = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(ping.status).toBe(200);

    const exit = vi.fn();
    const deps: ShutdownRunnerDeps = { server, autoIndexer, db, exit };
    await createShutdownRunner(deps)("SIGTERM");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    const reopened = new Database(dbPath);
    sqliteVec.load(reopened);
    const count = reopened.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(count.n).toBe(1);
    const vectors = reopened.prepare("SELECT COUNT(*) AS n FROM message_embeddings_bge_m3").get() as { n: number };
    expect(vectors.n).toBe(2);
    reopened.close();
    const journalPath = `${dbPath}-journal`;
    const journalSize = existsSync(journalPath) ? statSync(journalPath).size : 0;
    expect(journalSize).toBe(0);

    await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toThrow();
  });

  it("在途请求：runner 等它完成后才退出，客户端拿到响应，之后新连接被拒", async () => {
    const { db, autoIndexer } = buildFixture();
    let started = false;
    let finished = false;
    const slow = new Hono().get("/slow", async (c) => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      finished = true;
      return c.json({ ok: true });
    });
    const { server, port } = await listen(slow);

    const exit = vi.fn();
    const deps: ShutdownRunnerDeps = { server, autoIndexer, db, exit };
    const run = createShutdownRunner(deps);
    const pending = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => {
      await res.json();
      return res.status;
    });
    while (!started) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const p = run("SIGINT");
    expect(await pending).toBe(200);
    expect(finished).toBe(true);
    await p;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await expect(fetch(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();
  });
});

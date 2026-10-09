import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.js";
import type { DshLiveSession, DshSessionEvent, DshSessionHeader, DshSessionPersistence, DshSessionsService } from "../src/types.js";

const header: DshSessionHeader = { id: "session-1", createdAt: 1_700_000_000_000 };
const session: DshLiveSession = { id: header.id };
const events: DshSessionEvent[] = [
  { type: "user/message", seq: 0, time: 1_700_000_000_100, data: { content: "hello" } },
  { type: "turn/end", seq: 1, time: 1_700_000_000_200, data: {} },
];

function configured(reconcileOnStart = false) {
  return {
    baseUrl: "http://127.0.0.1:7428",
    token: "private-token",
    machine: "machine",
    workerCwd: "D:\\session-hub\\plugins\\dsh",
    timeoutMs: 1_000,
    reconcileOnStart,
    concurrency: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

class ManualTimeouts {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 0;

  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    this.delays.push(delayMs);
    return () => { this.callbacks.delete(id); };
  }

  fireNext(): void {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("no_scheduled_timeout");
    this.callbacks.delete(next[0]);
    next[1]();
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

describe("Cordis Host apply", () => {
  it("waits until the observer returns before flush/read and registers effect cleanup", async () => {
    const order: string[] = [];
    const workerStarted = deferred();
    const flushStarted = deferred();
    let listener: ((session: DshLiveSession, event: DshSessionEvent) => void) | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;
    let removed = false;
    const liveSessions: DshSessionsService = {
      get: () => session,
      flush: async () => {
        order.push("flush");
        flushStarted.resolve();
        return true;
      },
    };
    const persistence: DshSessionPersistence = {
      list: async () => [],
      open: async () => {
        order.push("open");
        return {
          header,
          read: async () => {
            order.push("read");
            return { events };
          },
          close: () => { order.push("close"); },
        };
      },
    };
    const context: Parameters<typeof apply>[0] = {
      sessions: liveSessions,
      sessionPersistence: persistence,
      subprocess: {
        resolveExecutable: async () => {
          order.push("resolveExecutable");
          return "node.exe";
        },
        spawn: () => {
          order.push("spawn");
          workerStarted.resolve();
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text: '{"ok":true,"status":200}', nextOffset: 25, lossy: false }) } },
          };
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: () => () => {},
      on: (_name, callback) => {
        listener = callback;
        return () => {
          removed = true;
          listener = undefined;
        };
      },
      effect: (factory) => {
        cleanup = factory();
        return () => { void cleanup?.(); };
      },
    };

    apply(context, configured());
    const savedListener = listener!;
    savedListener(session, events[1]!);
    expect(order).toEqual([]);

    await flushStarted.promise;
    expect(order).toEqual(["flush"]);
    await workerStarted.promise;
    await cleanup?.();
    expect(order).toEqual(["flush", "open", "read", "close", "resolveExecutable", "spawn"]);
    expect(removed).toBe(true);
    savedListener(session, events[1]!);
    expect(order).toHaveLength(6);
  });

  it("reconciles persisted cold sessions through the same read/upload path without flushing", async () => {
    const order: string[] = [];
    const workerStarted = deferred();
    let cleanup: (() => void | Promise<void>) | undefined;
    const persistence: DshSessionPersistence = {
      list: async () => {
        order.push("list");
        return [{ header }];
      },
      open: async () => {
        order.push("open");
        return {
          header,
          read: async () => {
            order.push("read");
            return { events };
          },
          close: () => { order.push("close"); },
        };
      },
    };
    const context: Parameters<typeof apply>[0] = {
      sessions: { get: () => undefined, flush: async () => { order.push("flush"); return true; } },
      sessionPersistence: persistence,
      subprocess: {
        resolveExecutable: async () => "node.exe",
        spawn: () => {
          order.push("spawn");
          workerStarted.resolve();
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text: '{"ok":true,"status":200}', nextOffset: 25, lossy: false }) } },
          };
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: () => () => {},
      on: () => () => {},
      effect: (factory) => {
        cleanup = factory();
        return () => { void cleanup?.(); };
      },
    };
    apply(context, configured(true));
    await workerStarted.promise;
    await cleanup?.();
    expect(order).toEqual(["list", "open", "read", "close", "spawn"]);
  });

  it("triggers upload on session/title without a turn/end event", async () => {
    const order: string[] = [];
    const workerStarted = deferred();
    const titleEvent: DshSessionEvent = {
      type: "session/title",
      seq: 1,
      time: 1_700_000_000_300,
      data: { title: "Retitled session" },
    };
    const titleEvents = [events[0]!, titleEvent];
    let listener: ((session: DshLiveSession, event: DshSessionEvent) => void) | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;
    const context: Parameters<typeof apply>[0] = {
      sessions: {
        get: () => session,
        flush: async () => { order.push("flush"); return true; },
      },
      sessionPersistence: {
        list: async () => [],
        open: async () => {
          order.push("open");
          return {
            header,
            read: async () => { order.push("read"); return { events: titleEvents }; },
            close: () => { order.push("close"); },
          };
        },
      },
      subprocess: {
        resolveExecutable: async () => { order.push("resolveExecutable"); return "node.exe"; },
        spawn: () => {
          order.push("spawn");
          workerStarted.resolve();
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text: '{"ok":true,"status":200}', nextOffset: 25, lossy: false }) } },
          };
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: () => () => {},
      on: (_name, callback) => { listener = callback; return () => { listener = undefined; }; },
      effect: (factory) => { cleanup = factory(); return () => { void cleanup?.(); }; },
    };

    apply(context, configured());
    listener!(session, titleEvent);
    expect(order).toEqual([]);
    await workerStarted.promise;
    await cleanup?.();

    expect(order).toEqual(["flush", "open", "read", "close", "resolveExecutable", "spawn"]);
  });

  it("retries startup listing after a transient failure and uploads on recovery", async () => {
    const order: string[] = [];
    const timers = new ManualTimeouts();
    const timerScheduled = deferred();
    const firstListFailed = deferred();
    const workerStarted = deferred();
    let listCalls = 0;
    let cleanup: (() => void | Promise<void>) | undefined;
    const persistence: DshSessionPersistence = {
      list: async () => {
        order.push("list");
        listCalls += 1;
        if (listCalls === 1) {
          firstListFailed.resolve();
          throw new Error("private persistence details");
        }
        return [{ header }];
      },
      open: async () => {
        order.push("open");
        return {
          header,
          read: async () => { order.push("read"); return { events }; },
          close: () => { order.push("close"); },
        };
      },
    };
    const context: Parameters<typeof apply>[0] = {
      sessions: { get: () => undefined, flush: async () => { order.push("flush"); return true; } },
      sessionPersistence: persistence,
      subprocess: {
        resolveExecutable: async () => { order.push("resolveExecutable"); return "node.exe"; },
        spawn: () => {
          order.push("spawn");
          workerStarted.resolve();
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text: '{"ok":true,"status":200}', nextOffset: 25, lossy: false }) } },
          };
        },
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: (callback, delayMs) => {
        const cancel = timers.schedule(callback, delayMs);
        timerScheduled.resolve();
        return cancel;
      },
      on: () => () => {},
      effect: (factory) => { cleanup = factory(); return () => { void cleanup?.(); }; },
    };

    apply(context, configured(true));
    await firstListFailed.promise;
    await timerScheduled.promise;
    expect(timers.delays).toEqual([250]);
    expect(timers.pending).toBe(1);

    timers.fireNext();
    await workerStarted.promise;
    await cleanup?.();
    expect(listCalls).toBe(2);
    expect(order).toEqual(["list", "list", "open", "read", "close", "resolveExecutable", "spawn"]);
    expect(timers.pending).toBe(0);
  });

  it("cancels startup retry after cleanup", async () => {
    const timers = new ManualTimeouts();
    const timerScheduled = deferred();
    const listStarted = deferred();
    let listCalls = 0;
    let cleanup: (() => void | Promise<void>) | undefined;
    const context: Parameters<typeof apply>[0] = {
      sessions: { get: () => undefined, flush: async () => true },
      sessionPersistence: {
        list: async () => {
          listCalls += 1;
          listStarted.resolve();
          throw new Error("private persistence details");
        },
        open: async () => { throw new Error("unused"); },
      },
      subprocess: { resolveExecutable: async () => "node.exe", spawn: () => { throw new Error("unused"); } },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: (callback, delayMs) => {
        const cancel = timers.schedule(callback, delayMs);
        timerScheduled.resolve();
        return cancel;
      },
      on: () => () => {},
      effect: (factory) => { cleanup = factory(); return () => { void cleanup?.(); }; },
    };

    apply(context, configured(true));
    await listStarted.promise;
    await timerScheduled.promise;
    await cleanup?.();

    expect(timers.pending).toBe(0);
    expect(listCalls).toBe(1);
  });

  it("registers nothing when required configuration is missing", () => {
    const on = vi.fn(() => () => {});
    const effect = vi.fn(() => () => {});
    const context: Parameters<typeof apply>[0] = {
      sessions: { get: () => undefined, flush: async () => true },
      sessionPersistence: { list: async () => [], open: async () => { throw new Error("unused"); } },
      subprocess: { resolveExecutable: async () => "node", spawn: () => { throw new Error("unused"); } },
      logger: { info: vi.fn(), warn: vi.fn() },
      timeout: () => () => {},
      on,
      effect,
    };
    apply(context, {});
    expect(on).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });
});

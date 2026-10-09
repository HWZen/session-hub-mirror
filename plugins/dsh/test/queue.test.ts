import { describe, expect, it, vi } from "vitest";
import { SessionUploadQueue } from "../src/queue.js";
import { TransformError } from "../src/transform.js";
import { UploadError } from "../src/upload.js";
import type { DshHubSession, DshSessionEvent, DshSessionSnapshot, RetryScheduler, UploadResult } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(id: string, lastSeq: number): DshSessionSnapshot {
  const events: DshSessionEvent[] = Array.from({ length: lastSeq + 1 }, (_, seq) => ({
    type: seq === lastSeq ? "turn/end" : "turn/start",
    seq,
    time: 1_700_000_000_000 + seq,
    data: {},
  }));
  return {
    header: { id, createdAt: 1_700_000_000_000 },
    events,
    lastSeq,
  };
}

function payload(id: string, lastSeq: number): DshHubSession {
  return {
    agent: "dsh",
    machine: "machine",
    source_id: id,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000 + lastSeq,
    messages: [],
  };
}

class ManualScheduler implements RetryScheduler {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 1;

  schedule(delayMs: number, callback: () => void): () => void {
    const id = this.nextId++;
    this.delays.push(delayMs);
    this.callbacks.set(id, callback);
    return () => this.callbacks.delete(id);
  }

  get pending(): number {
    return this.callbacks.size;
  }

  fireNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("no scheduled callback");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

describe("SessionUploadQueue", () => {
  it("single-flights each session and reads the latest payload after a concurrent dirty event", async () => {
    const started = deferred<void>();
    const firstUpload = deferred<UploadResult>();
    const readSeqs: number[] = [];
    const uploads: string[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const scheduler = new ManualScheduler();
    const queue = new SessionUploadQueue({
      concurrency: 2,
      scheduler,
      readSnapshot: async (id, requiredSeq) => {
        readSeqs.push(requiredSeq);
        return snapshot(id, requiredSeq);
      },
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload: async (value) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        uploads.push(value.source_id);
        if (uploads.length === 1) {
          started.resolve();
          const result = await firstUpload.promise;
          inFlight -= 1;
          return result;
        }
        inFlight -= 1;
        return { ok: true, status: 200 };
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    queue.markDirty("session-a", 1);
    queue.kick("session-a");
    await started.promise;
    queue.markDirty("session-a", 2);
    queue.kick("session-a");
    firstUpload.resolve({ ok: true, status: 200 });
    await queue.waitForReadyWork();

    expect(readSeqs).toEqual([1, 2]);
    expect(uploads).toEqual(["session-a", "session-a"]);
    expect(maximumInFlight).toBe(1);
    expect(scheduler.pending).toBe(0);
    await queue.dispose();
  });

  it("limits global reconciliation concurrency", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<UploadResult>>>();
    const startedIds: string[] = [];
    const firstTwoStarted = deferred<void>();
    const thirdStarted = deferred<void>();
    let active = 0;
    let maximum = 0;
    const queue = new SessionUploadQueue({
      concurrency: 2,
      scheduler: new ManualScheduler(),
      readSnapshot: async (id) => snapshot(id, 0),
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload: (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        const gate = deferred<UploadResult>();
        gates.set(value.source_id, gate);
        startedIds.push(value.source_id);
        if (startedIds.length === 2) firstTwoStarted.resolve();
        if (startedIds.length === 3) thirdStarted.resolve();
        return gate.promise.then((result) => {
          active -= 1;
          return result;
        });
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    queue.reconcile(["a", "b", "c"]);
    await firstTwoStarted.promise;
    expect(active).toBe(2);
    gates.get("a")!.resolve({ ok: true, status: 200 });
    await thirdStarted.promise;
    expect(maximum).toBe(2);
    gates.get("b")!.resolve({ ok: true, status: 200 });
    gates.get("c")!.resolve({ ok: true, status: 200 });
    await queue.waitForReadyWork();
    await queue.dispose();
  });

  it("retries retryable failures with timer backoff", async () => {
    const scheduler = new ManualScheduler();
    const upload = vi.fn<() => Promise<UploadResult>>()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 });
    const queue = new SessionUploadQueue({
      concurrency: 1,
      scheduler,
      readSnapshot: async (id) => snapshot(id, 0),
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    queue.markDirty("retry", 0);
    queue.kick("retry");
    await queue.waitForReadyWork();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(scheduler.delays).toEqual([250]);
    expect(scheduler.pending).toBe(1);

    scheduler.fireNext();
    await queue.waitForReadyWork();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(0);
    await queue.dispose();
  });

  it("bounds network retries and parks the dirty session after finite backoff", async () => {
    const scheduler = new ManualScheduler();
    const upload = vi.fn(async () => ({ ok: false, status: 503 }));
    const queue = new SessionUploadQueue({
      concurrency: 1,
      scheduler,
      readSnapshot: async (id) => snapshot(id, 0),
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    queue.markDirty("network-failure", 0);
    queue.kick("network-failure");
    await queue.waitForReadyWork();
    for (let retries = 0; retries < 3; retries += 1) {
      scheduler.fireNext();
      await queue.waitForReadyWork();
    }
    queue.kick("network-failure");
    await queue.waitForReadyWork();

    expect(upload).toHaveBeenCalledTimes(4);
    expect(scheduler.delays).toEqual([250, 1_000, 4_000]);
    expect(scheduler.pending).toBe(0);
    await queue.dispose();
  });

  it("cancels scheduled retries on disposal", async () => {
    const scheduler = new ManualScheduler();
    const queue = new SessionUploadQueue({
      concurrency: 1,
      scheduler,
      readSnapshot: async (id) => snapshot(id, 0),
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload: async () => ({ ok: false, status: 503 }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    queue.markDirty("dispose", 0);
    queue.kick("dispose");
    await queue.waitForReadyWork();
    expect(scheduler.pending).toBe(1);

    await queue.dispose();
    expect(scheduler.pending).toBe(0);
  });

  it("parks oversized payloads without retrying and keeps them dirty for a later trigger", async () => {
    const scheduler = new ManualScheduler();
    const upload = vi.fn(async () => {
      throw new UploadError("payload_too_large", { retryable: false });
    });
    const warn = vi.fn();
    const queue = new SessionUploadQueue({
      concurrency: 1,
      scheduler,
      readSnapshot: async (id) => snapshot(id, 0),
      transform: (value) => payload(value.header.id, value.lastSeq),
      upload,
      logger: { info: vi.fn(), warn },
    });
    queue.markDirty("oversized-payload", 0);
    queue.kick("oversized-payload");
    await queue.waitForReadyWork();
    queue.kick("oversized-payload");
    await queue.waitForReadyWork();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);
    expect(warn).toHaveBeenLastCalledWith("dsh-session-hub: deferred session=oversized-payload category=payload_too_large");

    queue.markDirty("oversized-payload", 1);
    queue.kick("oversized-payload");
    await queue.waitForReadyWork();
    expect(upload).toHaveBeenCalledTimes(2);
    await queue.dispose();
  });

  it("parks over-limit failures without spinning but permits a later reconciliation", async () => {
    const transform = vi.fn(() => { throw new TransformError("too_many_messages"); });
    const queue = new SessionUploadQueue({
      concurrency: 1,
      scheduler: new ManualScheduler(),
      readSnapshot: async (id) => snapshot(id, 0),
      transform,
      upload: async () => ({ ok: true, status: 200 }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    queue.markDirty("oversize", 0);
    queue.kick("oversize");
    await queue.waitForReadyWork();
    queue.kick("oversize");
    await queue.waitForReadyWork();
    expect(transform).toHaveBeenCalledTimes(1);

    queue.markDirty("oversize", 0);
    queue.kick("oversize");
    await queue.waitForReadyWork();
    expect(transform).toHaveBeenCalledTimes(2);
    await queue.dispose();
  });
});

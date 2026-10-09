import type { DshHubSession, DshLogger, DshSessionSnapshot, RetryScheduler, UploadResult } from "./types.js";
import { SnapshotReadError } from "./reader.js";
import { TransformError } from "./transform.js";
import { UploadError } from "./upload.js";

export const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

export interface SessionQueueDependencies {
  concurrency: number;
  scheduler: RetryScheduler;
  readSnapshot(id: string, requiredSeq: number): Promise<DshSessionSnapshot>;
  transform(snapshot: DshSessionSnapshot): DshHubSession;
  upload(payload: DshHubSession): Promise<UploadResult>;
  logger: DshLogger;
}

interface SessionWork {
  id: string;
  requiredSeq: number;
  dirty: boolean;
  queued: boolean;
  running: boolean;
  failures: number;
  parked: boolean;
  cancelRetry: (() => void) | undefined;
}

export class SessionUploadQueue {
  private readonly works = new Map<string, SessionWork>();
  private readonly ready: SessionWork[] = [];
  private readonly activeTasks = new Set<Promise<void>>();
  private active = 0;
  private stopped = false;

  constructor(private readonly dependencies: SessionQueueDependencies) {
    if (!Number.isInteger(dependencies.concurrency)
      || dependencies.concurrency < 1
      || dependencies.concurrency > 4) {
      throw new RangeError("invalid_concurrency");
    }
  }

  markDirty(id: string, requiredSeq = -1): void {
    if (this.stopped || !id || !Number.isSafeInteger(requiredSeq) || requiredSeq < -1) return;
    const work = this.getWork(id);
    work.dirty = true;
    work.parked = false;
    work.requiredSeq = Math.max(work.requiredSeq, requiredSeq);
    if (work.cancelRetry) {
      work.cancelRetry();
      work.cancelRetry = undefined;
      work.failures = 0;
    }
  }

  reconcile(ids: readonly string[]): void {
    for (const id of ids) this.markDirty(id, -1);
    this.kick();
  }

  kick(id?: string): void {
    if (this.stopped) return;
    if (id !== undefined) {
      const work = this.works.get(id);
      if (work) this.enqueue(work);
    } else {
      for (const work of this.works.values()) this.enqueue(work);
    }
    this.pump();
  }

  async waitForReadyWork(): Promise<void> {
    while (this.activeTasks.size > 0 || this.ready.length > 0) {
      const active = [...this.activeTasks];
      if (active.length > 0) await Promise.all(active);
      else await Promise.resolve();
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.ready.length = 0;
    for (const work of this.works.values()) {
      if (work.cancelRetry) {
        work.cancelRetry();
        work.cancelRetry = undefined;
      }
    }
    await Promise.all([...this.activeTasks]);
    this.works.clear();
  }

  private getWork(id: string): SessionWork {
    let work = this.works.get(id);
    if (!work) {
      work = { id, requiredSeq: -1, dirty: false, queued: false, running: false, failures: 0, parked: false, cancelRetry: undefined };
      this.works.set(id, work);
    }
    return work;
  }

  private enqueue(work: SessionWork): void {
    if (this.stopped || !work.dirty || work.running || work.queued || work.cancelRetry || work.parked) return;
    work.queued = true;
    this.ready.push(work);
  }

  private pump(): void {
    while (!this.stopped && this.active < this.dependencies.concurrency && this.ready.length > 0) {
      const work = this.ready.shift()!;
      work.queued = false;
      if (!work.dirty || work.running) continue;
      work.running = true;
      this.active += 1;
      const task = this.run(work).finally(() => {
        work.running = false;
        this.active -= 1;
        this.activeTasks.delete(task);
        if (work.dirty && !work.cancelRetry && !work.parked && !this.stopped) this.enqueue(work);
        if (!work.dirty && !work.cancelRetry) this.works.delete(work.id);
        this.pump();
      });
      this.activeTasks.add(task);
    }
  }

  private async run(work: SessionWork): Promise<void> {
    while (!this.stopped && work.dirty) {
      const requiredSeq = work.requiredSeq;
      work.dirty = false;
      try {
        const snapshot = await this.dependencies.readSnapshot(work.id, requiredSeq);
        if (this.stopped) return;
        const payload = this.dependencies.transform(snapshot);
        if (this.stopped) return;
        const result = await this.dependencies.upload(payload);
        if (this.stopped) return;
        if (!result.ok) {
          const retryable = result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
          throw new UploadError("http_rejected", { status: result.status, retryable });
        }
        work.failures = 0;
        work.parked = false;
        if (work.requiredSeq > snapshot.lastSeq) work.dirty = true;
        else work.dirty = false;
        this.dependencies.logger.info(
          `dsh-session-hub: uploaded session=${work.id} events=${snapshot.events.length} status=${result.status}`,
        );
      } catch (error) {
        if (this.stopped) return;
        work.dirty = true;
        const retryable = this.isRetryable(error);
        const category = this.errorCategory(error);
        this.dependencies.logger.warn(`dsh-session-hub: deferred session=${work.id} category=${category}`);
        if (!retryable || !this.scheduleRetry(work)) work.parked = true;
        return;
      }
    }
  }

  private scheduleRetry(work: SessionWork): boolean {
    if (this.stopped || work.failures >= RETRY_DELAYS_MS.length) return false;
    const delay = RETRY_DELAYS_MS[work.failures]!;
    work.failures += 1;
    try {
      work.cancelRetry = this.dependencies.scheduler.schedule(delay, () => {
        work.cancelRetry = undefined;
        this.enqueue(work);
        this.pump();
      });
      return true;
    } catch {
      this.dependencies.logger.warn(`dsh-session-hub: deferred session=${work.id} category=retry_scheduler`);
      return false;
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof UploadError) return error.retryable;
    if (error instanceof SnapshotReadError) return error.retryable;
    if (error instanceof TransformError) return error.retryable;
    return true;
  }

  private errorCategory(error: unknown): string {
    if (error instanceof UploadError) return error.code;
    if (error instanceof SnapshotReadError) return error.code;
    if (error instanceof TransformError) return error.code;
    return "operation_failed";
  }
}

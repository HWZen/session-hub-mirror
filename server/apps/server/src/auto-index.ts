import type { SessionRepository } from "./db/sessions.js";
import type { SessionIndexer } from "./indexing.js";
import type { EmbeddingRegistry } from "./embedding/registry.js";

const BATCH = 50;

export class AutoIndexer {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = true;
  #inflight: Promise<void> | null = null;

  constructor(
    private readonly repo: SessionRepository,
    private readonly indexer: SessionIndexer,
    private readonly registry: EmbeddingRegistry,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#inflight = this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  whenIdle(): Promise<void> {
    return this.#inflight ?? Promise.resolve();
  }

  kick(): void {
    if (this.#stopped || this.#running) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#inflight = this.#loop();
    }
  }

  async runOnce(): Promise<number> {
    const activeModel = this.registry.activeModel();
    if (activeModel === null) return 0;
    let indexed = 0;
    for (;;) {
      const sessions = this.repo.listUnindexed(BATCH, activeModel);
      if (sessions.length === 0) break;
      let allOk = true;
      for (const session of sessions) {
        if (await this.indexer.indexSession(session.id)) {
          indexed++;
        } else {
          allOk = false;
        }
      }
      if (!allOk || sessions.length < BATCH) break;
    }
    return indexed;
  }

  async #loop(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      const indexed = await this.runOnce();
      if (indexed > 0) {
        console.log(`[auto-index] round indexed=${indexed} model=${this.registry.activeModel() ?? "none"}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto-index] round failed: ${message}`);
    } finally {
      this.#running = false;
      this.#inflight = null;
      this.#schedule();
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#loop();
    }, this.intervalMs);
  }
}

import { Config, parsePluginConfig, type RawPluginConfig } from "./config.js";
import { RETRY_DELAYS_MS, SessionUploadQueue } from "./queue.js";
import { listSessionIds, readSessionSnapshot } from "./reader.js";
import type {
  DshLiveSession,
  DshLogger,
  DshSessionEvent,
  DshSessionPersistence,
  DshSessionsService,
  DshSubprocessService,
  RetryScheduler,
} from "./types.js";
import { transformSession } from "./transform.js";
import { uploadSession } from "./upload.js";

export { Config };
export const inject = ["sessions", "sessionPersistence", "subprocess", "timer"] as const;

interface CordisHostContext {
  sessions: DshSessionsService;
  sessionPersistence: DshSessionPersistence;
  subprocess: DshSubprocessService;
  logger: DshLogger;
  timeout(callback: () => void, delayMs: number): () => void;
  effect(effect: () => () => void | Promise<void>, label: string): () => void;
  on(
    name: "session/event",
    listener: (session: DshLiveSession, event: DshSessionEvent) => void,
  ): () => void;
}

function safeReadErrorCategory(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  }
  return "reconciliation_failed";
}

export function apply(ctx: CordisHostContext, rawConfig: RawPluginConfig): void {
  const config = parsePluginConfig(rawConfig);
  if (!config) {
    ctx.logger.warn("dsh-session-hub: inactive category=configuration_required");
    return;
  }

  const scheduler: RetryScheduler = {
    schedule(delayMs, callback) {
      return ctx.timeout(callback, delayMs);
    },
  };
  const queue = new SessionUploadQueue({
    concurrency: config.concurrency,
    scheduler,
    readSnapshot: (id, requiredSeq) => readSessionSnapshot(
      ctx.sessionPersistence,
      ctx.sessions,
      id,
      requiredSeq,
    ),
    transform: (snapshot) => transformSession(snapshot, config.machine),
    upload: (payload) => uploadSession(ctx.subprocess, config, payload),
    logger: ctx.logger,
  });

  let disposed = false;
  const stopListener = ctx.on("session/event", (session, event) => {
    if (disposed || (event.type !== "turn/end" && event.type !== "session/title")) return;
    queue.markDirty(session.id, event.seq);
    void Promise.resolve()
      .then(() => {
        if (!disposed) queue.kick(session.id);
      })
      .catch(() => {
        ctx.logger.warn(`dsh-session-hub: deferred session=${session.id} category=dispatch`);
      });
  });

  let startupRetryIndex = 0;
  let cancelStartupRetry: (() => void) | undefined;
  const reconcileStoredSessions = async (): Promise<void> => {
    if (disposed) return;
    try {
      const ids = await listSessionIds(ctx.sessionPersistence);
      if (disposed) return;
      queue.reconcile(ids);
    } catch (error) {
      if (disposed) return;
      ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
      if (startupRetryIndex >= RETRY_DELAYS_MS.length) return;
      const delayMs = RETRY_DELAYS_MS[startupRetryIndex]!;
      startupRetryIndex += 1;
      try {
        cancelStartupRetry = scheduler.schedule(delayMs, () => {
          cancelStartupRetry = undefined;
          void reconcileStoredSessions().catch((error: unknown) => {
            if (!disposed) ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
          });
        });
      } catch {
        ctx.logger.warn("dsh-session-hub: reconciliation category=reconciliation_scheduler");
      }
    }
  };

  if (config.reconcileOnStart) {
    void Promise.resolve()
      .then(reconcileStoredSessions)
      .catch((error: unknown) => {
        if (!disposed) ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
      });
  }

  ctx.effect(() => async () => {
    disposed = true;
    stopListener();
    if (cancelStartupRetry) {
      const cancel = cancelStartupRetry;
      cancelStartupRetry = undefined;
      try { cancel(); } catch {
        ctx.logger.warn("dsh-session-hub: reconciliation category=reconciliation_cleanup");
      }
    }
    await queue.dispose();
  }, "dsh-session-hub.queue");
}

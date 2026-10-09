import { Config, parseExplicitConfig, type RawPluginConfig } from "./config.js";
import { RETRY_DELAYS_MS, SessionUploadQueue } from "./queue.js";
import { listSessionIds, readSessionSnapshot } from "./reader.js";
import {
  createMemoizedProbe,
  createSharedConfigTextSource,
  resolveDerivedWorkerCwd,
  resolvePluginConfig,
} from "./shared-config.js";
import { runSidecar } from "./sidecar.js";
import type {
  DshFsService,
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
export const inject = ["sessions", "sessionPersistence", "subprocess", "timer", "fs"] as const;

interface CordisHostContext {
  sessions: DshSessionsService;
  sessionPersistence: DshSessionPersistence;
  subprocess: DshSubprocessService;
  fs: DshFsService;
  logger: DshLogger;
  timeout(callback: () => void, delayMs: number): () => void;
  effect(effect: () => () => void | Promise<void>, label: string): () => void;
  on(
    name: "session/event",
    listener: (session: DshLiveSession, event: DshSessionEvent) => void,
  ): () => void;
}

interface ActivationControl {
  isDisposed(): boolean;
  setStop(stop: () => Promise<void>): void;
}

function safeReadErrorCategory(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  }
  return "reconciliation_failed";
}

export function apply(ctx: CordisHostContext, rawConfig: RawPluginConfig): void {
  let disposed = false;
  let stopRuntime: (() => Promise<void>) | undefined;

  ctx.effect(() => async () => {
    disposed = true;
    const stop = stopRuntime;
    stopRuntime = undefined;
    if (stop) await stop();
  }, "dsh-session-hub.queue");

  void activate(ctx, rawConfig, {
    isDisposed: () => disposed,
    setStop: (stop) => { stopRuntime = stop; },
  }).catch(() => {
    if (!disposed) ctx.logger.warn("dsh-session-hub: inactive category=configuration_unavailable");
  });
}

async function activate(
  ctx: CordisHostContext,
  rawConfig: RawPluginConfig,
  control: ActivationControl,
): Promise<void> {
  const parsed = parseExplicitConfig(rawConfig);
  if (!parsed.ok) {
    ctx.logger.warn(`dsh-session-hub: inactive category=${parsed.category}`);
    return;
  }
  const explicit = parsed.config;

  const probeHome = createMemoizedProbe(async () => {
    const result = await runSidecar(ctx.subprocess, { op: "home" }, explicit.workerCwd);
    return result.ok ? result.text : null;
  });
  let spawnCwd = explicit.workerCwd;
  if (spawnCwd === undefined) {
    const derived = await resolveDerivedWorkerCwd({ fs: ctx.fs, probeHome });
    if (derived !== null) spawnCwd = derived;
  }

  const probeHostname = createMemoizedProbe(async () => {
    const result = await runSidecar(ctx.subprocess, { op: "hostname" }, spawnCwd);
    return result.ok ? result.text : null;
  });
  const readSharedConfigText = createSharedConfigTextSource({
    fs: ctx.fs,
    probeHome,
    readViaSidecar: async (path, expandHome) => {
      const result = await runSidecar(
        ctx.subprocess,
        { op: "read-text", path, expandHome },
        spawnCwd,
      );
      return result.ok ? result.text : null;
    },
  });

  const resolution = await resolvePluginConfig(explicit, {
    readSharedConfigText,
    probeHostname,
    defaultWorkerCwd: spawnCwd,
  });
  for (const category of resolution.categories) {
    ctx.logger.warn(`dsh-session-hub: shared-config category=${category}`);
  }
  if (!resolution.ok) {
    ctx.logger.warn(`dsh-session-hub: inactive category=${resolution.category}`);
    return;
  }
  if (control.isDisposed()) return;

  const config = resolution.config;
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

  let stopped = false;
  const isInactive = (): boolean => stopped || control.isDisposed();
  const stopListener = ctx.on("session/event", (session, event) => {
    if (isInactive() || (event.type !== "turn/end" && event.type !== "session/title")) return;
    queue.markDirty(session.id, event.seq);
    void Promise.resolve()
      .then(() => {
        if (!isInactive()) queue.kick(session.id);
      })
      .catch(() => {
        ctx.logger.warn(`dsh-session-hub: deferred session=${session.id} category=dispatch`);
      });
  });

  let startupRetryIndex = 0;
  let cancelStartupRetry: (() => void) | undefined;
  const reconcileStoredSessions = async (): Promise<void> => {
    if (isInactive()) return;
    try {
      const ids = await listSessionIds(ctx.sessionPersistence);
      if (isInactive()) return;
      queue.reconcile(ids);
    } catch (error) {
      if (isInactive()) return;
      ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
      if (startupRetryIndex >= RETRY_DELAYS_MS.length) return;
      const delayMs = RETRY_DELAYS_MS[startupRetryIndex]!;
      startupRetryIndex += 1;
      try {
        cancelStartupRetry = scheduler.schedule(delayMs, () => {
          cancelStartupRetry = undefined;
          void reconcileStoredSessions().catch((error: unknown) => {
            if (!isInactive()) ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
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
        if (!isInactive()) ctx.logger.warn(`dsh-session-hub: reconciliation category=${safeReadErrorCategory(error)}`);
      });
  }

  control.setStop(async () => {
    stopped = true;
    stopListener();
    if (cancelStartupRetry) {
      const cancel = cancelStartupRetry;
      cancelStartupRetry = undefined;
      try {
        cancel();
      } catch {
        ctx.logger.warn("dsh-session-hub: reconciliation category=reconciliation_cleanup");
      }
    }
    await queue.dispose();
  });
}

import type { Server } from "node:http";
import type { AutoIndexer } from "./auto-index.js";
import type { SqliteDatabase } from "./db/connection.js";

export const REQUEST_DRAIN_TIMEOUT_MS = 10_000;
export const INDEX_GRACE_MS = 2_000;

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export interface ShutdownRunnerDeps {
  server: Server;
  autoIndexer: AutoIndexer;
  db: SqliteDatabase;
  exit: (code: number) => void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function openConnectionCount(server: Server): Promise<number | null> {
  return new Promise((resolve) => {
    server.getConnections((err, count) => resolve(err ? null : count));
  });
}

function drainRequests(server: Server, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve(false);
    }, timeoutMs);
    server.close(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function runShutdown(deps: ShutdownRunnerDeps, signal: string): Promise<number> {
  const startedAt = Date.now();
  console.log(`[shutdown] begin signal=${signal}`);
  const open = await openConnectionCount(deps.server);
  console.log(`[shutdown] open connections=${open ?? "unknown"}`);
  try {
    deps.autoIndexer.stop();
    deps.server.closeIdleConnections();
    const drained = await drainRequests(deps.server, REQUEST_DRAIN_TIMEOUT_MS);
    if (!drained) {
      console.log(`[shutdown] in-flight requests exceeded ${REQUEST_DRAIN_TIMEOUT_MS}ms, force closed`);
    }
    let idle = false;
    await Promise.race([
      deps.autoIndexer.whenIdle().then(() => {
        idle = true;
      }),
      delay(INDEX_GRACE_MS),
    ]);
    if (!idle) {
      console.log(`[shutdown] index round exceeded ${INDEX_GRACE_MS}ms grace, abandoned (resumes on next start)`);
    }
    try {
      deps.db.close();
    } catch (err) {
      console.error(`[shutdown] db close failed: ${errorMessage(err)}`);
    }
  } catch (err) {
    console.error(`[shutdown] sequence error: ${errorMessage(err)}`);
    deps.exit(1);
    return 1;
  }
  console.log(`[shutdown] done in ${Date.now() - startedAt}ms`);
  deps.exit(0);
  return 0;
}

export function createShutdownRunner(deps: ShutdownRunnerDeps): (signal: string) => Promise<number> {
  let running: Promise<number> | null = null;
  return (signal) => {
    if (running === null) {
      running = runShutdown(deps, signal).catch((err) => {
        console.error(`[shutdown] unexpected error: ${errorMessage(err)}`);
        deps.exit(1);
        return 1;
      });
    }
    return running;
  };
}

export function installGracefulShutdown(
  deps: ShutdownRunnerDeps,
  proc: Pick<NodeJS.Process, "on"> = process,
): void {
  const run = createShutdownRunner(deps);
  let first = true;
  for (const signal of SHUTDOWN_SIGNALS) {
    proc.on(signal, () => {
      if (!first) {
        console.error(`[shutdown] second ${signal}, force exit(1)`);
        deps.exit(1);
        return;
      }
      first = false;
      void run(signal);
    });
  }
}

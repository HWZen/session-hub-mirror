import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { type SessionHubConfig, loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import {
  type ZcodeSessionEntry,
  defaultZcodeDbPath,
  listTopLevelSessionIds,
  openZcodeDb,
  readZcodeSession,
} from "./zcode-db.js";

export interface BackfillOptions {
  url: string;
  token: string;
  db: string;
  since?: number;
  dryRun: boolean;
}

export interface BackfillCounters {
  sessions: number;
  uploaded: number;
  failed: number;
  skipped_since: number;
}

export function parseArgs(argv: string[]): BackfillOptions | null {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--") || arg.length <= 2) continue;
    const bare = arg.slice(2);
    const eq = bare.indexOf("=");
    if (eq !== -1) {
      args[bare.slice(0, eq)] = bare.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[bare] = next;
        i++;
      } else {
        args[bare] = "";
      }
    }
  }
  const url = args["url"];
  const token = args["token"];
  if (!url || !token) return null;
  let since: number | undefined;
  if (args["since"] !== undefined) {
    const n = Number(args["since"]);
    if (!Number.isFinite(n) || n < 0) return null;
    since = n;
  }
  const options: BackfillOptions = {
    url,
    token,
    db: args["db"] ?? defaultZcodeDbPath(),
    ...(since === undefined ? {} : { since }),
    dryRun: args["dry-run"] !== undefined,
  };
  return options;
}

export interface BackfillHooks {
  upload?: (payload: unknown) => Promise<{ ok: boolean; status: number }>;
}

export async function runBackfill(
  options: BackfillOptions,
  hooks: BackfillHooks = {},
): Promise<BackfillCounters> {
  const counters: BackfillCounters = { sessions: 0, uploaded: 0, failed: 0, skipped_since: 0 };
  const config: SessionHubConfig = { baseUrl: options.url, token: options.token, timeoutMs: 120_000 };
  const db = openZcodeDb(options.db);
  try {
    const ids = listTopLevelSessionIds(db);
    counters.sessions = ids.length;
    for (const { id, time_updated } of ids) {
      if (options.since !== undefined && time_updated < options.since) {
        counters.skipped_since++;
        continue;
      }
      if (options.dryRun) continue;
      const entry: ZcodeSessionEntry | null = readZcodeSession(db, id);
      if (!entry) {
        counters.failed++;
        continue;
      }
      const payload = transformSession(entry.session, entry.messages, hostname());
      let outcome: { ok: boolean; status: number };
      try {
        if (hooks.upload) {
          outcome = await hooks.upload(payload);
        } else {
          const result = await uploadSession(config, payload);
          outcome = { ok: result.ok, status: result.status };
        }
      } catch {
        counters.failed++;
        continue;
      }
      if (outcome.ok) {
        counters.uploaded++;
      } else {
        counters.failed++;
      }
    }
  } finally {
    db.close();
  }
  return counters;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    runBackfill(options)
      .then((counters) => {
        console.log(JSON.stringify(counters));
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
  } else {
    console.error(
      `usage: backfill --url <baseUrl> --token <token> [--db <path>] [--since <ms>] [--dry-run]${loadConfig() ? " (or omit --url/--token to use ~/.config/session-hub/config.json)" : ""}`,
    );
    process.exitCode = 1;
  }
}

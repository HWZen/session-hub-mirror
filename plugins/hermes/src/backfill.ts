import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type SessionHubConfig, loadConfig, uploadSession } from "./config.js";
import {
  defaultProfileHomes,
  hermesDbPath,
  listUnarchivedSessionIds,
  openHermesDb,
  readHermesSession,
} from "./hermes-db.js";
import { recordSuccessfulUpload } from "./throttle.js";
import { transformSession } from "./transform.js";

export interface BackfillOptions {
  profileHomes: string[];
  sessionId?: string;
}

export interface BackfillCounters {
  profiles: number;
  sessions: number;
  uploaded: number;
  failed: number;
}

export interface BackfillDependencies {
  config: SessionHubConfig;
  upload?: typeof uploadSession;
  now?: () => number;
}

export function parseArgs(argv: string[], profilesRoot?: string): BackfillOptions | null {
  let profile: string | undefined;
  let sessionId: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--profile" || argument === "--session") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (argument === "--profile") profile = value;
      else sessionId = value;
      index++;
      continue;
    }
    if (argument?.startsWith("--profile=")) profile = argument.slice("--profile=".length);
    else if (argument?.startsWith("--session=")) sessionId = argument.slice("--session=".length);
    else return null;
  }
  const profileHomes = profile ? [resolve(profile)] : defaultProfileHomes(profilesRoot);
  if (profileHomes.some((home) => home.length === 0)) return null;
  return {
    profileHomes,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export async function runBackfill(
  options: BackfillOptions,
  dependencies: BackfillDependencies,
): Promise<BackfillCounters> {
  const counters: BackfillCounters = {
    profiles: options.profileHomes.length,
    sessions: 0,
    uploaded: 0,
    failed: 0,
  };
  const upload = dependencies.upload ?? uploadSession;
  for (const profileHome of options.profileHomes) {
    let db;
    try {
      db = openHermesDb(hermesDbPath(profileHome));
    } catch {
      counters.failed++;
      continue;
    }
    try {
      const ids = listUnarchivedSessionIds(db);
      const selectedIds = options.sessionId === undefined ? ids : ids.filter((id) => id === options.sessionId);
      if (options.sessionId !== undefined && selectedIds.length === 0) {
        counters.failed++;
        continue;
      }
      for (const sessionId of selectedIds) {
        counters.sessions++;
        try {
          const entry = readHermesSession(db, sessionId);
          if (!entry) {
            counters.failed++;
            continue;
          }
          const payload = transformSession(entry.session, entry.messages, hostname());
          const result = await upload(dependencies.config, payload);
          if (!result.ok) {
            counters.failed++;
            continue;
          }
          recordSuccessfulUpload(profileHome, sessionId, dependencies.now?.() ?? Date.now());
          counters.uploaded++;
        } catch {
          counters.failed++;
        }
      }
    } catch {
      counters.failed++;
    } finally {
      db.close();
    }
  }
  return counters;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error("usage: backfill [--profile <profile-home>] [--session <session-id>]");
    process.exitCode = 1;
  } else {
    const config = loadConfig();
    if (!config) {
      console.error("Session Hub 配置缺失，请设置 SH_BASE_URL/SH_TOKEN 或配置技能 config.json");
      process.exitCode = 1;
    } else {
      const counters = await runBackfill(options, { config });
      console.log(JSON.stringify(counters));
      if (counters.failed > 0) process.exitCode = 1;
    }
  }
}

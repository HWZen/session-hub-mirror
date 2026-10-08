import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type SessionHubConfig, loadConfig, uploadSession } from "./config.js";
import { hermesDbPath, openHermesDb, readHermesSession } from "./hermes-db.js";
import { releaseInFlight, recordSuccessfulUpload } from "./throttle.js";
import { transformSession } from "./transform.js";

export interface SyncOutcome {
  ok: boolean;
  detail: string;
  messages: number;
}

export interface WorkerDependencies {
  config?: SessionHubConfig | null;
  upload?: typeof uploadSession;
  now?: () => number;
}

export async function syncSession(
  sessionId: string,
  profileHome: string,
  dependencies: WorkerDependencies = {},
): Promise<SyncOutcome> {
  const config = dependencies.config === undefined ? loadConfig() : dependencies.config;
  if (!config) return { ok: true, detail: "configuration missing, skipped", messages: 0 };

  let entry;
  try {
    const db = openHermesDb(hermesDbPath(profileHome));
    try {
      entry = readHermesSession(db, sessionId);
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      detail: `db read failed: ${error instanceof Error ? error.message : String(error)}`,
      messages: 0,
    };
  }
  if (!entry) return { ok: false, detail: "session not found", messages: 0 };

  const payload = transformSession(entry.session, entry.messages);
  let result;
  try {
    result = await (dependencies.upload ?? uploadSession)(config, payload);
  } catch (error) {
    return {
      ok: false,
      detail: `upload failed: ${error instanceof Error ? error.message : String(error)}`,
      messages: payload.messages.length,
    };
  }
  if (!result.ok) return { ok: false, detail: `status=${result.status}`, messages: payload.messages.length };
  try {
    recordSuccessfulUpload(profileHome, sessionId, dependencies.now?.() ?? Date.now());
  } catch (error) {
    return {
      ok: false,
      detail: `uploaded but throttle marker failed: ${error instanceof Error ? error.message : String(error)}`,
      messages: payload.messages.length,
    };
  }
  return { ok: true, detail: `status=${result.status}`, messages: payload.messages.length };
}

function log(profileHome: string, level: "info" | "error", detail: string, messages: number): void {
  const logDirectory = join(profileHome, "logs");
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(join(logDirectory, "session-hub-hermes-worker.log"), `${new Date().toISOString()} ${level} ${detail} messages=${messages}\n`);
  } catch {}
}

function parseWorkerArgs(argv: string[]): { payloadPath: string; profileHome: string } | null {
  const payloadPath = argv[0];
  const profileIndex = argv.indexOf("--profile");
  const profileHome = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  if (!payloadPath || !profileHome || profileHome.startsWith("--")) return null;
  return { payloadPath, profileHome };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseWorkerArgs(process.argv.slice(2));
  if (args) {
    let sessionId: string | null = null;
    let event: string | null = null;
    try {
      const payload = JSON.parse(readFileSync(args.payloadPath, "utf8")) as Record<string, unknown>;
      sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
      event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : null;
    } catch {
    } finally {
      try {
        unlinkSync(args.payloadPath);
      } catch {}
    }
    if (sessionId) {
      try {
        const outcome = await syncSession(sessionId, args.profileHome);
        log(args.profileHome, outcome.ok ? "info" : "error", `sync ${outcome.detail}`, outcome.messages);
      } catch (error) {
        log(args.profileHome, "error", `sync failed: ${error instanceof Error ? error.message : String(error)}`, 0);
      } finally {
        if (event === "post_api_request") releaseInFlight(args.profileHome, sessionId);
      }
    }
  }
}

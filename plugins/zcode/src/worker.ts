import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import { defaultZcodeDbPath, openZcodeDb, readZcodeSession } from "./zcode-db.js";

const DB_RETRY_INTERVAL_MS = 250;
const DB_RETRY_MAX = 8;
const LOG_DIR = join(homedir(), ".config", "session-hub", "logs");
const LOG_PATH = join(LOG_DIR, "zcode-worker.log");

function log(level: "info" | "error", message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {
    // logging is best-effort; never fail the worker over it
  }
}

export function extractSessionId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["session_id", "sessionId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

interface SyncOutcome {
  ok: boolean;
  detail: string;
  messages: number;
}

export async function syncSession(sessionId: string, dbPath: string = defaultZcodeDbPath()): Promise<SyncOutcome> {
  const config = loadConfig();
  if (!config) {
    return { ok: true, detail: "not configured, skipped", messages: 0 };
  }
  let entry = null;
  for (let attempt = 0; attempt <= DB_RETRY_MAX; attempt++) {
    try {
      const db = openZcodeDb(dbPath);
      try {
        entry = readZcodeSession(db, sessionId);
      } finally {
        db.close();
      }
    } catch (err) {
      return {
        ok: false,
        detail: `db open failed: ${err instanceof Error ? err.message : String(err)}`,
        messages: 0,
      };
    }
    if (entry) break;
    if (attempt < DB_RETRY_MAX) {
      await new Promise((resolve) => setTimeout(resolve, DB_RETRY_INTERVAL_MS));
    }
  }
  if (!entry) {
    return { ok: false, detail: "session not found in db after retries", messages: 0 };
  }
  const payload = transformSession(entry.session, entry.messages);
  try {
    const result = await uploadSession(config, payload);
    return {
      ok: result.ok,
      detail: `status=${result.status}`,
      messages: payload.messages.length,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `upload failed: ${err instanceof Error ? err.message : String(err)}`,
      messages: payload.messages.length,
    };
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) return;
  let payload: unknown = null;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch {
    return;
  }
  try {
    unlinkSync(payloadPath);
  } catch {}
  const sessionId = extractSessionId(payload);
  if (!sessionId) {
    log("error", "payload without session_id, skipped");
    return;
  }
  const outcome = await syncSession(sessionId);
  log(outcome.ok ? "info" : "error", `sync session=${sessionId} ${outcome.detail} messages=${outcome.messages}`);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("worker.js");

if (isMain) {
  await main();
}

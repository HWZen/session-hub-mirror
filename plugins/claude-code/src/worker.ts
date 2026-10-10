import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import { groupTranscript, readTranscript } from "./transcript.js";

const LOG_DIR = join(homedir(), ".config", "session-hub", "logs");
const LOG_PATH = join(LOG_DIR, "claude-code-worker.log");

function log(level: "info" | "error", message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {
    // logging is best-effort; never fail the worker over it
  }
}

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name?: string;
}

export async function processSession(
  payload: HookPayload,
  upload: typeof uploadSession = uploadSession,
): Promise<boolean> {
  const config = loadConfig();
  if (!config) return true;

  try {
    const entries = readTranscript(payload.transcript_path);
    const transcript = groupTranscript(entries);
    if (transcript.messages.length === 0) return true;

    const session = transformSession(transcript, payload.cwd);
    const result = await upload(config, session);
    if (!result.ok) {
      log("error", `upload failed session=${payload.session_id} status=${result.status}`);
    } else {
      log("info", `sync session=${payload.session_id} messages=${session.messages.length} status=${result.status}`);
    }
    return result.ok;
  } catch (err) {
    log("error", `failed session=${payload.session_id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    log("error", "no payload path provided");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (err) {
    log("error", `failed to read payload: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    unlinkSync(payloadPath);
  } catch {}

  if (typeof payload !== "object" || payload === null) {
    log("error", "invalid payload format");
    return;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["session_id"] !== "string" || typeof record["transcript_path"] !== "string") {
    log("error", "missing required fields: session_id or transcript_path");
    return;
  }

  const hookPayload: HookPayload = {
    session_id: record["session_id"],
    transcript_path: record["transcript_path"],
  };
  if (typeof record["cwd"] === "string") hookPayload.cwd = record["cwd"];
  if (typeof record["hook_event_name"] === "string") hookPayload.hook_event_name = record["hook_event_name"];
  await processSession(hookPayload);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("worker.js");

if (isMain) {
  await main();
}

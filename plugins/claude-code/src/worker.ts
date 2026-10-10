import { readFileSync, unlinkSync } from "node:fs";
import { loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import { groupTranscript, readTranscript } from "./transcript.js";

function logError(message: string): void {
  console.error(`[session-hub-claude-code-worker] ${message}`);
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
      logError(`upload failed for session ${payload.session_id}: status ${result.status}`);
    }
    return result.ok;
  } catch (err) {
    logError(`failed to process session ${payload.session_id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    logError("no payload path provided");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (err) {
    logError(`failed to read payload: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    unlinkSync(payloadPath);
  } catch {}

  if (typeof payload !== "object" || payload === null) {
    logError("invalid payload format");
    return;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["session_id"] !== "string" || typeof record["transcript_path"] !== "string") {
    logError("missing required fields: session_id or transcript_path");
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

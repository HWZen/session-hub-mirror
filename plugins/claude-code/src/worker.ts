import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import { readTranscript, groupTranscript } from "./transcript.js";

function logError(message: string): void {
  // Log to stderr for debugging, but don't fail the worker
  console.error(`[session-hub-claude-code-worker] ${message}`);
}

export async function processSession(payload: {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}): Promise<boolean> {
  const config = loadConfig();
  if (!config) {
    // Not configured, silently skip
    return true;
  }

  try {
    // Read transcript JSONL
    const entries = readTranscript(payload.transcript_path);

    // Group and transform transcript
    const transcript = groupTranscript(entries);
    const session = transformSession(transcript);

    // Upload to service
    const result = await uploadSession(config, session);
    return result.ok;
  } catch (err) {
    logError(`Failed to process session ${payload.session_id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    logError("No payload path provided");
    return;
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (err) {
    logError(`Failed to read payload: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Clean up temp file
  try {
    unlinkSync(payloadPath);
  } catch {}

  if (typeof payload !== "object" || payload === null) {
    logError("Invalid payload format");
    return;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.session_id !== "string" || typeof record.transcript_path !== "string") {
    logError("Missing required fields: session_id or transcript_path");
    return;
  }

  await processSession({
    session_id: record.session_id,
    transcript_path: record.transcript_path,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    hook_event_name: typeof record.hook_event_name === "string" ? record.hook_event_name : "",
  });
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("worker.js");

if (isMain) {
  await main();
}

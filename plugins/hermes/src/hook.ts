import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FINAL_EVENTS, isThrottled, readLastUploadedAt, releaseInFlight, tryClaimUpload } from "./throttle.js";

export const SUPPORTED_EVENTS = new Set(["post_api_request", ...FINAL_EVENTS]);

export interface HookIdentity {
  sessionId: string;
  event: string;
}

export function parseHookPayload(raw: string): HookIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sessionId = record["session_id"];
  const event = record["hook_event_name"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof event !== "string" || !SUPPORTED_EVENTS.has(event)) return null;
  return { sessionId, event };
}

export function profileHomeFromArgs(argv: string[]): string | null {
  const index = argv.indexOf("--profile");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) return null;
  return resolve(value);
}

export function shouldScheduleUpload(
  identity: HookIdentity,
  profileHome: string,
  now = Date.now(),
): boolean {
  const lastUploadedAt = readLastUploadedAt(profileHome, identity.sessionId);
  return !isThrottled(lastUploadedAt, identity.event, now);
}

export function forwardToWorker(
  raw: string,
  profileHome: string,
  spawnFn: typeof spawn = spawn,
  workerPath = fileURLToPath(new URL("./worker.js", import.meta.url)),
): boolean {
  const identity = parseHookPayload(raw);
  if (!identity) return false;
  try {
    if (!tryClaimUpload(profileHome, identity.sessionId, identity.event)) return false;
  } catch {
    return false;
  }
  const releasePending = !FINAL_EVENTS.has(identity.event);
  const payloadPath = join(tmpdir(), `session-hub-hermes-${randomUUID()}.json`);
  try {
    writeFileSync(payloadPath, JSON.stringify({ session_id: identity.sessionId, hook_event_name: identity.event }), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch {
    if (releasePending) releaseInFlight(profileHome, identity.sessionId);
    return false;
  }
  try {
    const child = spawnFn(process.execPath, [workerPath, payloadPath, "--profile", profileHome], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    try {
      unlinkSync(payloadPath);
    } catch {}
    if (releasePending) releaseInFlight(profileHome, identity.sessionId);
    return false;
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const profileHome = profileHomeFromArgs(process.argv.slice(2));
  if (profileHome) forwardToWorker(readStdin(), profileHome);
  process.exit(0);
}

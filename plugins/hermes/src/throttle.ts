import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const THROTTLE_INTERVAL_MS = 60_000;
export const IN_FLIGHT_TIMEOUT_MS = 120_000;
export const FINAL_EVENTS = new Set(["on_session_end", "on_session_finalize", "on_session_reset"]);

export function throttleMarkerPath(profileHome: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(profileHome, ".session-hub-hermes", `${key}.json`);
}

function inFlightPath(profileHome: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(profileHome, ".session-hub-hermes", `${key}.pending`);
}

export function isThrottled(lastUploadedAt: number | null, event: string, now = Date.now()): boolean {
  if (FINAL_EVENTS.has(event) || lastUploadedAt === null || !Number.isFinite(lastUploadedAt)) return false;
  return now >= lastUploadedAt && now - lastUploadedAt < THROTTLE_INTERVAL_MS;
}

export function readLastUploadedAt(profileHome: string, sessionId: string): number | null {
  const path = throttleMarkerPath(profileHome, sessionId);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { uploadedAt?: unknown };
    return typeof data.uploadedAt === "number" && Number.isFinite(data.uploadedAt) ? data.uploadedAt : null;
  } catch {
    return null;
  }
}

export function tryClaimUpload(profileHome: string, sessionId: string, event: string, now = Date.now()): boolean {
  if (FINAL_EVENTS.has(event)) return true;
  if (isThrottled(readLastUploadedAt(profileHome, sessionId), event, now)) return false;
  const path = inFlightPath(profileHome, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ startedAt: now }), { encoding: "utf8", flag: "wx" });
      if (isThrottled(readLastUploadedAt(profileHome, sessionId), event, now)) {
        releaseInFlight(profileHome, sessionId);
        return false;
      }
      return true;
    } catch (error) {
      if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
      let startedAt: number | null = null;
      try {
        const pending = JSON.parse(readFileSync(path, "utf8")) as { startedAt?: unknown };
        if (typeof pending.startedAt === "number" && Number.isFinite(pending.startedAt)) startedAt = pending.startedAt;
      } catch {
      }
      if (startedAt !== null && now >= startedAt && now - startedAt < IN_FLIGHT_TIMEOUT_MS) return false;
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseInFlight(profileHome: string, sessionId: string): void {
  try {
    unlinkSync(inFlightPath(profileHome, sessionId));
  } catch {}
}

export function recordSuccessfulUpload(profileHome: string, sessionId: string, uploadedAt = Date.now()): void {
  const path = throttleMarkerPath(profileHome, sessionId);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify({ uploadedAt }), { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

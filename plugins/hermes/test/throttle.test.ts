import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINAL_EVENTS,
  IN_FLIGHT_TIMEOUT_MS,
  THROTTLE_INTERVAL_MS,
  isThrottled,
  readLastUploadedAt,
  recordSuccessfulUpload,
  releaseInFlight,
  throttleMarkerPath,
  tryClaimUpload,
} from "../src/throttle.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-hub-hermes-throttle-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Hermes upload throttle", () => {
  it("throttles the same session for 60 seconds", () => {
    const uploadedAt = 10_000;
    expect(THROTTLE_INTERVAL_MS).toBe(60_000);
    expect(isThrottled(uploadedAt, "post_api_request", uploadedAt + 59_999)).toBe(true);
    expect(isThrottled(uploadedAt, "post_api_request", uploadedAt + 60_000)).toBe(false);
    expect(isThrottled(null, "post_api_request", uploadedAt)).toBe(false);
  });

  it("lets final lifecycle events bypass throttling", () => {
    for (const event of FINAL_EVENTS) expect(isThrottled(10_000, event, 10_001)).toBe(false);
  });

  it("claims one in-flight post hook and releases expired claims", () => {
    const home = tempDirectory();
    expect(tryClaimUpload(home, "s1", "post_api_request", 10_000)).toBe(true);
    expect(tryClaimUpload(home, "s1", "post_api_request", 10_001)).toBe(false);
    expect(tryClaimUpload(home, "s1", "post_api_request", 10_000 + IN_FLIGHT_TIMEOUT_MS)).toBe(true);
    releaseInFlight(home, "s1");
    expect(tryClaimUpload(home, "s1", "post_api_request", 10_000 + IN_FLIGHT_TIMEOUT_MS + 1)).toBe(true);
    releaseInFlight(home, "s1");
  });

  it("persists only a success timestamp at a profile-local hashed path", () => {
    const home = tempDirectory();
    const sessionId = "private-session-identifier";
    recordSuccessfulUpload(home, sessionId, 123_456);
    expect(readLastUploadedAt(home, sessionId)).toBe(123_456);
    expect(throttleMarkerPath(home, sessionId)).not.toContain(sessionId);
  });
});

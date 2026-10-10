import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function readStdinPayload(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function forwardToWorker(raw: string, spawnFn: typeof spawn = spawn): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  // Check if payload has required fields
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Record<string, unknown>;
  if (typeof record.session_id !== "string" || typeof record.transcript_path !== "string") return;

  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  const tmpFile = join(tmpdir(), `session-hub-claude-code-${process.pid}-${Date.now()}.json`);

  try {
    writeFileSync(tmpFile, JSON.stringify(payload));
  } catch {
    return;
  }

  try {
    const child = spawnFn(process.execPath, [workerPath, tmpFile], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    try {
      // Clean up temp file on error
      unlinkSync(tmpFile);
    } catch {}
  }
}

async function main(): Promise<void> {
  const raw = readStdinPayload();
  if (raw.trim()) forwardToWorker(raw);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("hook.js");

if (isMain) {
  await main();
  process.exit(0);
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function readStdinPayload(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function queueDirectory(env: Record<string, string | undefined> = process.env): string {
  const pluginData = env["PLUGIN_DATA"] ?? env["CLAUDE_PLUGIN_DATA"];
  return pluginData
    ? join(pluginData, "queue")
    : join(homedir(), ".config", "session-hub", "queue", "codex");
}

export function forwardToWorker(
  raw: string,
  env: Record<string, string | undefined> = process.env,
  spawnFn: typeof spawn = spawn,
): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const queueDir = queueDirectory(env);
  const payloadPath = join(queueDir, `${randomUUID()}.json`);
  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
  } catch {
    return false;
  }
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  try {
    const child = spawnFn(process.execPath, [workerPath, payloadPath], {
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
    return false;
  }
}

async function main(): Promise<void> {
  const raw = readStdinPayload();
  if (raw.trim().length > 0) forwardToWorker(raw);
  process.stdout.write('{"continue":true}\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

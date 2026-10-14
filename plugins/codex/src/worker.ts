import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { parseRolloutText, readTitleIndex, type ParsedRollout } from "./parse.js";
import { transformRollout } from "./transform.js";
import { uploadSession } from "./upload.js";

const LOG_DIR = join(homedir(), ".config", "session-hub", "logs");
const LOG_PATH = join(LOG_DIR, "codex-worker.log");

interface HookPayload {
  sessionId?: string;
  transcriptPath: string;
  cwd?: string;
  turnId?: string;
}

export interface SyncOutcome {
  ok: boolean;
  detail: string;
  sourceId?: string;
  messages: number;
}

function log(level: "info" | "error", message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {}
}

export function extractHookPayload(value: unknown): HookPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const transcriptPath = row["transcript_path"];
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;
  const sessionId = typeof row["session_id"] === "string" ? row["session_id"] : undefined;
  const cwd = typeof row["cwd"] === "string" ? row["cwd"] : undefined;
  const turnId = typeof row["turn_id"] === "string" ? row["turn_id"] : undefined;
  return {
    transcriptPath,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function containsExpectedTurn(rollout: ParsedRollout, turnId?: string): boolean {
  if (turnId) return rollout.eventItems.some((entry) => entry.turnId === turnId);
  return rollout.eventItems.some((entry) => entry.item["type"] === "AgentMessage") || rollout.legacyItems.length > 0;
}

export async function waitForStableRollout(
  transcriptPath: string,
  turnId?: string,
  maxWaitMs = 2000,
  intervalMs = 200,
): Promise<ParsedRollout | null> {
  const deadline = Date.now() + maxWaitMs;
  let lastSize = -1;
  let last: ParsedRollout | null = null;
  await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(0, Math.trunc(maxWaitMs / 2)))));
  do {
    try {
      const size = statSync(transcriptPath).size;
      const parsed = parseRolloutText(readFileSync(transcriptPath, "utf8"), transcriptPath);
      if (parsed) last = parsed;
      if (parsed && size === lastSize && containsExpectedTurn(parsed, turnId)) return parsed;
      lastSize = size;
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() <= deadline);
  return last;
}

export async function syncHookPayload(payload: HookPayload): Promise<SyncOutcome> {
  const config = loadConfig();
  if (!config) return { ok: true, detail: "not configured, skipped", messages: 0 };
  const rollout = await waitForStableRollout(payload.transcriptPath, payload.turnId);
  if (!rollout) return { ok: false, detail: "transcript unreadable", messages: 0 };
  if (rollout.isSubagent) return { ok: true, detail: "subagent skipped", sourceId: rollout.sourceId, messages: 0 };
  const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const titleEntry = readTitleIndex(join(codexHome, "session_index.jsonl")).get(rollout.sourceId);
  const transformed = transformRollout(rollout, {
    ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
    ...(titleEntry === undefined ? {} : { title: titleEntry.title, titleUpdatedAt: titleEntry.updatedAt }),
  });
  try {
    const result = await uploadSession(config, transformed);
    return {
      ok: result.ok,
      detail: `status=${result.status} invalidLines=${rollout.stats.invalidLines} unknownEvents=${rollout.stats.unknownEvents}`,
      sourceId: rollout.sourceId,
      messages: transformed.messages.length,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `upload failed: ${error instanceof Error ? error.message : String(error)}`,
      sourceId: rollout.sourceId,
      messages: transformed.messages.length,
    };
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch {
    raw = null;
  } finally {
    try {
      unlinkSync(payloadPath);
    } catch {}
  }
  const payload = extractHookPayload(raw);
  if (!payload) {
    log("error", "invalid hook payload skipped");
    return;
  }
  const outcome = await syncHookPayload(payload);
  const id = outcome.sourceId ?? payload.sessionId ?? "unknown";
  log(outcome.ok ? "info" : "error", `sync session=${id} ${outcome.detail} messages=${outcome.messages}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

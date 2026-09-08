import { sessionUpsertSchema, type SessionUpsertInput } from "@session-hub/shared";
import { hostname } from "node:os";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, loadConfig, type SessionHubConfig } from "./config.js";
import { parseTranscript } from "./parse.js";
import { uploadSession, type UploadResult } from "./upload.js";

export const LOG_PATH = join(CONFIG_DIR, "workbuddy-hook.log");

export interface HookStdinEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  logLines: string[];
  uploaded: boolean;
  status: number | null;
}

export interface TranscriptStat {
  createdMs: number;
  updatedMs: number;
}

export interface RunHookDeps {
  config: SessionHubConfig | null;
  machine: string;
  readTranscript: (path: string) => string;
  statTranscript?: (path: string) => TranscriptStat | undefined;
  upload: (config: SessionHubConfig, payload: SessionUpsertInput) => Promise<UploadResult>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

export async function runHook(stdin: string, deps: RunHookDeps): Promise<HookOutcome> {
  const logLines: string[] = [];
  const stderrParts: string[] = [];
  const fail = (message: string, status: number | null = null): HookOutcome => {
    stderrParts.push(`session-hub workbuddy hook: ${message}`);
    return { exitCode: 0, stdout: "", stderr: stderrParts.join("\n"), logLines, uploaded: false, status };
  };
  const log = (message: string) => {
    logLines.push(`${new Date().toISOString()} ${message}`);
  };

  let event: HookStdinEvent | null = null;
  try {
    event = recordOf(JSON.parse(stdin)) as HookStdinEvent | null;
  } catch {
    event = null;
  }
  if (!event) return fail("invalid stdin JSON, skipped");
  const sessionId = typeof event["session_id"] === "string" ? event["session_id"] : null;
  const transcriptPath = typeof event["transcript_path"] === "string" ? event["transcript_path"] : null;
  const eventName = typeof event["hook_event_name"] === "string" ? event["hook_event_name"] : "unknown";
  const reason = typeof event["reason"] === "string" ? event["reason"] : "";
  if (!transcriptPath) return fail(`no transcript_path session=${sessionId ?? "?"} event=${eventName}`);

  if (!deps.config) return fail("session-hub not configured, hook skipped");

  let jsonl: string;
  try {
    jsonl = deps.readTranscript(transcriptPath);
  } catch (err) {
    return fail(
      `transcript unreadable path=${transcriptPath} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stat = deps.statTranscript?.(transcriptPath);
  const parsed = parseTranscript(jsonl, {
    sessionId,
    transcriptPath,
    cwd: typeof event["cwd"] === "string" ? event["cwd"] : null,
    machine: deps.machine,
    ...(stat ? { fallbackCreatedMs: stat.createdMs, fallbackUpdatedMs: stat.updatedMs } : {}),
  });
  if (!parsed.payload) return fail(`cannot resolve session_id event=${eventName}`);
  if (parsed.stats.parseErrors > 0) {
    log(`workbuddy hook parse warnings lines=${parsed.stats.lines} parse_errors=${parsed.stats.parseErrors}`);
  }

  const validated = sessionUpsertSchema.safeParse(parsed.payload);
  if (!validated.success) {
    return fail(`payload schema mismatch session=${parsed.payload.source_id}: ${validated.error.message}`);
  }

  let result: UploadResult;
  try {
    result = await deps.upload(deps.config, validated.data);
  } catch (err) {
    return fail(
      `upload failed session=${parsed.payload.source_id} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log(
    `workbuddy hook event=${eventName}${reason ? ` reason=${reason}` : ""} session=${parsed.payload.source_id} ` +
      `status=${result.status} messages=${validated.data.messages.length} kept=${parsed.stats.kept} ` +
      `dropped=${parsed.stats.dropped} uploaded=${result.ok}`,
  );
  if (!result.ok) {
    stderrParts.push(`session-hub workbuddy hook: upload not ok status=${result.status}`);
  }
  return {
    exitCode: 0,
    stdout: "",
    stderr: stderrParts.join("\n"),
    logLines,
    uploaded: result.ok,
    status: result.status,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function appendLogSafe(line: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // 日志失败不影响退出码
  }
}

async function main(): Promise<void> {
  const stdin = await readStdin();
  const outcome = await runHook(stdin, {
    config: loadConfig(),
    machine: hostname(),
    readTranscript: (p) => readFileSync(p, "utf8"),
    statTranscript: (p) => {
      try {
        const s = statSync(p);
        return { createdMs: s.birthtimeMs || s.ctimeMs, updatedMs: s.mtimeMs };
      } catch {
        return undefined;
      }
    },
    upload: uploadSession,
  });
  if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
  if (outcome.stderr.length > 0) process.stderr.write(`${outcome.stderr}\n`);
  for (const line of outcome.logLines) appendLogSafe(line);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("workbuddy/hook.ts")) {
  void main();
}

import type { DshHubSession, DshSubprocessService, SubprocessCapturedOutput, UploadResult } from "./types.js";
import type { DshPluginConfig } from "./config.js";
import { uploaderMain } from "./uploader-sidecar.js";

export type UploadErrorCode = "worker_start" | "worker_exit" | "worker_output" | "http_rejected" | "payload_too_large" | "payload_serialization";

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: UploadErrorCode, options: { status?: number; retryable: boolean }) {
    super(code);
    this.name = "UploadError";
    this.code = code;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}

export const UPLOADER_CODE = "(" + uploaderMain.toString() + ")()";
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const CAPTURE_LIMIT_BYTES = 65_536;

function decodeCapture(capture: SubprocessCapturedOutput): string {
  if (capture.lossy || capture.spillPath !== undefined || typeof capture.text !== "string"
    || !Number.isSafeInteger(capture.nextOffset) || capture.nextOffset < 0) {
    throw new UploadError("worker_output", { retryable: true });
  }
  return capture.text;
}

function parseResult(value: string): UploadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw new UploadError("worker_output", { retryable: true });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UploadError("worker_output", { retryable: true });
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "ok" || keys[1] !== "status"
    || typeof record["ok"] !== "boolean"
    || typeof record["status"] !== "number"
    || !Number.isSafeInteger(record["status"])
    || record["status"] < 0
    || record["status"] > 599) {
    throw new UploadError("worker_output", { retryable: true });
  }
  return { ok: record["ok"], status: record["status"] };
}

export async function uploadSession(
  subprocess: DshSubprocessService,
  config: DshPluginConfig,
  payload: DshHubSession,
): Promise<UploadResult> {
  let payloadJson: string;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") throw new Error();
    if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
      throw new UploadError("payload_too_large", { retryable: false });
    }
    payloadJson = serialized;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError("payload_serialization", { retryable: false });
  }
  const stdinData = JSON.stringify({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.timeoutMs,
  }) + "\n" + payloadJson;

  let node: string;
  try {
    node = await subprocess.resolveExecutable("node");
  } catch {
    throw new UploadError("worker_start", { retryable: true });
  }

  let handle;
  try {
    handle = subprocess.spawn({
      argv: [node, "-e", UPLOADER_CODE],
      stdio: {
        stdin: { data: stdinData },
        stdout: { maxBytes: CAPTURE_LIMIT_BYTES },
        stderr: { maxBytes: CAPTURE_LIMIT_BYTES },
      },
      graceMs: 3_000,
      ...(config.workerCwd === undefined ? {} : { cwd: config.workerCwd }),
    });
  } catch {
    throw new UploadError("worker_start", { retryable: true });
  }

  let completion: { exitCode: number | null; signal?: string | null };
  try {
    completion = await handle.done;
  } catch {
    throw new UploadError("worker_exit", { retryable: true });
  }
  if (completion.exitCode !== 0 || (completion.signal !== undefined && completion.signal !== null)) {
    throw new UploadError("worker_exit", { retryable: true });
  }

  const capture = handle.collected.stdout;
  if (!capture) throw new UploadError("worker_output", { retryable: true });
  let output: string;
  try {
    output = decodeCapture(capture.readFrom(0));
  } catch {
    throw new UploadError("worker_output", { retryable: true });
  }
  const result = parseResult(output);
  if (!result.ok) {
    const retryable = result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
    throw new UploadError("http_rejected", { status: result.status, retryable });
  }
  return result;
}

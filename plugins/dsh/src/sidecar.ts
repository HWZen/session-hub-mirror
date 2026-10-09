import type { DshSubprocessService, SubprocessCapturedOutput } from "./types.js";

export type SidecarRequest =
  | { op: "hostname" }
  | { op: "home" }
  | { op: "read-text"; path: string; expandHome: boolean };

export interface SidecarResult {
  ok: boolean;
  text: string;
  category: string;
}

export const SIDECAR_CODE = "(" + sidecarMain.toString() + ")()";

const CAPTURE_LIMIT_BYTES = 262_144;
const STDERR_LIMIT_BYTES = 8_192;
const GRACE_MS = 3_000;

export async function sidecarMain(): Promise<void> {
  let ok = false;
  let text = "";
  let category = "sidecar_failed";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error();
    const record = request as Record<string, unknown>;
    const op = record["op"];
    if (op === "hostname") {
      const os = await import("node:os");
      const value = os.hostname();
      if (typeof value !== "string" || value.trim().length === 0) throw new Error();
      text = value.trim();
      ok = true;
    } else if (op === "home") {
      const os = await import("node:os");
      const value = os.homedir();
      if (typeof value !== "string" || value.trim().length === 0) throw new Error();
      text = value.trim();
      ok = true;
    } else if (op === "read-text") {
      const path = record["path"];
      if (typeof path !== "string" || path.length === 0) throw new Error();
      let target = path;
      if (record["expandHome"] === true) {
        const os = await import("node:os");
        const nodePath = await import("node:path");
        const home = os.homedir();
        if (typeof home !== "string" || home.length === 0) throw new Error();
        if (target === "~") target = home;
        else if (target.startsWith("~/") || target.startsWith("~\\")) target = nodePath.join(home, target.slice(2));
      }
      const fs = await import("node:fs");
      const value: unknown = fs.readFileSync(target, "utf8");
      if (typeof value !== "string") throw new Error();
      text = value;
      ok = true;
    } else {
      category = "sidecar_bad_request";
    }
  } catch {
    ok = false;
  } finally {
    try {
      process.stdout.write(JSON.stringify(ok ? { ok: true, text } : { ok: false, category }) + "\n");
    } catch {}
  }
}

function decodeCapture(capture: SubprocessCapturedOutput): string {
  if (capture.lossy || capture.spillPath !== undefined || typeof capture.text !== "string"
    || !Number.isSafeInteger(capture.nextOffset) || capture.nextOffset < 0) {
    throw new Error("sidecar_output");
  }
  return capture.text;
}

function parseResponse(value: string): { ok: true; text: string } | { ok: false; category: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw new Error("sidecar_output");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("sidecar_output");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record["ok"] === true
    && keys.length === 2
    && keys[0] === "ok"
    && keys[1] === "text"
    && typeof record["text"] === "string") {
    return { ok: true, text: record["text"] };
  }
  if (record["ok"] === false
    && keys.length === 2
    && keys[0] === "category"
    && keys[1] === "ok"
    && typeof record["category"] === "string"
    && /^[a-z_]+$/.test(record["category"])) {
    return { ok: false, category: record["category"] };
  }
  throw new Error("sidecar_output");
}

export async function runSidecar(
  subprocess: DshSubprocessService,
  request: SidecarRequest,
  cwd: string | undefined,
): Promise<SidecarResult> {
  let node: string;
  try {
    node = await subprocess.resolveExecutable("node");
  } catch {
    return { ok: false, text: "", category: "sidecar_start" };
  }

  let handle;
  try {
    handle = subprocess.spawn({
      argv: [node, "-e", SIDECAR_CODE],
      stdio: {
        stdin: { data: JSON.stringify(request) },
        stdout: { maxBytes: CAPTURE_LIMIT_BYTES },
        stderr: { maxBytes: STDERR_LIMIT_BYTES },
      },
      graceMs: GRACE_MS,
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch {
    return { ok: false, text: "", category: "sidecar_start" };
  }

  let completion: { exitCode: number | null; signal?: string | null };
  try {
    completion = await handle.done;
  } catch {
    return { ok: false, text: "", category: "sidecar_exit" };
  }
  if (completion.exitCode !== 0 || (completion.signal !== undefined && completion.signal !== null)) {
    return { ok: false, text: "", category: "sidecar_exit" };
  }

  const capture = handle.collected.stdout;
  if (!capture) return { ok: false, text: "", category: "sidecar_output" };
  try {
    const parsed = parseResponse(decodeCapture(capture.readFrom(0)));
    return parsed.ok
      ? { ok: true, text: parsed.text, category: "ok" }
      : { ok: false, text: "", category: parsed.category };
  } catch {
    return { ok: false, text: "", category: "sidecar_output" };
  }
}

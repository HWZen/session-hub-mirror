import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePluginConfig } from "../src/config.js";
import { uploadSession, UploadError, UPLOADER_CODE, MAX_PAYLOAD_BYTES } from "../src/upload.js";
import { uploaderMain } from "../src/uploader-sidecar.js";
import type { DshHubSession, DshSubprocessService, SubprocessCapturedOutput } from "../src/types.js";

const secretToken = "secret-test-token";
const payload: DshHubSession = {
  agent: "dsh",
  machine: "machine",
  source_id: "session-1",
  created_at: 100,
  updated_at: 200,
  messages: [{ role: "user", text: "secret conversation text", raw: [{ type: "text", text: "secret conversation text" }] }],
};
const config = parsePluginConfig({
  baseUrl: "http://127.0.0.1:7428/",
  token: secretToken,
  machine: "machine",
  timeoutMs: 1_000,
  workerCwd: "D:\\session-hub\\plugins\\dsh",
  reconcileOnStart: false,
  concurrency: 1,
})!;

afterEach(() => vi.unstubAllGlobals());

function stubSidecarProcess(input: string): string[] {
  const output: string[] = [];
  vi.stubGlobal("process", {
    stdin: (async function* () { yield Buffer.from(input); })(),
    stdout: { write: (chunk: string) => { output.push(chunk); return true; } },
  });
  return output;
}

function capture(text: string, overrides: Partial<SubprocessCapturedOutput> = {}): SubprocessCapturedOutput {
  return { text, nextOffset: text.length, lossy: false, ...overrides };
}

function subprocessFor(
  output: SubprocessCapturedOutput,
  exitCode = 0,
): { service: DshSubprocessService; spawnOptions: unknown[]; stderrRead: ReturnType<typeof vi.fn> } {
  const spawnOptions: unknown[] = [];
  const stderrRead = vi.fn(() => capture(""));
  const service: DshSubprocessService = {
    resolveExecutable: vi.fn(async () => "C:\\Program Files\\nodejs\\node.exe"),
    spawn: vi.fn((options) => {
      spawnOptions.push(options);
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: vi.fn(() => output) },
          stderr: { readFrom: stderrRead },
        },
      };
    }),
  };
  return { service, spawnOptions, stderrRead };
}

describe("uploaderMain sidecar", () => {
  it("sends raw payload JSON and emits only HTTP status", async () => {
    const payloadJson = JSON.stringify(payload);
    const output = stubSidecarProcess(`${JSON.stringify({ baseUrl: config.baseUrl, token: secretToken, timeoutMs: config.timeoutMs })}\n${payloadJson}`);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("private response body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploaderMain();
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    vi.unstubAllGlobals();

    expect(url).toBe("http://127.0.0.1:7428/v1/sessions");
    expect(init?.body).toBe(payloadJson);
    expect(headers.get("authorization")).toBe(`Bearer ${secretToken}`);
    expect(output.join("")).toBe('{"ok":true,"status":200}\n');
    expect(output.join("")).not.toContain(secretToken);
    expect(output.join("")).not.toContain("private response body");
  });

  it("emits the status-only failure protocol for malformed stdin when executed as generated code", async () => {
    const output = stubSidecarProcess("invalid sidecar input");
    const generated = new Function(`return ${UPLOADER_CODE}`) as () => Promise<void>;
    await generated();
    vi.unstubAllGlobals();

    expect(output.join("")).toBe('{"ok":false,"status":0}\n');
  });
});

describe("uploadSession", () => {
  it("keeps token and complete payload on stdin, never argv/env, and consumes only status JSON", async () => {
    const { service, spawnOptions, stderrRead } = subprocessFor(capture('{"ok":true,"status":200}\n'));
    const result = await uploadSession(service, config, payload);
    const options = spawnOptions[0] as {
      argv: string[];
      cwd: string;
      stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
      graceMs: number;
      env?: unknown;
    };
    const separator = options.stdio.stdin.data.indexOf("\n");
    const input = JSON.parse(options.stdio.stdin.data.slice(0, separator)) as Record<string, unknown>;
    const payloadJson = options.stdio.stdin.data.slice(separator + 1);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(options.argv).toEqual(["C:\\Program Files\\nodejs\\node.exe", "-e", UPLOADER_CODE]);
    expect(options.cwd).toBe(config.workerCwd);
    expect(options).not.toHaveProperty("env");
    expect(JSON.stringify(options.argv)).not.toContain(secretToken);
    expect(JSON.stringify(options.argv)).not.toContain("secret conversation text");
    expect(input).toEqual({ baseUrl: config.baseUrl, token: secretToken, timeoutMs: config.timeoutMs });
    expect(payloadJson).toBe(JSON.stringify(payload));
    expect(payloadJson).not.toContain(secretToken);
    expect(options.stdio.stdout.maxBytes).toBe(65_536);
    expect(options.stdio.stderr.maxBytes).toBe(65_536);
    expect(options.graceMs).toBe(3_000);
    expect(stderrRead).not.toHaveBeenCalled();
    expect(MAX_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
    expect(() => new Function(UPLOADER_CODE)).not.toThrow();
    expect(UPLOADER_CODE).toContain('method: "PUT"');
    expect(UPLOADER_CODE).toContain('"/v1/sessions"');
    expect(UPLOADER_CODE).toContain("body: payloadJson");
    expect(UPLOADER_CODE).not.toContain("JSON.stringify(payload");
    expect(UPLOADER_CODE).not.toMatch(/response\.(?:text|json|arrayBuffer)\s*\(/);
    expect(UPLOADER_CODE).not.toContain("process.stderr");
    expect(UPLOADER_CODE).not.toContain("console.");
  });

  it("rejects raw payloads over the byte limit before starting a worker", async () => {
    const oversizedPayload: DshHubSession = {
      ...payload,
      messages: [{ role: "event", raw: { opaque: "é".repeat(Math.ceil(MAX_PAYLOAD_BYTES / 2)) } }],
    };
    const { service, spawnOptions } = subprocessFor(capture('{"ok":true,"status":200}'));

    await expect(uploadSession(service, config, oversizedPayload))
      .rejects.toMatchObject({ code: "payload_too_large", retryable: false });
    expect(service.resolveExecutable).not.toHaveBeenCalled();
    expect(spawnOptions).toEqual([]);
  });

  it("treats lossy or spilled stdout as a protocol failure", async () => {
    const lossy = subprocessFor(capture('{"ok":true,"status":200}', { lossy: true }));
    await expect(uploadSession(lossy.service, config, payload))
      .rejects.toMatchObject({ code: "worker_output" });

    const spilled = subprocessFor(capture('{"ok":true,"status":200}', { spillPath: "temporary-output" }));
    await expect(uploadSession(spilled.service, config, payload))
      .rejects.toMatchObject({ code: "worker_output" });
  });

  it("classifies HTTP errors without retaining body text", async () => {
    const { service } = subprocessFor(capture('{"ok":false,"status":401}\n'));
    let caught: unknown;
    try {
      await uploadSession(service, config, payload);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UploadError);
    expect(caught).toMatchObject({ code: "http_rejected", status: 401, retryable: false });
    expect((caught as Error).message).not.toContain(secretToken);
    expect((caught as Error).message).not.toContain("secret conversation text");
  });

  it("rejects stdout containing anything beyond the status contract", async () => {
    const { service } = subprocessFor(capture('{"ok":true,"status":200,"body":"private"}\n'));
    await expect(uploadSession(service, config, payload))
      .rejects.toMatchObject({ code: "worker_output" });
  });

  it("classifies nonzero worker exits without exposing captured stderr", async () => {
    const { service, stderrRead } = subprocessFor(capture(""), 1);
    await expect(uploadSession(service, config, payload))
      .rejects.toMatchObject({ code: "worker_exit", retryable: true });
    expect(stderrRead).not.toHaveBeenCalled();
  });
});

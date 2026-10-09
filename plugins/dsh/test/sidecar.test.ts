import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbsoluteWorkerCwd } from "../src/config.js";
import { SIDECAR_CODE, runSidecar, sidecarMain } from "../src/sidecar.js";
import type { DshSubprocessService, SubprocessCapturedOutput } from "../src/types.js";

const secretToken = "secret-test-token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureSidecarRun(input: string): string[] {
  const output: string[] = [];
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    (async function* () { yield Buffer.from(input); })() as unknown as typeof process.stdin,
  );
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return output;
}

function parseStatus(output: string[]): { ok: boolean; text?: string; category?: string } {
  return JSON.parse(output.join("").trim()) as { ok: boolean; text?: string; category?: string };
}

function capture(text: string, overrides: Partial<SubprocessCapturedOutput> = {}): SubprocessCapturedOutput {
  return { text, nextOffset: text.length, lossy: false, ...overrides };
}

function subprocessFor(
  output: SubprocessCapturedOutput,
  exitCode = 0,
): { service: DshSubprocessService; spawnOptions: unknown[] } {
  const spawnOptions: unknown[] = [];
  const service: DshSubprocessService = {
    resolveExecutable: vi.fn(async () => "C:\\Program Files\\nodejs\\node.exe"),
    spawn: vi.fn((options) => {
      spawnOptions.push(options);
      return {
        done: Promise.resolve({ exitCode }),
        collected: {
          stdout: { readFrom: vi.fn(() => output) },
          stderr: { readFrom: vi.fn(() => capture("")) },
        },
      };
    }),
  };
  return { service, spawnOptions };
}

describe("sidecarMain probe", () => {
  it("answers a hostname probe with a single status object", async () => {
    const output = captureSidecarRun(JSON.stringify({ op: "hostname" }));
    await sidecarMain();

    const parsed = parseStatus(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.text!.length).toBeGreaterThan(0);
  });

  it("resolves an absolute home directory for the shared config path", async () => {
    const output = captureSidecarRun(JSON.stringify({ op: "home" }));
    await sidecarMain();

    const parsed = parseStatus(output);
    expect(parsed.ok).toBe(true);
    expect(isAbsoluteWorkerCwd(parsed.text!)).toBe(true);
  });

  it("reads a text file handed over on stdin", async () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const expected = readFileSync(testFilePath, "utf8");
    const output = captureSidecarRun(JSON.stringify({ op: "read-text", path: testFilePath, expandHome: false }));
    await sidecarMain();

    expect(parseStatus(output)).toEqual({ ok: true, text: expected });
  });

  it("expands a tilde path against the home directory", async () => {
    const sharedConfigPath = join(homedir(), ".config", "session-hub", "config.json");
    const output = captureSidecarRun(JSON.stringify({
      op: "read-text",
      path: "~/.config/session-hub/config.json",
      expandHome: true,
    }));
    await sidecarMain();

    const parsed = parseStatus(output);
    if (existsSync(sharedConfigPath)) {
      expect(parsed.ok).toBe(true);
      expect(parsed.text!.length).toBe(readFileSync(sharedConfigPath, "utf8").length);
    } else {
      expect(parsed).toEqual({ ok: false, category: "sidecar_failed" });
    }
  });

  it("reports failures and unknown operations as categories without leaking paths", async () => {
    const missing = captureSidecarRun(JSON.stringify({ op: "read-text", path: "C:\\definitely\\missing.json", expandHome: false }));
    await sidecarMain();
    expect(parseStatus(missing)).toEqual({ ok: false, category: "sidecar_failed" });

    const unknown = captureSidecarRun(JSON.stringify({ op: "delete-everything" }));
    await sidecarMain();
    expect(parseStatus(unknown)).toEqual({ ok: false, category: "sidecar_bad_request" });
  });

  it("generates self-contained code that parses without referencing module scope", () => {
    expect(() => new Function(`return ${SIDECAR_CODE}`)).not.toThrow();
    expect(SIDECAR_CODE).toContain("node:os");
    expect(SIDECAR_CODE).toContain("node:fs");
    expect(SIDECAR_CODE).toContain("hostname");
    expect(SIDECAR_CODE).not.toContain("console.");
    expect(SIDECAR_CODE).not.toContain("process.stderr");
    expect(SIDECAR_CODE).not.toContain("__require");
  });
});

describe("runSidecar", () => {
  it("keeps the request on stdin and returns only the parsed text", async () => {
    const { service, spawnOptions } = subprocessFor(capture('{"ok":true,"text":"WORKSTATION-B"}\n'));
    const result = await runSidecar(service, { op: "hostname" }, "C:\\work");

    expect(result).toEqual({ ok: true, text: "WORKSTATION-B", category: "ok" });
    const options = spawnOptions[0] as {
      argv: string[];
      cwd?: string;
      stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
      graceMs: number;
      env?: unknown;
    };
    expect(options.argv).toEqual(["C:\\Program Files\\nodejs\\node.exe", "-e", SIDECAR_CODE]);
    expect(options.cwd).toBe("C:\\work");
    expect(options).not.toHaveProperty("env");
    expect(JSON.parse(options.stdio.stdin.data)).toEqual({ op: "hostname" });
    expect(JSON.stringify(options.argv)).not.toContain(secretToken);
    expect(options.stdio.stdout.maxBytes).toBe(262_144);
    expect(options.stdio.stderr.maxBytes).toBe(8_192);
    expect(options.graceMs).toBe(3_000);
  });

  it("carries the shared config path on stdin rather than in argv", async () => {
    const { service, spawnOptions } = subprocessFor(capture('{"ok":true,"text":"{}"}'));
    await runSidecar(service, { op: "read-text", path: "~/.config/session-hub/config.json", expandHome: true }, undefined);

    const options = spawnOptions[0] as { argv: string[]; cwd?: string; stdio: { stdin: { data: string } } };
    expect(JSON.parse(options.stdio.stdin.data)).toEqual({
      op: "read-text",
      path: "~/.config/session-hub/config.json",
      expandHome: true,
    });
    expect(options.argv.join(" ")).not.toContain("session-hub/config.json");
    expect(options).not.toHaveProperty("cwd");
  });

  it("surfaces the sidecar category and refuses output that breaks the protocol", async () => {
    const category = subprocessFor(capture('{"ok":false,"category":"sidecar_failed"}\n'));
    expect(await runSidecar(category.service, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_failed" });

    const noisy = subprocessFor(capture('{"ok":true,"text":"x","status":200}\n'));
    expect(await runSidecar(noisy.service, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_output" });

    const lossy = subprocessFor(capture('{"ok":true,"text":"x"}', { lossy: true }));
    expect(await runSidecar(lossy.service, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_output" });
  });

  it("classifies start and exit failures without throwing", async () => {
    const { service: failing, spawnOptions } = subprocessFor(capture('{"ok":true,"text":"x"}'), 1);
    expect(await runSidecar(failing, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_exit" });
    expect(spawnOptions).toHaveLength(1);

    const unresolvable: DshSubprocessService = {
      resolveExecutable: async () => { throw new Error("node missing"); },
      spawn: () => { throw new Error("unused"); },
    };
    expect(await runSidecar(unresolvable, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_start" });

    const unspawnable: DshSubprocessService = {
      resolveExecutable: async () => "node",
      spawn: () => { throw new Error("spawn EPERM"); },
    };
    expect(await runSidecar(unspawnable, { op: "home" }, undefined))
      .toEqual({ ok: false, text: "", category: "sidecar_start" });
  });
});

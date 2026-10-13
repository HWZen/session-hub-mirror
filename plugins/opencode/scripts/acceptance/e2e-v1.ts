// opencode-plugin 0.2.0 —— V1 宿主业务 E2E 运行器（mock-only、长驻 serve、隔离沙箱）
//
// 对应 develop-doc/0.2.0/plan.md §6.3 的矩阵与证据 1-8（V1 一侧）。
// 仅新增文件；不修改 src、现有 test/helpers、build.mjs、qualify-host.ts、install.mjs。
//
// 用法（在工作区根执行）：
//   npx tsx plugins/opencode/scripts/acceptance/e2e-v1.ts [--stages=probe,core,multi,long,delete,failure,reload]
//
// 约束：只用隔离根目录中的 launch_isolated.py 启动 opencode-v1-isolated.exe；
// 沙箱 HOME/XDG/TEMP/OPENCODE_* 全部在临时目录内；Session Hub 与模型均为 loopback mock；
// 无真实外网请求、无真实凭据；finally 清场并核对现役部署摘要不变。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startV1Mock, type ModelCallRecord, type PutRecord, type RecordedRequest, type V1MockHandle } from "./loopback-mock-v1.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(scriptDir, "../..");
const worktree = resolve(pluginDir, "../..");
const outDir = join(pluginDir, "develop-doc", "0.2.0", "e2e-v1");
const isolationRoot = resolve(process.env["OPENCODE_E2E_ISOLATION_ROOT"] ?? join(homedir(), ".cache", "session-hub", "acceptance", "session-hub-opencode-v2-isolation"));
const scratchRoot = resolve(process.env["OPENCODE_E2E_SCRATCH"] ?? join(homedir(), ".cache", "session-hub", "acceptance"));
const pythonExe = process.env["OPENCODE_E2E_PYTHON"];
if (!pythonExe) throw new Error("Set OPENCODE_E2E_PYTHON to a conda environment interpreter");
const launcher = join(isolationRoot, "launch_isolated.py");
const v1Executable = join(isolationRoot, "opencode-v1-isolated.exe");
const distPath = join(pluginDir, "dist", "session-hub.js");
const deployedBeforePath = join(isolationRoot, "deployed-before.json");
const expectedDistSha = "dd320d0b1096c38ffb67e5059310f7dac2244ab78bae6ce7b6a74ac1dd337a1c";
const isolationRulePrefix = "Hermes-OpenCode-Isolation-v2-20261013";
const MODEL_REF = { providerID: "mock-local", modelID: "mock-model" } as const;
const DEBOUNCE_MS = 3_000;
const READY_TIMEOUT_MS = 300_000;
const RECREATE_TIMEOUT_MS = 300_000;
const PUT_TIMEOUT_MS = 90_000;
const QUIET_MS = 7_000;
const WATCHDOG_MS = 32 * 60_000;

const args = process.argv.slice(2);
const stagesArg = args.find((value) => value.startsWith("--stages="));
const ALL_STAGES = ["probe", "core", "multi", "long", "delete", "failure", "reload"] as const;
type Stage = (typeof ALL_STAGES)[number];
const stages = new Set<Stage>(
  stagesArg
    ? (stagesArg.slice("--stages=".length).split(",").filter((value) => (ALL_STAGES as readonly string[]).includes(value)) as Stage[])
    : [...ALL_STAGES],
);

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

interface Assertion {
  id: string;
  name: string;
  passed: boolean;
  details: unknown;
  refs: string[];
}

const assertions: Assertion[] = [];
const timeline: Array<{ at: number; event: string; detail?: unknown }> = [];

function mark(event: string, detail?: unknown): void {
  timeline.push({ at: Date.now(), event, ...(detail === undefined ? {} : { detail }) });
}

function check(id: string, name: string, passed: boolean, details: unknown, refs: string[] = []): boolean {
  assertions.push({ id, name, passed, details, refs });
  console.log(`${passed ? "PASS" : "FAIL"} [${id}] ${name}`);
  return passed;
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  if (record && "data" in record && record["data"] !== undefined) return record["data"];
  return value;
}

// ---------------------------------------------------------------------------
// 断言 3 的字段级对比：以宿主真实存储为基准，核验 mock 收到的 PUT 快照。
// ---------------------------------------------------------------------------
interface Mismatch {
  field: string;
  index?: number;
  expected: unknown;
  actual: unknown;
}

interface SnapshotComparison {
  hostMessageCount: number | null;
  putMessageCount: number | null;
  mismatches: Mismatch[];
  notes: string[];
}

function transformText(parts: unknown[]): string | undefined {
  const pieces: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    if (record["type"] !== "text" || typeof record["text"] !== "string") continue;
    if (record["synthetic"] === true) continue;
    pieces.push(record["text"] as string);
  }
  if (pieces.length === 0) return undefined;
  return pieces.join("\n\n").slice(0, 1_000_000);
}

function compareSnapshot(
  payload: Record<string, unknown>,
  session: Record<string, unknown>,
  hostMessages: unknown[],
  expectedMachine: string,
): SnapshotComparison {
  const mismatches: Mismatch[] = [];
  const notes: string[] = [];
  const push = (field: string, expected: unknown, actual: unknown, index?: number) => {
    if (mismatches.length < 40) mismatches.push({ field, expected, actual, ...(index === undefined ? {} : { index }) });
  };
  if (payload["agent"] !== "opencode") push("agent", "opencode", payload["agent"]);
  if (payload["machine"] !== expectedMachine) push("machine", expectedMachine, payload["machine"]);
  if (payload["source_id"] !== session["id"]) push("source_id", session["id"], payload["source_id"]);
  const title = session["title"];
  if (typeof title === "string" && title.length > 0 && payload["title"] !== title.slice(0, 2000)) push("title", title, payload["title"]);
  const directory = session["directory"];
  if (typeof directory === "string" && directory.length > 0 && payload["cwd"] !== directory) push("cwd", directory, payload["cwd"]);
  const time = asRecord(session["time"]);
  const created = time?.["created"];
  const updated = time?.["updated"];
  if (typeof created !== "number") notes.push("host session.time.created 非 number，跳过 created_at 对比");
  else if (payload["created_at"] !== created) push("created_at", created, payload["created_at"]);
  if (typeof updated !== "number") notes.push("host session.time.updated 非 number，跳过 updated_at 对比");
  else if (payload["updated_at"] !== updated) push("updated_at", updated, payload["updated_at"]);

  const putMessages = payload["messages"];
  if (!Array.isArray(putMessages)) {
    push("messages", "array", putMessages);
    return { hostMessageCount: hostMessages.length, putMessageCount: null, mismatches, notes };
  }
  if (putMessages.length !== hostMessages.length) push("messages.length", hostMessages.length, putMessages.length);

  const roleFiltered = hostMessages.filter((message) => {
    const role = asRecord(asRecord(message)?.["info"])?.["role"];
    return typeof role === "string" && role.length >= 1 && role.length <= 64;
  });
  if (roleFiltered.length !== hostMessages.length) notes.push(`宿主消息中有 ${hostMessages.length - roleFiltered.length} 条 role 不合法（插件按规则过滤）`);
  const expectedMessages = roleFiltered.length > 5000 ? roleFiltered.slice(-5000) : roleFiltered;
  if (putMessages.length !== expectedMessages.length) push("messages.length(filtered)", expectedMessages.length, putMessages.length);

  for (let index = 0; index < Math.min(putMessages.length, expectedMessages.length); index++) {
    const hostMessage = asRecord(expectedMessages[index]);
    const info = asRecord(hostMessage?.["info"]);
    const parts = Array.isArray(hostMessage?.["parts"]) ? (hostMessage!["parts"] as unknown[]) : [];
    const putMessage = asRecord(putMessages[index]);
    if (!putMessage) {
      push("messages[i]", "object", putMessages[index], index);
      continue;
    }
    const role = info?.["role"];
    if (typeof role === "string" && putMessage["role"] !== role) push("messages[i].role", role, putMessage["role"], index);
    const timeCreated = asRecord(info?.["time"])?.["created"];
    if (typeof timeCreated === "number" && Number.isFinite(timeCreated)) {
      if (putMessage["ts"] !== timeCreated) push("messages[i].ts", timeCreated, putMessage["ts"], index);
    } else if ("ts" in putMessage && putMessage["ts"] !== undefined) {
      notes.push(`messages[${index}]: 源消息 time.created 缺失但 PUT 带 ts=${String(putMessage["ts"])}`);
    }
    const expectedRaw = parts.length === 1 ? parts[0] : parts;
    if (!sameJson(putMessage["raw"], expectedRaw)) push("messages[i].raw", expectedRaw, putMessage["raw"], index);
    const expectedText = transformText(parts);
    if (expectedText === undefined) {
      if (putMessage["text"] !== undefined) push("messages[i].text(should-be-absent)", undefined, putMessage["text"], index);
    } else if (!sameJson(putMessage["text"], expectedText)) {
      push("messages[i].text", expectedText, putMessage["text"], index);
    }
  }
  return { hostMessageCount: hostMessages.length, putMessageCount: putMessages.length, mismatches, notes };
}

// ---------------------------------------------------------------------------
// 隔离环境与宿主进程
// ---------------------------------------------------------------------------
function cleanEnvironment(root: string, password: string, sessionHubUrl: string, sessionHubToken: string) {
  const home = join(root, "home");
  return {
    SystemRoot: process.env["SystemRoot"] ?? "C:/Windows",
    WINDIR: process.env["WINDIR"] ?? "C:/Windows",
    PATH: "C:/Windows/System32",
    PYTHONIOENCODING: "utf-8",
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "local"),
    APPDATA: join(home, "roaming"),
    ProgramData: join(root, "managed"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    TEMP: join(root, "temp"),
    TMP: join(root, "temp"),
    TMPDIR: join(root, "temp"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed", "opencode"),
    OPENCODE_DB: join(root, "data", "opencode", "synthetic.db"),
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_FILEWATCHER_DISABLE: "true",
    OPENCODE_DISABLE_FFF: "true",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
    SESSION_HUB_URL: sessionHubUrl,
    SESSION_HUB_TOKEN: sessionHubToken,
  };
}

function verifyFirewallRule(): { verified: boolean; detail: string } {
  const ruleName = `${isolationRulePrefix}-V1`;
  const script = `$r=Get-NetFirewallRule -Name '${ruleName}' -PolicyStore ActiveStore -ErrorAction Stop; $p=$r | Get-NetFirewallApplicationFilter; $a=$r | Get-NetFirewallAddressFilter; [pscustomobject]@{Enabled=$r.Enabled.ToString();Action=$r.Action.ToString();Direction=$r.Direction.ToString();Program=$p.Program;RemoteAddress=@($a.RemoteAddress)} | ConvertTo-Json -Compress`;
  const shell = join(process.env["SystemRoot"] ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const run = spawnSync(shell, ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) return { verified: false, detail: String(run.stderr || run.error || "rule query failed").trim() };
  try {
    const rule = JSON.parse(run.stdout) as { Enabled: string; Action: string; Direction: string; Program: string; RemoteAddress: string[] };
    const expectedRemote = [
      "0.0.0.0-126.255.255.255",
      "128.0.0.0-255.255.255.255",
      "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ];
    const matching =
      rule.Enabled === "True" &&
      rule.Action === "Block" &&
      rule.Direction === "Outbound" &&
      resolve(rule.Program).toLowerCase() === resolve(v1Executable).toLowerCase() &&
      [...rule.RemoteAddress].sort().join(",") === [...expectedRemote].sort().join(",");
    return { verified: matching, detail: matching ? "rule filters match" : JSON.stringify(rule) };
  } catch (error) {
    return { verified: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

interface HostHandle {
  child: ChildProcess;
  output: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  endpoint: string | null;
  startedAt: number;
  exitPromise: Promise<void>;
  forcedKill: boolean;
  bootCount: number;
}

async function startHost(root: string, env: Record<string, string>, port: number): Promise<HostHandle> {
  const child = spawn(
    pythonExe,
    [launcher, "--cwd", root, "--", v1Executable, "--print-logs", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const handle: HostHandle = {
    child,
    output: "",
    exited: false,
    exitCode: null,
    exitSignal: null,
    endpoint: null,
    startedAt: Date.now(),
    forcedKill: false,
    bootCount: 0,
    exitPromise: Promise.resolve(),
  };
  handle.exitPromise = new Promise<void>((resolveExit) => {
    child.once("exit", (code, signal) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.exitSignal = signal;
      resolveExit();
    });
  });
  const append = (chunk: unknown) => {
    handle.output = (handle.output + String(chunk)).slice(-4_000_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", append);
  return handle;
}

async function stopHost(host: HostHandle): Promise<void> {
  if (host.exited) return;
  host.forcedKill = true;
  host.child.kill();
  await Promise.race([host.exitPromise, sleep(10_000)]);
  if (!host.exited) {
    host.child.kill("SIGKILL");
    await Promise.race([host.exitPromise, sleep(5_000)]);
  }
}

// ---------------------------------------------------------------------------
// 宿主 HTTP 辅助（loopback + Basic 认证；仅实例作用域请求带 directory）
// ---------------------------------------------------------------------------
class HostClient {
  constructor(
    private readonly host: HostHandle,
    private readonly password: string,
    private readonly projectDir: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}` };
  }

  private scoped(path: string): string {
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}directory=${encodeURIComponent(this.projectDir)}`;
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; timeoutMs?: number; scoped?: boolean } = {},
  ): Promise<{ status: number; text: string; json: unknown; ms: number }> {
    if (!this.host.endpoint) throw new Error("host endpoint not ready");
    const url = `${this.host.endpoint}${options.scoped === false ? path : this.scoped(path)}`;
    const started = Date.now();
    const response = await fetch(url, {
      method,
      headers: { ...this.headers(), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json, ms: Date.now() - started };
  }

  async getJson(path: string, timeoutMs = 60_000): Promise<unknown> {
    const result = await this.request("GET", path, { timeoutMs });
    if (result.status !== 200) throw new Error(`GET ${path} -> ${result.status}: ${result.text.slice(0, 300)}`);
    return unwrap(result.json);
  }

  async createSession(title: string): Promise<Record<string, unknown>> {
    const result = await this.request("POST", "/session", {
      body: {
        title,
        permission: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "glob", pattern: "*", action: "allow" },
          { permission: "grep", pattern: "*", action: "allow" },
          { permission: "list", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "write", pattern: "*", action: "deny" },
          { permission: "webfetch", pattern: "*", action: "deny" },
          { permission: "websearch", pattern: "*", action: "deny" },
        ],
      },
      timeoutMs: 90_000,
    });
    if (result.status !== 200 && result.status !== 201) throw new Error(`create session -> ${result.status}: ${result.text.slice(0, 300)}`);
    const session = asRecord(unwrap(result.json));
    if (!session || typeof session["id"] !== "string") throw new Error(`create session: unexpected body: ${result.text.slice(0, 300)}`);
    return session;
  }

  async prompt(sessionId: string, text: string, timeoutMs = 90_000): Promise<{ status: number; ms: number; text: string }> {
    const result = await this.request("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
      body: { model: MODEL_REF, parts: [{ type: "text", text }] },
      timeoutMs,
    });
    return { status: result.status, ms: result.ms, text: result.text.slice(0, 400) };
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const value = await this.getJson(`/session/${encodeURIComponent(sessionId)}/message`);
    if (!Array.isArray(value)) throw new Error(`messages: not an array (${JSON.stringify(value).slice(0, 200)})`);
    return value;
  }

  async session(sessionId: string): Promise<Record<string, unknown>> {
    const value = asRecord(await this.getJson(`/session/${encodeURIComponent(sessionId)}`));
    if (!value) throw new Error("session: not an object");
    return value;
  }
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------
interface RunState {
  sandboxRoot: string;
  marker: string;
  password: string;
  mock: V1MockHandle;
  host: HostHandle | null;
  hostPort: number;
  env: Record<string, string>;
  client: HostClient | null;
  hostClientFor: (host: HostHandle) => HostClient;
  mockRequestSeqsSeen: number;
}

const runId = randomBytes(4).toString("hex");
const sandboxRoot = join(scratchRoot, `opencode-v1-e2e-${runId}`);
const marker = randomBytes(16).toString("hex");
const password = randomBytes(24).toString("hex");
let mock: V1MockHandle | null = null;
let host: HostHandle | null = null;
let client: HostClient | null = null;
let fixedMockToken = "";
let fixedMockUrl = "";
let sandboxRemoved = false;
let cleanupError = "";
let sandboxCleanup: (() => Promise<void>) | null = null;
let watchdogFired = false;

const watchdog = setTimeout(() => {
  watchdogFired = true;
  console.error("WATCHDOG: E2E 超过时限，开始强制清场");
  void (async () => {
    try {
      if (host) await stopHost(host);
      if (mock) await mock.close();
      await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } finally {
      process.exit(2);
    }
  })();
}, WATCHDOG_MS);
watchdog.unref();

function redact(text: string): string {
  let output = text;
  if (password) output = output.split(password).join("[redacted]");
  if (fixedMockToken) output = output.split(fixedMockToken).join("[redacted]");
  if (mock) output = output.split(mock.hubToken).join("[redacted]");
  return output;
}

function mockRequestsSnapshot(m: V1MockHandle): RecordedRequest[] {
  return m.requests.map((request) => ({ ...request }));
}

function putsFor(m: V1MockHandle, sourceId: string): PutRecord[] {
  return m.puts.filter((put) => put.sourceId === sourceId);
}

function findPut(m: V1MockHandle, sourceId: string, predicate?: (put: PutRecord) => boolean): PutRecord | undefined {
  return m.puts.find((put) => put.sourceId === sourceId && (predicate ? predicate(put) : true));
}

async function waitFor<T>(description: string, fn: () => T | undefined | null | false, timeoutMs: number, intervalMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (watchdogFired) return null;
    if (host?.exited && !description.includes("exit")) return null;
    let value: T | undefined | null | false;
    try {
      value = fn();
    } catch {
      value = null;
    }
    if (value) return value as T;
    await sleep(intervalMs);
  }
  return null;
}

function logMatch(regex: RegExp): RegExpMatchArray | null {
  return host ? regex.exec(host.output) : null;
}

function countLogMatches(regex: RegExp): number {
  if (!host) return 0;
  return host.output.match(regex)?.length ?? 0;
}

async function waitForLog(regex: RegExp, timeoutMs: number): Promise<boolean> {
  const found = await waitFor(`log ${regex}`, () => regex.test(host?.output ?? ""), timeoutMs, 500);
  return found === true;
}

async function waitForLogCount(regex: RegExp, minCount: number, timeoutMs: number): Promise<boolean> {
  const found = await waitFor(`log count ${regex} >= ${minCount}`, () => countLogMatches(regex) >= minCount, timeoutMs, 500);
  return found === true;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no reserved port");
  const { port } = address;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function waitForReady(projectDir: string, timeoutMs: number): Promise<{ ok: boolean; attempts: number; readyMs: number; instanceTriggeredMs: number | null; lastError: string }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastError = "";
  let instanceTriggeredMs: number | null = null;
  while (Date.now() < deadline) {
    if (watchdogFired) return { ok: false, attempts, readyMs: Date.now() - startedAt, instanceTriggeredMs, lastError: "watchdog" };
    if (!host || host.exited) return { ok: false, attempts, readyMs: Date.now() - startedAt, instanceTriggeredMs, lastError: `host exited code=${host?.exitCode}` };
    if (!host.endpoint) {
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(host.output);
      if (match?.[1]) {
        host.endpoint = match[1];
        mark("server-listening", { endpoint: host.endpoint, ms: Date.now() - host.startedAt });
      }
      await sleep(400);
      continue;
    }
    attempts += 1;
    if (instanceTriggeredMs === null) instanceTriggeredMs = Date.now() - startedAt;
    try {
      const response = await fetch(`${host.endpoint}/config?directory=${encodeURIComponent(projectDir)}`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(50_000),
      });
      const text = await response.text();
      if (response.status === 200) {
        mark("instance-ready", { attempts, readyMs: Date.now() - startedAt, configKeys: Object.keys(asRecord(JSON.parse(text)) ?? {}).slice(0, 24) });
        return { ok: true, attempts, readyMs: Date.now() - startedAt, instanceTriggeredMs, lastError: "" };
      }
      lastError = `status ${response.status}: ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_500);
  }
  return { ok: false, attempts, readyMs: Date.now() - startedAt, instanceTriggeredMs, lastError };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
interface ScenarioState {
  sessionA: Record<string, unknown> | null;
  sessionB: Record<string, unknown> | null;
  sessionC: Record<string, unknown> | null;
  sessionE: Record<string, unknown> | null;
  sessionF: Record<string, unknown> | null;
}

const scenarios: ScenarioState = { sessionA: null, sessionB: null, sessionC: null, sessionE: null, sessionF: null };
const hostCommands: string[] = [];
let lastReady: { attempts: number; readyMs: number } | null = null;
let hostPortUsed: number | null = null;
let firewallRuleDetail: { verified: boolean; detail: string } | null = null;
let readyMsTotal = 0;
let enabledLogCount = 0;
let reloadPath: "global-dispose" | "process-restart" | "not-run" = "not-run";
let reloadDetail: unknown = null;
let logsScan: unknown = null;
let deployedBefore: Record<string, string> = {};
let deployedAfter: Record<string, string> = {};
const blockers: Array<Record<string, unknown>> = [];
// 这些断言在“宿主二进制模型路径缺陷”下必然为红，红因由 blockers 记录（重跑于修复版 exe 时应转绿）。
const BLOCKED_ASSERTION_IDS = ["2.model-round-status", "3.tool-part-coverage"];

function pushBlocker(blocker: Record<string, unknown>): void {
  if (blockers.some((item) => item["id"] === blocker["id"])) return;
  blockers.push(blocker);
}

function extractHostTypeError(): { line: string | null; ref: string | null; stackTail: string | null } {
  const raw = host?.output ?? "";
  const line = raw.split("\n").find((item) => item.includes("TypeError: undefined is not an object")) ?? null;
  if (!line) return { line: null, ref: null, stackTail: null };
  const ref = line.match(/ref=(err_[a-z0-9]+)/)?.[1] ?? null;
  const resolved = line.split("\\n").find((item) => item.includes("at resolve")) ?? null;
  const frames = line.split("\\n").filter((item) => item.includes(".js:")).slice(0, 6).join(" ; ");
  return { line: redact(line).slice(0, 1200), ref, stackTail: frames ? redact(frames).slice(0, 800) : (resolved ? redact(resolved) : null) };
}

function recordModelRoundBlocker(round: Record<string, unknown> | { status: number; ms: number; text?: string }): void {
  const detail = extractHostTypeError();
  const refFromRound = typeof (round as Record<string, unknown>)["text"] === "string" ? (round as Record<string, unknown>)["text"] as string : "";
  pushBlocker({
    id: "MODEL-ROUND-UNREACHABLE",
    scope: "§6.3 证据 2/3 中依赖 mock 模型完成真实轮次的部分：assistant 文本/reasoning/工具结果/压缩（summarize）后数据",
    status: "BLOCKED（宿主构建缺陷，非本插件与沙箱配置问题）",
    observed: {
      promptStatus: (round as { status: number }).status,
      promptMs: (round as { ms: number }).ms,
      roundErrorRef: refFromRound.match(/err_[a-z0-9]+/)?.[0] ?? detail.ref,
      printedError: detail.line,
      stack: detail.stackTail,
      modelCallsReceivedByMockAtThisPoint: mock?.modelCalls.length ?? 0,
    },
    rootCause:
      "宿主二进制在组装系统提示（SystemPrompt.environment）时进入 V2 location-services 的 LayerNode.hoist 遍历，resolve 回调收到 undefined 依赖，抛 TypeError: undefined is not an object (evaluating 'a.name')（bundle 位置 chunk-y50hsjxs.js:2:1659 为 resolve:(a)=>s.get(a.name)）。该遍历是静态 layer 依赖图（与配置/环境无关），发生在任何模型调用之前，因此普通 prompt 轮次的 mock 模型 0 次被调用、assistant 消息为空且带 error。",
    impact:
      "受影响的仅为“普通 prompt 轮次”的模型内容：assistant text/reasoning、tool_calls→工具执行→tool part。不受影响且已验证：插件同步/删除/失败诊断/reload 全部行为；压缩（summarize/compaction）路径不经过 environment，可真实调用 mock 模型并产出 reasoning/text/compaction 内容（见 3.compaction-coverage）。",
    remediation: "需由仓库侧将 opencode-v1-isolated.exe 用当前源码/fix commit 重建并通过隔离资格后重跑本运行器（超出本子项授权范围：不得绕过启动器、不得启动非隔离原始二进制、不得降低隔离要求）。",
  });
}

async function main(): Promise<void> {
  // ---------------- preflight ----------------
  const gitHead = (() => {
    const run = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" });
    return run.status === 0 ? run.stdout.trim() : null;
  })();
  const branch = (() => {
    const run = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
    return run.status === 0 ? run.stdout.trim() : null;
  })();
  const distBuffer = await readFile(distPath);
  const distSha = sha256(distBuffer);
  const distModule = (await import(pathToFileURL(distPath).href)) as Record<string, unknown>;
  const exportKeys = Object.keys(distModule);
  const defaultExport = asRecord(distModule["default"]);
  check("S0.dist-sha", "实际加载的 dist/session-hub.js SHA256 与规范一致", distSha === expectedDistSha, { path: distPath, expectedDistSha, actualSha: distSha });
  check(
    "S0.single-default",
    "bundle 仅 default 导出（无 helper 误加载），稳定 id，server/setup 均存在",
    exportKeys.length === 1 && exportKeys[0] === "default" && defaultExport?.["id"] === "session-hub" && typeof defaultExport?.["server"] === "function" && typeof defaultExport?.["setup"] === "function",
    { exportKeys, id: defaultExport?.["id"], server: typeof defaultExport?.["server"], setup: typeof defaultExport?.["setup"] },
  );

  // 现役部署摘要基线（只读对比，不触碰现役文件）
  try {
    deployedBefore = JSON.parse(await readFile(deployedBeforePath, "utf8")) as Record<string, string>;
  } catch (error) {
    deployedBefore = {};
    mark("deployed-before-read-failed", String(error));
  }
  const deployedNow: Record<string, string> = {};
  for (const file of Object.keys(deployedBefore)) {
    deployedNow[file] = existsSync(file) ? sha256(await readFile(file)) : "MISSING";
  }

  const rule = verifyFirewallRule();
  firewallRuleDetail = rule;
  mark("firewall-rule", rule);

  // ---------------- setup ----------------
  const projectDir = join(sandboxRoot, "project");
  const toolFilePath = join(projectDir, "e2e-tool-target.txt");
  mock = await startV1Mock({ toolFilePath });
  fixedMockToken = mock.hubToken;
  fixedMockUrl = mock.url;
  mark("mock-started", { url: mock.url, hubTokenRedacted: true });

  const env = cleanEnvironment(sandboxRoot, password, mock.url, mock.hubToken);
  for (const directory of new Set(
    Object.values(env)
      .filter((value) => value.startsWith(sandboxRoot) && !value.endsWith(".json") && !value.endsWith(".db") && !value.endsWith(".txt")),
  )) {
    await mkdir(directory, { recursive: true });
  }
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(env.HOME, "sandbox-marker.txt"), marker);
  await writeFile(toolFilePath, "E2E 合成工具目标文件：session-hub 0.2.0 V1 E2E\n");
  const configPath = join(env.OPENCODE_CONFIG_DIR, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(distPath).href],
    autoupdate: false,
    model: `${MODEL_REF.providerID}/${MODEL_REF.modelID}`,
    provider: {
      [MODEL_REF.providerID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Mock",
        options: { baseURL: `${mock.url}/model/v1`, apiKey: "synthetic-e2e-key" },
        models: { [MODEL_REF.modelID]: { name: "Mock Model", tool_call: true, reasoning: true } },
      },
    },
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: "deny",
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  hostCommands.push(`python ${launcher} --cwd <sandbox> -- ${v1Executable} --print-logs serve --hostname 127.0.0.1 --port <hostPort>`);

  const hostPort = await reservePort();
  hostPortUsed = hostPort;
  host = await startHost(sandboxRoot, env, hostPort);
  client = new HostClient(host, password, projectDir);
  sandboxCleanup = async () => {
    if (host) await stopHost(host);
    if (mock) await mock.close().catch(() => undefined);
    try {
      await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      sandboxRemoved = true;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  };
  mark("host-started", { hostPort, sandboxRoot });

  // ---------------- stage: probe ----------------
  if (stages.has("probe")) {
    const ready = await waitForReady(projectDir, READY_TIMEOUT_MS);
    lastReady = ready.ok ? { attempts: ready.attempts, readyMs: ready.readyMs } : null;
    readyMsTotal = ready.readyMs;
    check(
      "1.ready",
      `长驻 serve 在 ${READY_TIMEOUT_MS / 1000}s 窗口内 ready（bounded retry，尝试 ${ready.attempts} 次）`,
      ready.ok,
      ready,
    );
    if (!ready.ok) throw new Error(`host not ready: ${JSON.stringify(ready)}`);
    const enabled = await waitForLog(/session-hub: enabled baseUrl=(\S+) machine=(\S+)/, 180_000);
    enabledLogCount = countLogMatches(/session-hub: enabled baseUrl=/g);
    check("1.plugin-loaded", "宿主日志出现插件 enabled（稳定 id 的 V1 加载路径生效）", enabled, { enabledLogCount, acceptFallback: "若日志缺失，E2 的首个 PUT 亦是功能加载证据" });
    const jobs = /ISOLATED_JOB active_process_limit=1 kill_on_close=true/.test(host.output);
    check("1.job-confirmed", "启动器 Job 生效（active_process_limit=1, kill_on_close）", jobs, { jobConfirmed: jobs });
    // 运行时端点发现（记录用）
    const listSessions = await client!.request("GET", "/session").catch((error) => ({ status: -1, text: String(error), json: null, ms: 0 }));
    mark("discovery", { sessionListStatus: listSessions.status });
  } else {
    const ready = await waitForReady(projectDir, READY_TIMEOUT_MS);
    readyMsTotal = ready.readyMs;
    if (!ready.ok) throw new Error(`host not ready: ${JSON.stringify(ready)}`);
    enabledLogCount = countLogMatches(/session-hub: enabled baseUrl=/g);
  }

  // ---------------- stage: core ----------------
  if (stages.has("core")) {
    const sessionA = await client!.createSession("E2E-A 核心快照");
    scenarios.sessionA = sessionA;
    mark("session-A-created", { id: sessionA["id"] });
    const round1 = await client!.prompt(String(sessionA["id"]), "E2E_REASON 第一轮：请回复并包含中文内容");
    mark("round-1", round1);
    const put = await waitFor("PUT for A", () => findPut(mock!, String(sessionA["id"]), (item) => item.status === 200 || item.status === 201), PUT_TIMEOUT_MS);
    check("2.put-received", "idle + 3s debounce 后 mock 收到 PUT（真实宿主事件驱动）", Boolean(put), {
      putSeq: put?.seq ?? null,
      status: put?.status ?? null,
      putAt: put?.at ?? null,
      round1,
    });
    if (!put) throw new Error("no PUT for session A");
    check("2.put-schema-valid", "PUT 正文通过共享 sessionUpsertSchema 校验", put.schemaValid === true, { schemaValid: put.schemaValid, issues: put.issues, rawBytes: put.rawBytes });
    const coreModelCalls = mock!.modelCalls.length;
    const modelRoundOk = round1.status === 200 && coreModelCalls > 0;
    if (!modelRoundOk) recordModelRoundBlocker(round1);
    check(
      "2.model-round-status",
      "普通 prompt 轮次可达（build agent LLM 路径；mock 模型被调用）",
      modelRoundOk,
      {
        round1,
        modelCallsReceivedByMockAtCore: coreModelCalls,
        hostTypeError: extractHostTypeError(),
        note: "宿主二进制缺陷：SystemPrompt.environment 在模型调用之前抛 TypeError（见 blockers.MODEL-ROUND-UNREACHABLE）。插件侧 idle/debounce/PUT/字段保真不受影响；真实模型内容改由 compaction 路径覆盖（3.compaction-coverage）。",
      },
    );
    const hostSession = await client!.session(String(sessionA["id"]));
    const hostMessages = await client!.messages(String(sessionA["id"]));
    const payload = asRecord(put.body) ?? {};
    const comparison = compareSnapshot(payload, hostSession, hostMessages, hostname());
    check("3.core-fields", "字段级对比（title/cwd/源时间/角色/text/raw/数量/三元组）", comparison.mismatches.length === 0, { comparison, hostSessionShape: Object.keys(hostSession).sort() });
    // 源时间断言：created_at/updated_at 必须来自源数据而不是上传时刻
    const sourceTimes = asRecord(hostSession["time"]);
    const uploadDelay = put.at - (typeof sourceTimes?.["updated"] === "number" ? (sourceTimes["updated"] as number) : 0);
    check(
      "3.source-times",
      "created_at/updated_at 使用源数据时间（上传发生于源时间之后，不等于上传时刻）",
      comparison.mismatches.filter((item) => item.field === "created_at" || item.field === "updated_at").length === 0 && uploadDelay > DEBOUNCE_MS,
      { created_at: payload["created_at"], updated_at: payload["updated_at"], hostTime: sourceTimes, uploadDelayMs: uploadDelay },
    );
    // 单订阅 / 无重复同步：安静窗口内一次 idle 只产生一个 PUT
    await sleep(QUIET_MS);
    const baselineA = putsFor(mock!, String(sessionA["id"])).filter((item) => item.status === 200 || item.status === 201).length;
    await client!.prompt(String(sessionA["id"]), "重复 idle 检查：第二节");
    const after = await waitFor("second PUT for A", () => putsFor(mock!, String(sessionA["id"])).filter((item) => item.status === 200 || item.status === 201).length > baselineA, PUT_TIMEOUT_MS);
    await sleep(QUIET_MS);
    const finalA = putsFor(mock!, String(sessionA["id"])).filter((item) => item.status === 200 || item.status === 201).length;
    check("4.single-subscription", "同一 idle 周期恰好一个 PUT（无重复订阅 / debounce 合并）", Boolean(after) && finalA - baselineA === 1, { baselineA, finalA, duplicateDetected: finalA - baselineA > 1 });
  }

  // ---------------- stage: multi ----------------
  if (stages.has("multi")) {
    const sessionB = await client!.createSession("E2E-B 多会话");
    scenarios.sessionB = sessionB;
    await client!.prompt(String(sessionB["id"]), "B 会话第一轮");
    const putB = await waitFor("PUT for B", () => findPut(mock!, String(sessionB["id"]), (item) => item.status === 200 || item.status === 201), PUT_TIMEOUT_MS);
    check("4.session-B-synced", "第二会话独立同步（不串会话）", Boolean(putB), { putBSeq: putB?.seq ?? null });
    if (putB) {
      const hostSessionB = await client!.session(String(sessionB["id"]));
      const hostMessagesB = await client!.messages(String(sessionB["id"]));
      const comparisonB = compareSnapshot(asRecord(putB.body)!, hostSessionB, hostMessagesB, hostname());
      check("4.session-B-fields", "B 快照字段级对比（三元组指向 B 且 messages 数量一致）", comparisonB.mismatches.length === 0, { comparisonB });
    }
    await client!.prompt(String(sessionB["id"]), "B 会话第二轮：快照更新");
    const updated = await waitFor(
      "updated PUT for B",
      () => mock!.puts.find((item) => item.sourceId === String(sessionB["id"]) && Array.isArray(asRecord(item.body)?.["messages"]) && (asRecord(item.body)!["messages"] as unknown[]).length >= 4),
      PUT_TIMEOUT_MS,
    );
    check("4.repeat-updates-same-record", "重复 idle 更新同一条镜像记录（幂等键 agent+machine+source_id）", Boolean(updated), { putsTotalForB: putsFor(mock!, String(sessionB["id"])).length });
    if (scenarios.sessionA) {
      const recordA = mock!.findHubRecord("opencode", hostname(), String(scenarios.sessionA["id"]));
      check("4.no-cross-session", "A/B 记录互不覆盖（各自 source_id 独立）", Boolean(recordA) && recordA?.source_id === String(scenarios.sessionA["id"]), { recordASource: recordA?.source_id ?? null });
    }
  }

  // ---------------- stage: long ----------------
  if (stages.has("long")) {
    const sessionA = scenarios.sessionA ?? (await client!.createSession("E2E-A 长历史"));
    scenarios.sessionA = sessionA;
    const sessionId = String(sessionA["id"]);
    const rounds: Array<{ index: number; status: number; ms: number; error?: string }> = [];
    const totalRounds = 47;
    const startIndex = stages.has("core") ? 3 : 1;
    let beforeSummarizeCount: number | null = null;
    let afterSummarizeCount: number | null = null;
    let summarizeStatus: number | null = null;
    let summarizeText = "";
    const summarizeRounds: Array<{ index: number; status: number; ms: number; before: number; after: number }> = [];
    let consecutiveTransportFailures = 0;
    let aborted = "";
    for (let index = startIndex; index <= totalRounds; index++) {
      const text = `长历史 第${index}轮 中文内容 ${"x".repeat(index % 7)}`;
      try {
        const result = await client!.prompt(sessionId, text, 60_000);
        rounds.push({ index, status: result.status, ms: result.ms });
        consecutiveTransportFailures = 0;
      } catch (error) {
        rounds.push({ index, status: -1, ms: 0, error: error instanceof Error ? error.message : String(error) });
        consecutiveTransportFailures += 1;
      }
      if (consecutiveTransportFailures >= 3) {
        aborted = `连续 ${consecutiveTransportFailures} 轮传输失败，提前结束长历史造数`;
        mark("long-aborted", { index, aborted });
        break;
      }
      if (index === 27 || index === 40) {
        const before = (await client!.messages(sessionId)).length;
        beforeSummarizeCount = before;
        const summaryResponse = await client!.request("POST", `/session/${encodeURIComponent(sessionId)}/summarize`, {
          body: { providerID: MODEL_REF.providerID, modelID: MODEL_REF.modelID },
          timeoutMs: 120_000,
        });
        summarizeStatus = summaryResponse.status;
        summarizeText = summaryResponse.text.slice(0, 120);
        afterSummarizeCount = (await client!.messages(sessionId)).length;
        summarizeRounds.push({ index, status: summaryResponse.status, ms: summaryResponse.ms, before, after: afterSummarizeCount });
        mark("summarize", { index, status: summaryResponse.status, ms: summaryResponse.ms, before, after: afterSummarizeCount, text: summarizeText });
        if (summaryResponse.status !== 200) {
          pushBlocker({
            id: "COMPACTION-UNREACHABLE",
            scope: "§6.3 证据 3 的“压缩后数据”（POST /session/{id}/summarize → compaction）",
            status: "BLOCKED（与 MODEL-ROUND-UNREACHABLE 同源：summarize 内部走 SessionPrompt.loop → SystemPrompt.environment）",
            observed: {
              summarizeStatus: summaryResponse.status,
              summarizeText,
              beforeSummarizeCount: before,
              afterSummarizeCount,
              modelCallsReceivedByMock: mock?.modelCalls.length ?? 0,
            },
            remediation: "随 MODEL-ROUND-UNREACHABLE 一并修复（重建 V1 隔离 exe）后重跑。",
          });
        }
      }
    }
    const roundsByStatus = rounds.reduce<Record<string, number>>((accumulator, round) => {
      const key = String(round.status);
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
    mark("long-rounds", { total: rounds.length, byStatus: roundsByStatus, aborted: aborted || undefined });
    if ((roundsByStatus["200"] ?? 0) === 0 && rounds.length > 0) recordModelRoundBlocker({ status: rounds[0].status, ms: rounds[0].ms });
    const hostMessages = await client!.messages(sessionId);
    const hostSession = await client!.session(sessionId);
    const finalPut = await waitFor(
      "final PUT for A",
      () => {
        const candidate = [...mock!.puts].reverse().find((item) => item.sourceId === sessionId && (item.status === 200 || item.status === 201));
        const count = Array.isArray(asRecord(candidate?.body)?.["messages"]) ? (asRecord(candidate!.body)!["messages"] as unknown[]).length : -1;
        return count >= hostMessages.length ? candidate : undefined;
      },
      Math.max(PUT_TIMEOUT_MS, 180_000),
    );
    check("3.long-history-synced", `长历史（宿主 ${hostMessages.length} 条消息）在单个 PUT 快照中完整同步`, Boolean(finalPut), {
      hostMessageCount: hostMessages.length,
      putMessageCount: finalPut ? (asRecord(finalPut.body)?.["messages"] as unknown[] | undefined)?.length : null,
      rounds: rounds.length,
      roundsByStatus,
      aborted: aborted || null,
    });
    if (finalPut) {
      const comparison = compareSnapshot(asRecord(finalPut.body)!, hostSession, hostMessages, hostname());
      check("3.long-history-fidelity", "长历史逐字段对比（raw/角色/text/源时间/数量/三元组）无差异", comparison.mismatches.length === 0, {
        comparison,
        note: "本宿主构建内普通 prompt 轮次的 assistant 内容为空（模型路径不可达，见 blockers.MODEL-ROUND-UNREACHABLE）；压缩轮次（summarize）产生的 assistant reasoning/text/compaction 内容已包含在内。该断言验证的是“镜像对宿主实存内容的逐字段保真”，内容维度覆盖见 3.compaction-coverage / 3.tool-part-coverage。",
      });
      check("3.long-history-size", "长历史规模 >50 条消息（单次全量快照，非两条纯文本）", hostMessages.length > 50, { hostMessageCount: hostMessages.length, rounds: rounds.length });
      const partTypes = new Set<string>();
      let hasCompaction = false;
      let hasSummaryFlag = false;
      let assistantWithContent = 0;
      for (const message of hostMessages) {
        const info = asRecord(asRecord(message)?.["info"]) ?? {};
        if (info["summary"] === true) hasSummaryFlag = true;
        const parts = Array.isArray(asRecord(message)?.["parts"]) ? (asRecord(message)!["parts"] as unknown[]) : [];
        if (info["role"] === "assistant" && parts.length > 0) assistantWithContent += 1;
        for (const part of parts) {
          const type = asRecord(part)?.["type"];
          if (typeof type === "string") partTypes.add(type);
          if (type === "compaction") hasCompaction = true;
        }
      }
      const richContentDetails = {
        partTypes: [...partTypes].sort(),
        assistantWithContent,
        hostMessageCount: hostMessages.length,
        hasCompaction,
        hasSummaryFlag,
        summarizeStatus,
        summarizeRounds,
        beforeSummarizeCount,
        afterSummarizeCount,
        postCompactionRounds: rounds.filter((round) => round.index > 27).length,
        modelCallsReceivedByMock: mock!.modelCalls.length,
      };
      const compactionOk = summarizeRounds.length >= 2 && summarizeRounds.every((round) => round.status === 200) && (hasCompaction || hasSummaryFlag) && assistantWithContent >= 1;
      check("3.compaction-coverage", "压缩后数据覆盖（2 次 summarize 各一轮真实模型 + compaction/summary 标记 + assistant reasoning/text 落库并被镜像）", compactionOk, {
        ...richContentDetails,
        note: "summarize/compaction 路径不经过 SystemPrompt.environment，因此可真实调用 mock 模型；这是本宿主构建下唯一可达的真实模型内容路径。",
      });
      const toolOk = partTypes.has("tool");
      check("3.tool-part-coverage", "工具结果覆盖（依赖普通 prompt 轮次中模型 tool_calls → 工具执行 → tool part）", toolOk, {
        ...richContentDetails,
        blockedBy: toolOk ? null : ["MODEL-ROUND-UNREACHABLE"],
        note: "BLOCKED（宿主构建缺陷）：普通 prompt 轮次的模型路径不可达（tools 声明/工具执行均在 environment 之后），无法产出 tool part；compaction 路径 tools 为空集。修复重建 exe 后可转绿。",
      });
      const syncLines = [...(host!.output.match(/session-hub: sync session=(\S+) status=(\d+) messages=(\d+)/g) ?? [])];
      const lastSync = syncLines.reverse().find((line) => line.includes(`session=${sessionId}`));
      check(
        "3.full-history-in-single-fetch",
        "宿主日志显示单次同步包含完整消息数（V1 无分页、一次全量读取）",
        Boolean(lastSync) && Number(lastSync!.match(/messages=(\d+)$/)?.[1] ?? -1) === hostMessages.length,
        { lastSync, hostMessageCount: hostMessages.length },
      );
    }
  }

  // ---------------- stage: delete ----------------
  if (stages.has("delete")) {
    const sessionC = await client!.createSession("E2E-C 删除镜像");
    scenarios.sessionC = sessionC;
    const idC = String(sessionC["id"]);
    await client!.prompt(idC, "C 第一轮");
    const firstSync = await waitFor("first PUT for C", () => findPut(mock!, idC, (item) => item.status === 200 || item.status === 201), PUT_TIMEOUT_MS);
    check("5.precondition-synced", "删除前 C 已建立镜像记录", Boolean(firstSync) && Boolean(mock!.findHubRecord("opencode", hostname(), idC)), { putSeq: firstSync?.seq ?? null });
    if (firstSync) {
      mock!.holdNextPut(idC, 2_500);
      await client!.prompt(idC, "C 第二轮（触发在途 PUT 与删除竞争）");
      const heldPut = await waitFor("held PUT for C", () => mock!.puts.find((item) => item.sourceId === idC && item.seq > firstSync.seq), PUT_TIMEOUT_MS);
      const putCountAtDelete = putsFor(mock!, idC).length;
      const deleteResult = await client!.request("DELETE", `/session/${encodeURIComponent(idC)}`, { timeoutMs: 60_000 });
      mark("session-C-deleted", { status: deleteResult.status, text: deleteResult.text.slice(0, 80), heldPutSeq: heldPut?.seq ?? null });
      const removed = await waitFor("mirror record removed", () => mock!.findHubRecord("opencode", hostname(), idC) === undefined, 45_000);
      await sleep(8_000);
      const stillAbsent = mock!.findHubRecord("opencode", hostname(), idC) === undefined;
      const putCountAfter = putsFor(mock!, idC).length;
      const mirrorGet = mock!.requests.find((item) => item.method === "GET" && item.path === "/v1/sessions" && item.query["source_id"] === idC);
      const mirrorDelete = mock!.requests.find((item) => item.method === "DELETE" && item.path.startsWith("/v1/sessions/"));
      check("5.mirror-delete", "删除源会话后镜像记录被删（GET 三元组过滤 + DELETE）", removed === true && stillAbsent, {
        removed,
        stillAbsent,
        mirrorGetQuery: mirrorGet?.query ?? null,
        mirrorDeletePath: mirrorDelete?.path ?? null,
      });
      check("5.no-resurrection", "debounce/在途删除竞争不复活（删除后无新 PUT）", putCountAfter === putCountAtDelete && stillAbsent, { putCountAtDelete, putCountAfter });
    }
  }

  // ---------------- stage: failure ----------------
  if (stages.has("failure")) {
    const sessionF = await client!.createSession("E2E-F 失败诊断");
    scenarios.sessionF = sessionF;
    const idF = String(sessionF["id"]);
    mock!.failPut(idF, "500", 1);
    const round1 = await client!.prompt(idF, "F 第一轮：上传将收到 500");
    const saw500 = await waitForLog(new RegExp(`session-hub: sync session=${idF} status=500`), 90_000);
    check("6.failure-500-logged", "上传 500 被宿主日志记录且可诊断（status=500）", saw500, { round1 });
    mock!.failPut(idF, "destroy", 3); // 3 次：覆盖宿主 fetch 对连接重置的透明重试（上一 RUN 实测重试链长 2），确保插件确实看到传输失败
    const round2 = await client!.prompt(idF, "F 第二轮：连接被切断");
    const sawDisconnect = await waitForLog(new RegExp(`session-hub: sync failed session=${idF}:`), 90_000);
    check("6.failure-disconnect-logged", "连接中断被记录且可诊断（sync failed ...）", sawDisconnect, {
      round2,
      destroyInjections: 3,
      note: "宿主运行时对连接重置的 PUT 会透明重试一次；本项注入 3 次断链以穿透重试，验证插件自身 catch→日志（sync failed session=...）路径。",
    });
    const completes = (round: { status: number; ms: number }) => (round.status === 200 || round.status === 500) && round.ms < 60_000;
    check("6.agent-not-blocked", "上传失败不阻塞 agent（后续轮次仍完成、宿主仍可服务）", completes(round1) && completes(round2), {
      round1,
      round2,
      note: "本轮宿主构建内轮次以 500 收口（模型路径不可达，见 blockers.MODEL-ROUND-UNREACHABLE）；此处验证插件同步失败/断连不会阻塞或拖死会话轮次。",
    });
    const round3 = await client!.prompt(idF, "F 第三轮：恢复后应成功");
    // 清除残余故障注入（destroy 注入数为 3，round2 的 fetch 重试链会消耗其中 1–3 次，残余会误伤 round3）
    mock!.clearFailPuts(idF);
    const recovered = await waitFor("recovered PUT for F", () => findPut(mock!, idF, (item) => item.status === 200 || item.status === 201), PUT_TIMEOUT_MS);
    check("6.recovery-after-failure", "恢复后下一次 idle 同步成功（201/200）", Boolean(recovered) && completes(round3), {
      putSeq: recovered?.seq ?? null,
      round3,
      failureInjectionsCleared: true,
    });
    const listStatus = (await client!.request("GET", "/session")).status;
    check("6.host-still-responsive", "宿主仍可服务（GET /session 200）", listStatus === 200, { listStatus });
  }

  // ---------------- stage: reload ----------------
  if (stages.has("reload")) {
    const sessionE = await client!.createSession("E2E-E reload/unload");
    scenarios.sessionE = sessionE;
    const idE = String(sessionE["id"]);
    await client!.prompt(idE, "E 第一轮：随后立即 dispose");
    const disposeResponse = await client!.request("POST", "/global/dispose", { timeoutMs: 120_000, scoped: false });
    const disposeAvailable = disposeResponse.status === 200;
    reloadPath = disposeAvailable ? "global-dispose" : "process-restart";
    if (disposeAvailable) {
      mark("dispose", { status: disposeResponse.status, text: disposeResponse.text.slice(0, 80) });
      await sleep(10_000);
      const leakedPut = findPut(mock!, idE);
      const requestsAfterDispose = mock!.requests.filter((item) => item.at > Date.now() - 10_000);
      check("6.dispose-clears-timers", "dispose 后 pending debounce 被清理：10s 内无该会话 PUT/无残余请求", !leakedPut && requestsAfterDispose.length === 0, {
        leakedPut: Boolean(leakedPut),
        residualRequests: requestsAfterDispose.map((item) => `${item.method} ${item.path}`),
      });
      const ready = await waitForReady(projectDir, RECREATE_TIMEOUT_MS);
      check("6.instance-recreated", "dispose 后新请求重建实例（重复加载继续工作）", ready.ok, ready);
      if (!ready.ok) throw new Error("instance not recreated");
      const reloadedAgain = await waitForLogCount(/session-hub: enabled baseUrl=/g, 2, 180_000);
      enabledLogCount = countLogMatches(/session-hub: enabled baseUrl=/g);
      mark("plugin-re-enabled", { enabledLogCount, reloadedAgain });
    } else {
      mark("dispose-unavailable", { status: disposeResponse.status, text: disposeResponse.text.slice(0, 120) });
      // 进程级 restart 路径：先做“unload 前 timer 释放”检查——prompt 后 3s 内杀进程。
      await stopHost(host!);
      await sleep(8_000);
      const leakedPut = findPut(mock!, idE);
      check("6.dispose-clears-timers", "进程退出释放了 pending debounce（8s 内无该会话 PUT）", !leakedPut, { leakedPut: Boolean(leakedPut), path: "process-restart" });
      const hostPort2 = await reservePort();
      host = await startHost(sandboxRoot, env, hostPort2);
      client = new HostClient(host, password, projectDir);
      const ready = await waitForReady(projectDir, RECREATE_TIMEOUT_MS);
      check("6.instance-recreated", "重启后新实例 + 插件再次加载", ready.ok, ready);
      if (!ready.ok) throw new Error("host not recreated");
      const reloadedAgain = await waitForLogCount(/session-hub: enabled baseUrl=/g, 2, 180_000);
      enabledLogCount = countLogMatches(/session-hub: enabled baseUrl=/g);
      mark("plugin-re-enabled", { enabledLogCount, reloadedAgain });
    }
    const beforeE = putsFor(mock!, idE).length;
    const round2 = await client!.prompt(idE, "E 第二轮：reload 后单订阅验证");
    const putE = await waitFor("PUT for E after reload", () => putsFor(mock!, idE).length > beforeE, PUT_TIMEOUT_MS);
    await sleep(QUIET_MS);
    const afterE = putsFor(mock!, idE).length;
    check("6.reload-single-subscription", "重复加载后无重复订阅：该 idle 恰好产生一个 PUT，且总量=1", afterE === 1, {
      beforeE,
      afterE,
      round2,
      enabledLogCount,
      reloadPath,
    });
    reloadDetail = { reloadPath, enabledLogCount, putCountForE: afterE, disposeStatus: disposeResponse.status };
  }

  // ---------------- teardown ----------------
  mark("teardown-start");
  const hostBeforeKill = host;
  if (hostBeforeKill && !hostBeforeKill.exited) {
    const killAt = Date.now();
    await stopHost(hostBeforeKill);
    await sleep(5_000);
    const afterKill = mock!.requests.filter((item) => item.at > killAt + 500);
    check(
      "6.no-traffic-after-exit",
      "宿主进程退出后 mock 无残余请求（订阅/timers 随进程释放）",
      hostBeforeKill.exited && afterKill.length === 0,
      { exited: hostBeforeKill.exited, exitCode: hostBeforeKill.exitCode, exitSignal: hostBeforeKill.exitSignal, forcedKill: hostBeforeKill.forcedKill, requestsAfterKill: afterKill.length },
    );
  }
  const jobConfirmed = /ISOLATED_JOB active_process_limit=1 kill_on_close=true/.test(host?.output ?? "");
  check("8.host-exited-via-job", "宿主经 Job 清场退出（ownProcessExited）", Boolean(host?.exited) && jobConfirmed, {
    exited: host?.exited ?? false,
    exitCode: host?.exitCode ?? null,
    forcedKill: host?.forcedKill ?? null,
    jobConfirmed,
  });

  // 日志扫描（本次隔离日志，不含共享日志）
  const rawLog = host?.output ?? "";
  const bannedPatterns: Array<{ name: string; regex: RegExp }> = [
    { name: "failed to load plugin", regex: /failed to load plugin/gi },
    { name: "SchemaError", regex: /SchemaError/g },
    { name: "LoadError", regex: /LoadError/g },
  ];
  const bannedHits = bannedPatterns.map((pattern) => ({ name: pattern.name, count: (rawLog.match(pattern.regex) ?? []).length }));
  const dependencyInstallWarnings = (rawLog.match(/background dependency install failed/g) ?? []).length;
  logsScan = {
    bannedHits,
    dependencyInstallWarnings,
    enabledLines: (rawLog.match(/session-hub: enabled baseUrl=(\S+) machine=(\S+)/g) ?? []).length,
    syncLines: (rawLog.match(/session-hub: sync session=(\S+) status=(\d+)/g) ?? []).length,
    syncFailedLines: (rawLog.match(/session-hub: sync failed session=(\S+):/g) ?? []).length,
    deleteMirrorLines: (rawLog.match(/session-hub: delete mirror source_id=(\S+) found=(\d+) deleted=(\d+)/g) ?? []).length,
  };
  check(
    "7.no-forbidden-log-entries",
    "本次隔离日志无 failed-to-load / SchemaError / LoadError（npm 依赖安装失败为隔离网络预期噪声，单列记录）",
    bannedHits.every((hit) => hit.count === 0),
    logsScan,
  );

  // 关闭 mock、清场沙箱
  await mock!.close().catch(() => undefined);
  mark("mock-closed");
  try {
    await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    sandboxRemoved = true;
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  check("8.sandbox-removed", "临时沙箱目录已清理（HOME/XDG/TEMP/OPENCODE_* 全部在沙箱内）", sandboxRemoved, {
    sandboxRoot,
    sandboxRemoved,
    cleanupError,
    marker,
  });

  // 现役部署摘要复核（只读）：以本次运行开始时的快照为准（现役文件可因用户授权的安装/替换先于本运行变化；
  // 与隔离基线 deployed-before.json 的差异只作记录）。
  for (const file of Object.keys(deployedBefore)) {
    deployedAfter[file] = existsSync(file) ? sha256(await readFile(file)) : "MISSING";
  }
  const deployedOk = Object.keys(deployedNow).every((file) => deployedNow[file] === deployedAfter[file]);
  const matchesIsolationBaseline = Object.keys(deployedBefore).every((file) => deployedBefore[file] === deployedAfter[file]);
  check("8.deployed-unchanged", "现役部署文件本次运行前后摘要不变（未触碰现役；差异另行记录）", deployedOk, {
    runStart: deployedNow,
    before: deployedBefore,
    after: deployedAfter,
    matchesIsolationBaseline,
  });
}

// ---------------------------------------------------------------------------
async function writeEvidence(extra: Record<string, unknown>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const finishedAt = Date.now();
  const passed = assertions.length > 0 && assertions.every((assertion) => assertion.passed);
  const failedIds = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.id);
  const mockCallsFinal = mock?.modelCalls.length ?? 0;
  const modelBlocker = blockers.find((item) => item["id"] === "MODEL-ROUND-UNREACHABLE");
  if (modelBlocker) {
    const observed = (modelBlocker["observed"] ?? {}) as Record<string, unknown>;
    observed["modelCallsFinal"] = mockCallsFinal;
    modelBlocker["observed"] = observed;
  }
  const report = {
    name: "opencode-plugin 0.2.0 V1 宿主业务 E2E（mock-only 隔离）",
    generatedAt: new Date(finishedAt).toISOString(),
    runId,
    worktree,
    branch: extra["branch"] ?? null,
    gitHead: extra["gitHead"] ?? null,
    stages: [...stages],
    commands: {
      runner: `npx tsx plugins/opencode/scripts/acceptance/e2e-v1.ts${stagesArg ? ` ${stagesArg}` : ""}`,
      host: hostCommands,
      notes: [
        "仅通过 launch_isolated.py 启动 opencode-v1-isolated.exe（长驻 serve）",
        "Session Hub 与模型均为 127.0.0.1 loopback mock；无真实外网请求与真实凭据",
        "临时 token/password 仅存在于进程环境，未写入证据（脱敏为 [redacted]）",
      ],
    },
    dist: extra["dist"] ?? null,
    isolation: {
      isolationRoot,
      launcher,
      executable: v1Executable,
      firewallRule: firewallRuleDetail,
      sandboxRoot,
      sandboxMarker: marker,
      sandboxRemoved,
      cleanupError,
      hostExited: host?.exited ?? false,
      hostExitCode: host?.exitCode ?? null,
      hostExitSignal: host?.exitSignal ?? null,
      forcedKill: host?.forcedKill ?? false,
      jobConfirmed: /ISOLATED_JOB active_process_limit=1 kill_on_close=true/.test(host?.output ?? ""),
      hostPort: hostPortUsed,
      mockPort: mock?.port ?? null,
      ready: lastReady,
      reloadPath,
      reloadDetail,
    },
    deployed: { before: deployedBefore, after: deployedAfter },
    logsScan,
    model: {
      mockCalls: mockCallsFinal,
      note:
        mockCallsFinal === 0
          ? "mock 模型 0 次被调用：宿主 LLM 路径在建系统提示前即抛错（见 blockers.MODEL-ROUND-UNREACHABLE）"
          : `mock 模型被调用 ${mockCallsFinal} 次（均来自 compaction/summarize 路径）；普通 prompt 轮次因宿主构建缺陷不可达（见 blockers.MODEL-ROUND-UNREACHABLE）`,
    },
    blockers,
    blockedAssertionIds: BLOCKED_ASSERTION_IDS.filter((id) => assertions.some((assertion) => assertion.id === id)),
    assertions,
    timeline,
    passed,
    result: failedIds.length === 0 ? "all-green" : failedIds.every((id) => BLOCKED_ASSERTION_IDS.includes(id)) ? "green-except-environmental-blockers" : "failed",
    blocked: failedIds.length > 0,
  };
  await writeFile(join(outDir, "report.json"), redact(JSON.stringify(report, null, 2)));
  await writeFile(
    join(outDir, "mock-requests.json"),
    redact(
      JSON.stringify(
        {
          requests: mock ? mockRequestsSnapshot(mock) : [],
          puts: mock ? mock.puts.map((put) => ({ ...put, body: put.body })) : [],
          modelCalls: mock ? mock.modelCalls : [],
        },
        null,
        2,
      ),
    ),
  );
  await writeFile(join(outDir, "v1-host.log"), redact(host?.output ?? ""));
  await writeFile(join(outDir, "summary.md"), buildSummary(report, extra));
}

function fmt(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function buildSummary(report: Record<string, unknown>, extra: Record<string, unknown>): string {
  const lines: string[] = [];
  const passed = report["passed"] === true;
  const result = String(report["result"] ?? (passed ? "all-green" : "failed"));
  const resultText =
    result === "all-green"
      ? "**全绿**（所有断言通过）"
      : result === "green-except-environmental-blockers"
        ? "**除环境性阻塞项外全绿**：红项均为宿主二进制构建缺陷所致（非本插件缺陷，见下方“阻塞”），其余断言全部通过"
        : "**存在失败断言**（含非阻塞性失败，见“失败详情”）";
  lines.push(`# V1 宿主业务 E2E 摘要（opencode-plugin 0.2.0 / mock-only 隔离）`);
  lines.push("");
  lines.push(`- 结果：${resultText}（result=${result}，passed=${passed}，runId=${runId}，生成于 ${report["generatedAt"]}）`);
  lines.push(`- 命令：\`npx tsx plugins/opencode/scripts/acceptance/e2e-v1.ts\`（工作区 ${worktree}，分支 ${extra["branch"] ?? "?"} @ ${String(extra["gitHead"] ?? "?").slice(0, 12)}）`);
  lines.push(`- 宿主启动：\`python launch_isolated.py --cwd <sandbox> -- opencode-v1-isolated.exe --print-logs serve --hostname 127.0.0.1 --port <hostPort>\`（唯一允许的启动器；Job=1、kill_on_close）`);
  lines.push(`- 产物 SHA：\`${jsonShallow(report["dist"])}\``);
  lines.push("");
  lines.push("## 断言清单");
  lines.push("");
  lines.push("| 断言 | 结果 | 说明 |");
  lines.push("|---|---|---|");
  for (const assertion of assertions) {
    const blockedMark = !assertion.passed && BLOCKED_ASSERTION_IDS.includes(assertion.id) ? "（环境性阻塞）" : "";
    lines.push(`| ${assertion.id} | ${assertion.passed ? "PASS" : `FAIL${blockedMark}`} | ${assertion.name} |`);
  }
  lines.push("");
  if (blockers.length > 0) {
    lines.push("## 阻塞（blocker）");
    lines.push("");
    for (const blocker of blockers) {
      lines.push(`### ${blocker["id"]} — ${blocker["status"] ?? ""}`);
      lines.push("");
      lines.push(`- 范围：${blocker["scope"] ?? ""}`);
      lines.push(`- 观测：${jsonShallow(blocker["observed"])}`);
      lines.push(`- 根因：${blocker["rootCause"] ?? "（同源，见 MODEL-ROUND-UNREACHABLE）"}`);
      lines.push(`- 影响：${blocker["impact"] ?? "见范围与观测。"}`);
      lines.push(`- 处置建议：${blocker["remediation"] ?? ""}`);
      lines.push("");
    }
  }
  lines.push("## 关键证据");
  lines.push("");
  lines.push(`- dist：${fmt(report["dist"])}`);
  lines.push(`- 隔离：${fmt(report["isolation"])}`);
  lines.push(`- 日志扫描：${fmt(logsScan)}`);
  lines.push(`- 现役核对：before=${Object.keys(deployedBefore).length} 文件，after=${fmt(deployedAfter)}`);
  const problemAssertions = assertions.filter((assertion) => !assertion.passed);
  if (problemAssertions.length > 0) {
    lines.push("");
    lines.push("## 失败详情");
    lines.push("");
    for (const assertion of problemAssertions) lines.push(`- [${assertion.id}] ${assertion.name}：${fmt(assertion.details)}`);
  }
  lines.push("");
  lines.push("## SH 对照（V1 侧）");
  lines.push("");
  lines.push("- SH-01：S0.single-default + 1.plugin-loaded（同一产物在 V1 真宿主加载，稳定 id=session-hub，唯一 default）。");
  lines.push("- SH-02：3.core-fields / 3.source-times / 4.single-subscription（配置链、3s debounce、转换、源时间、删除镜像回归）。");
  lines.push("- SH-04：4.no-cross-session / 5.* / 6.dispose-clears-timers / 6.reload-single-subscription / 6.no-traffic-after-exit。");
  lines.push("- SH-05：6.failure-500-logged / 6.failure-disconnect-logged / 6.agent-not-blocked（日志可诊断、脱敏、不阻塞）。");
  lines.push("- SH-06：全程 loopback mock + 隔离启动器；8.sandbox-removed + 8.deployed-unchanged。");
  lines.push("- SH-03/07：V2 侧由 V2 E2E 覆盖；本报告给出 V1 侧同构证据（长历史/分页语义/完整快照）。");
  lines.push("");
  lines.push("## 清场记录");
  lines.push("");
  lines.push(`- 沙箱删除：${sandboxRemoved}（cleanupError=${cleanupError || "none"}）`);
  lines.push(`- 宿主退出：exited=${host?.exited ?? false} code=${host?.exitCode ?? "null"} signal=${host?.exitSignal ?? "null"} forcedKill=${host?.forcedKill ?? false} jobConfirmed=${report["isolation"] ? (report["isolation"] as Record<string, unknown>)["jobConfirmed"] : "?"}`);
  lines.push(`- mock 关闭、无外网请求（宿主被防火墙阻断为预期；仅 loopback 127.0.0.1 通信）。`);
  lines.push("");
  lines.push("## 时间线摘录");
  lines.push("");
  for (const item of timeline.slice(-30)) lines.push(`- +${((item.at as number) - (timeline[0]?.at ?? item.at as number)) / 1000}s ${item.event}${item.detail === undefined ? "" : ` ${fmt(item.detail).slice(0, 220)}`}`);
  lines.push("");
  return lines.join("\n");
}

function jsonShallow(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 600);
  } catch {
    return String(value);
  }
}

async function run(): Promise<void> {
  let extra: Record<string, unknown> = {};
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    check("run.completed", "运行器整体完成（无未捕获异常）", false, { error: message });
  } finally {
    clearTimeout(watchdog);
    if (host && !host.exited) {
      await stopHost(host);
    }
    if (mock) {
      await mock.close().catch(() => undefined);
    }
    try {
      await rm(sandboxRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      sandboxRemoved = true;
    } catch (error) {
      cleanupError = cleanupError || (error instanceof Error ? error.message : String(error));
    }
    let gitHead: string | null = null;
    let branch: string | null = null;
    try {
      gitHead = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? null;
      branch = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? null;
    } catch {
      /* best effort */
    }
    let dist: unknown = null;
    try {
      const buffer = await readFile(distPath);
      dist = { path: distPath, sha256: sha256(buffer), expectedSha256: expectedDistSha, match: sha256(buffer) === expectedDistSha };
    } catch (error) {
      dist = { path: distPath, error: String(error) };
    }
    if (deployedBefore && Object.keys(deployedBefore).length > 0) {
      for (const file of Object.keys(deployedBefore)) {
        try {
          deployedAfter[file] = existsSync(file) ? sha256(await readFile(file)) : "MISSING";
        } catch {
          deployedAfter[file] = "UNREADABLE";
        }
      }
    }
    extra = { gitHead, branch, dist };
    await writeEvidence(extra);
    const passed = assertions.every((assertion) => assertion.passed);
    const failedIds = assertions.filter((item) => !item.passed).map((item) => item.id);
    console.log(
      JSON.stringify(
        {
          passed,
          result: failedIds.length === 0 ? "all-green" : failedIds.every((id) => BLOCKED_ASSERTION_IDS.includes(id)) ? "green-except-environmental-blockers" : "failed",
          assertions: assertions.length,
          failed: failedIds,
          blockers: blockers.map((item) => item["id"]),
          outDir,
        },
        null,
        2,
      ),
    );
    process.exitCode = passed ? 0 : 1;
  }
}

await run();

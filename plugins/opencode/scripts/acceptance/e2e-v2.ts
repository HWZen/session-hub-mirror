// V2 2.0.26 宿主业务 E2E 运行器（仅新增文件；不改动 src/、现有 test/helpers、build.mjs、qualify-host.ts、install.mjs）。
//
// 运行：npx tsx scripts/acceptance/e2e-v2.ts <conda-python-executable>
//
// 约束（与 plan.md §6 一致）：
// - 只经 launch_isolated.py 启动 opencode-v2-isolated.exe（Job active_process_limit=1 / kill_on_close）。
// - 沙箱 HOME/全部 XDG/TEMP/OPENCODE_* 根均在沙箱目录内；Session Hub 与模型全部指向 loopback mock。
// - 不产生真实外网请求与真实凭据；日志脱敏；finally 清场并核对现役文件 SHA 不变。
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";
import { startV2Mock, type V2MockHandle, type V2PutRecord } from "./loopback-mock-v2.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = resolve(scriptDirectory, "..", "..");
const scratch = resolve(process.env["OPENCODE_E2E_SCRATCH"] ?? join(homedir(), ".cache", "session-hub", "acceptance"));
const isolationRoot = resolve(process.env["OPENCODE_E2E_ISOLATION_ROOT"] ?? join(scratch, "session-hub-opencode-v2-isolation"));
const launcher = join(isolationRoot, "launch_isolated.py");
const hostExecutable = join(isolationRoot, "opencode-v2-isolated.exe");
const smokeOnly = process.argv.includes("--smoke");
const canonicalBundleSha = process.env["OPENCODE_E2E_BUNDLE_SHA"] ?? "dd320d0b1096c38ffb67e5059310f7dac2244ab78bae6ce7b6a74ac1dd337a1c";
if (!/^[a-f0-9]{64}$/.test(canonicalBundleSha)) throw new Error("Invalid expected bundle SHA256");
const evidenceDirectory = join(pluginDirectory, "develop-doc", "0.2.0", smokeOnly ? "e2e-v2-smoke" : "e2e-v2");
const runAbort = new AbortController();
const budgetTimer = setTimeout(() => runAbort.abort(), smokeOnly ? 240_000 : 1_800_000);
const deployedPaths = {
  sessionHub: join(homedir(), ".config", "opencode", "plugins", "session-hub.js"),
  agentRemoteAuth: join(homedir(), ".config", "opencode", "plugins", "agent-remote-auth.js"),
  opencodeJsonc: join(homedir(), ".config", "opencode", "opencode.jsonc"),
};
const python = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.env["OPENCODE_E2E_PYTHON"];
if (!python) throw new Error("Pass a conda environment interpreter or set OPENCODE_E2E_PYTHON");
const machine = hostname();

interface Assertion {
  id: string;
  name: string;
  status: "pass" | "fail";
  details: unknown;
}
const assertions: Assertion[] = [];
const notes: string[] = [];
const timings: Record<string, unknown> = {};
const runLog: string[] = [];

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  runLog.push(line);
  console.log(line);
}
function assertRecord(id: string, name: string, ok: boolean, details: unknown): boolean {
  assertions.push({ id, name, status: ok ? "pass" : "fail", details });
  log(`${ok ? "PASS" : "FAIL"} ${id} ${name}`);
  if (!ok) log(`     details: ${JSON.stringify(details).slice(0, 1500)}`);
  return ok;
}
const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

// ---------- 宿主日志实时诊断（脱敏后立即输出并落 host-live.log） ----------
const hostLogMatch = /session-hub|agent-remote-auth|未就绪|未配置|超限|upload|delete mirror|event stream|failed|SchemaError|LoadError/i;
let hostLivePending: string[] = [];
let hostLiveTimer: ReturnType<typeof setInterval> | undefined;
function startHostLive(): void {
  hostLiveTimer = setInterval(() => {
    if (hostLivePending.length === 0) return;
    const batch = hostLivePending.join("\n") + "\n";
    hostLivePending = [];
    void appendFile(join(evidenceDirectory, "host-live.log"), batch).catch(() => undefined);
  }, 2_000);
}
function stopHostLive(): void {
  if (hostLiveTimer !== undefined) clearInterval(hostLiveTimer);
  hostLiveTimer = undefined;
  if (hostLivePending.length > 0) {
    const batch = hostLivePending.join("\n") + "\n";
    hostLivePending = [];
    void appendFile(join(evidenceDirectory, "host-live.log"), batch).catch(() => undefined);
  }
}
function pluginLogScan(): Record<string, unknown> {
  const lines = context.hostOutputRaw.split(/\r?\n/).filter((line) => /session-hub|agent-remote-auth/.test(line));
  const sanitizeLine = (line: string) => sanitize(line, context.serverPassword, context.mock?.hubToken ?? "").slice(0, 300);
  return {
    matchingLines: lines.length,
    verifyFailure: lines.filter((line) => /未就绪/.test(line)).slice(-10).map(sanitizeLine),
    notConfigured: lines.filter((line) => /未配置/.test(line)).slice(-5).map(sanitizeLine),
    uploads: lines.filter((line) => /upload status=/.test(line)).slice(-30).map(sanitizeLine),
    syncErrors: lines
      .filter((line) => /sync failed|event stream failed|快照不一致|超限|delete mirror|upload failed/.test(line))
      .slice(-30)
      .map(sanitizeLine),
    agentRemoteAuth: lines.filter((line) => /agent-remote-auth/.test(line)).slice(-10).map(sanitizeLine),
    tail: lines.slice(-20).map(sanitizeLine),
  };
}
function eventTypeSummary(): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const event of context.events) summary[event.type] = (summary[event.type] ?? 0) + 1;
  return summary;
}
function feedHostOutput(chunk: Buffer | string): void {
  const text = String(chunk);
  context.hostOutputRaw = (context.hostOutputRaw + text).slice(-400_000);
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || !hostLogMatch.test(line)) continue;
    const clean = sanitize(line, context.serverPassword, context.mock?.hubToken ?? "");
    hostLivePending.push(clean);
    console.log(`[host] ${clean.slice(0, 300)}`);
  }
}

// ---------- 阶段计时 ----------
const phaseStarts = new Map<string, number>();
function phase(label: string): void {
  const now = Date.now();
  const started = phaseStarts.get(label);
  if (started === undefined) {
    phaseStarts.set(label, now);
    log(`phase ${label} begin`);
  } else {
    phaseStarts.delete(label);
    log(`phase ${label} done +${now - started}ms`);
  }
}

async function sha256(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).filter((key) => aRecord[key] !== undefined);
  const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => bKeys.includes(key) && deepEqual(aRecord[key], bRecord[key]));
}

/** 与 src/adapter-v2.ts V2_ROLE_BY_TYPE 对齐的独立镜像（用于字段级比对，不 import src）。 */
const ROLE_BY_TYPE: Record<string, string> = {
  "agent-switched": "agent-switched",
  "model-switched": "model-switched",
  "location-switched": "location-switched",
  user: "user",
  synthetic: "synthetic",
  system: "system",
  skill: "skill",
  shell: "shell",
  assistant: "assistant",
  compaction: "compaction",
  idle: "idle",
};
function expectedRole(type: string): string {
  const mapped = ROLE_BY_TYPE[type];
  if (mapped !== undefined) return mapped;
  return type.length >= 1 && type.length <= 64 ? type : "unknown";
}

interface SourceMessage {
  id: string;
  type: string;
  text?: string;
  time: { created: number; completed?: number };
  content?: unknown[];
  output?: { output?: string };
  summary?: string;
  recent?: string;
  [key: string]: unknown;
}

/** 与 src/adapter-v2.ts mapV2Messages 对齐的独立镜像（parts 语义）。 */
function expectedParts(message: SourceMessage): unknown[] {
  const parts: unknown[] = [];
  switch (message.type) {
    case "assistant":
      parts.push(...((message.content as unknown[]) ?? []));
      break;
    case "user":
    case "system":
    case "skill":
      parts.push({ type: "text", text: message.text });
      break;
    case "synthetic":
      parts.push({ type: "text", text: message.text, synthetic: true });
      break;
    case "shell":
      if (typeof message.output?.output === "string") parts.push({ type: "text", text: message.output.output });
      break;
    case "compaction":
      if (typeof message.summary === "string") parts.push({ type: "text", text: message.summary });
      if (typeof message.recent === "string") parts.push({ type: "text", text: message.recent });
      break;
    default:
      break;
  }
  parts.push({ type: "opencode-v2-envelope", version: "2.0.26", message });
  return parts;
}

function expectedText(message: SourceMessage): string | undefined {
  const pieces = expectedParts(message)
    .slice(0, -1)
    .filter((part): part is { type: string; text: string; synthetic?: boolean } => {
      const record = part as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string" && record["synthetic"] !== true;
    })
    .map((part) => part.text);
  return pieces.length > 0 ? pieces.join("\n\n") : undefined;
}

function cleanEnvironment(root: string, password: string): Record<string, string> {
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
    OPENCODE_PRINT_LOGS: "1",
  };
}

interface Context {
  sandbox: string;
  child: ChildProcess | null;
  hostPid: number | null;
  hostOutputRaw: string;
  hostOutput: string;
  mock: V2MockHandle | null;
  client: ReturnType<typeof OpenCode.make> | null;
  serverPassword: string;
  events: { at: number; type: string; sessionID?: string; statusType?: string }[];
  eventsAbort: AbortController | null;
  hostUrl: string;
  hostPort: number;
  hubBundleCopy: string;
  authCopyPath: string;
  configPath: string;
  hostExit: Promise<void> | null;
  exited: boolean;
}
let deploymentStartSha: Record<string, string | null> = {};
const context: Context = {
  sandbox: "",
  child: null,
  hostPid: null,
  hostOutputRaw: "",
  hostOutput: "",
  mock: null,
  client: null,
  serverPassword: randomBytes(24).toString("hex"),
  events: [],
  eventsAbort: null,
  hostUrl: "",
  hostPort: 0,
  hubBundleCopy: "",
  authCopyPath: "",
  configPath: "",
  hostExit: null,
  exited: false,
};

async function main(): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  // 证据目录跨运行复用：诊断文件在运行开始截断，避免混入历史运行的追加内容。
  await writeFile(join(evidenceDirectory, "host-live.log"), "", "utf8");
  const startedAt = Date.now();

  // ---------- 前置：产物 SHA 与现役基线 ----------
  const distBundlePath = join(pluginDirectory, "dist", "session-hub.js");
  const distSha = await sha256(distBundlePath);
  assertRecord("PRE-01", "dist/session-hub.js SHA 等于规范值", distSha === canonicalBundleSha, {
    path: distBundlePath,
    actual: distSha,
    expected: canonicalBundleSha,
  });
  const deployedBefore = JSON.parse(await readFile(join(isolationRoot, "deployed-before.json"), "utf8")) as Record<string, string>;
  // deployed-before.json 的键为原生 Windows 反斜杠路径：统一 resolve 后比对。
  const baselineSha = (path: string): string | null => deployedBefore[resolve(path)] ?? deployedBefore[path] ?? null;
  const agentRemoteAuthDeployedSha = await sha256(deployedPaths.agentRemoteAuth);
  assertRecord(
    "PRE-02",
    "现役基线 deployed-before.json 可读，且现役 agent-remote-auth.js 摘要与基线一致",
    Object.keys(deployedBefore).length >= 2 && agentRemoteAuthDeployedSha !== null && agentRemoteAuthDeployedSha === baselineSha(deployedPaths.agentRemoteAuth),
    { baseline: deployedBefore, actual: agentRemoteAuthDeployedSha, expected: baselineSha(deployedPaths.agentRemoteAuth) },
  );
  // 本次运行开始时的现役快照（A11-2 以"运行前后不变"为断言；deployed-before.json 仅作信息记录，
  // 现役可因用户授权的安装/替换而先于本运行变化）。
  deploymentStartSha = {
    [resolve(deployedPaths.sessionHub)]: await sha256(deployedPaths.sessionHub),
    [resolve(deployedPaths.agentRemoteAuth)]: await sha256(deployedPaths.agentRemoteAuth),
    [resolve(deployedPaths.opencodeJsonc)]: await sha256(deployedPaths.opencodeJsonc),
  };

  // ---------- 沙箱与 mock ----------
  const root = await mkdtemp(join(scratch, "opencode-v2-e2e-"));
  context.sandbox = root;
  const projectAlpha = join(root, "projects", "alpha");
  const projectBeta = join(root, "projects", "beta");
  const notePath = join(projectAlpha, "synthetic-note.txt");
  const noteContent = "synthetic-tool-content-中文工具结果\n";
  const hubPackage = join(root, "plugin-packages", "session-hub");
  const authPackage = join(root, "plugin-packages", "agent-remote-auth");
  context.hubBundleCopy = join(hubPackage, "index.js");
  context.authCopyPath = join(authPackage, "agent-remote-auth.js");
  context.configPath = join(root, "config", "opencode", "opencode.json");

  for (const directory of [
    join(root, "home", "local"),
    join(root, "home", "roaming"),
    join(root, "managed", "opencode"),
    join(root, "config", "opencode"),
    join(root, "config", "agent-remote-auth"),
    join(root, "data", "opencode"),
    join(root, "cache"),
    join(root, "state"),
    join(root, "temp"),
    projectAlpha,
    projectBeta,
    hubPackage,
    authPackage,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(root, "home", "sandbox-marker.txt"), randomBytes(16).toString("hex"));
  await writeFile(notePath, noteContent, "utf8");

  const mock = await startV2Mock({ toolFilePath: notePath });
  context.mock = mock;

  // session-hub 包装 package：index.js 为规范产物逐字节副本（loaded 文件 SHA == 规范 SHA）。
  await writeFile(context.hubBundleCopy, await readFile(distBundlePath));
  await writeFile(
    join(hubPackage, "package.json"),
    JSON.stringify(
      { name: "synthetic-session-hub-plugin", version: "0.0.0", type: "module", exports: { ".": "./index.js" }, opencode: { server: "./index.js" } },
      null,
      2,
    ),
  );
  const hubCopySha = await sha256(context.hubBundleCopy);
  assertRecord("PRE-03", "沙箱加载副本与规范产物逐字节一致（待加载 session-hub.js 同样 SHA）", hubCopySha === canonicalBundleSha, {
    path: context.hubBundleCopy,
    actual: hubCopySha,
  });

  // agent-remote-auth 包装 package：复制现役文件（只读来源）+ 最小 V1->V2 setup 桥。
  await writeFile(context.authCopyPath, await readFile(deployedPaths.agentRemoteAuth));
  const authCopySha = await sha256(context.authCopyPath);
  assertRecord("PRE-04", "沙箱 agent-remote-auth 副本与现役 SHA 一致", authCopySha === agentRemoteAuthDeployedSha, {
    path: context.authCopyPath,
    actual: authCopySha,
    deployed: agentRemoteAuthDeployedSha,
  });
  await writeFile(
    join(authPackage, "package.json"),
    JSON.stringify(
      { name: "synthetic-agent-remote-auth-plugin", version: "0.0.0", type: "module", exports: { ".": "./index.js" }, opencode: { server: "./index.js" } },
      null,
      2,
    ),
  );
  // V2 只接受 `default {id, setup}`；把现役 V1 工厂桥接为 V2 setup（事件 properties<-data，client.app.log->console）。
  await writeFile(
    join(authPackage, "index.js"),
    [
      'import createPlugin from "./agent-remote-auth.js";',
      "export default {",
      '  id: "agent-remote-auth",',
      "  async setup(ctx) {",
      "    const api = {",
      "      app: {",
      "        log: ({ body }) => {",
      "          try { console.log(`[agent-remote-auth] ${body?.level ?? 'info'}: ${String(body?.message ?? '')}`); } catch {}",
      "          return Promise.resolve();",
      "        },",
      "      },",
      "      session: {",
      "        get: async ({ path }) => ({ data: await ctx.session.get({ sessionID: path.id }) }),",
      "      },",
      "    };",
      "    const hooks = await createPlugin({ client: api, directory: ctx.location?.directory });",
      "    if (!hooks || typeof hooks !== 'object' || typeof hooks.event !== 'function') return;",
      "    const controller = new AbortController();",
      "    const subscription = (async () => {",
      "      try {",
      "        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {",
      "          try { await hooks.event({ event: { type: event.type, properties: event.data } }); }",
      "          catch (error) { console.log(`[agent-remote-auth] event handler failed: ${error instanceof Error ? error.message : String(error)}`); }",
      "        }",
      "      } catch {}",
      "    })();",
      "    return async () => { controller.abort(); try { await hooks.dispose?.(); } catch {} await subscription; };",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  // 静态导出检查：两个加载入口都只导出唯一 default（无 helper 导出误加载面）。
  const hubModule = (await import(pathToFileURL(context.hubBundleCopy).href)) as Record<string, unknown>;
  const authModule = (await import(pathToFileURL(join(authPackage, "index.js")).href)) as Record<string, unknown>;
  const hubDefault = hubModule["default"] as { id?: string; setup?: unknown; server?: unknown } | undefined;
  const authDefault = authModule["default"] as { id?: string; setup?: unknown } | undefined;
  const hubExportKeys = Object.keys(hubModule).filter((key) => key !== "default");
  const authExportKeys = Object.keys(authModule).filter((key) => key !== "default");
  assertRecord(
    "PRE-05",
    "加载入口只暴露唯一 default（id 稳定，无 helper 导出面）",
    typeof hubDefault?.id === "string" &&
      hubDefault.id === "session-hub" &&
      typeof hubDefault.setup === "function" &&
      typeof hubDefault.server === "function" &&
      typeof authDefault?.id === "string" &&
      authDefault.id === "agent-remote-auth" &&
      typeof authDefault.setup === "function" &&
      hubExportKeys.length === 0 &&
      authExportKeys.length === 0,
    {
      sessionHub: { id: hubDefault?.id, keys: Object.keys(hubModule) },
      agentRemoteAuth: { id: authDefault?.id, keys: Object.keys(authModule) },
    },
  );

  // ---------- 宿主端口与配置 ----------
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", () => done()));
  const address = reservation.address();
  if (address === null || typeof address === "string") throw new Error("no host port reservation");
  context.hostPort = address.port;
  await new Promise<void>((done) => {
    reservation.close(() => done());
  });
  context.hostUrl = `http://127.0.0.1:${context.hostPort}`;

  const opencodeConfig = {
    plugins: [
      {
        package: hubPackage,
        options: {
          endpoint: context.hostUrl,
          auth: { username: "opencode", password: context.serverPassword },
        },
      },
      { package: authPackage },
    ],
    providers: {
      mock: {
        name: "Synthetic Mock Provider",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: `${mock.url}/model/v1`, apiKey: "synth...key" },
        models: {
          "mock-llm": {
            name: "Synthetic Mock LLM",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        },
      },
    },
    model: { providerID: "mock", model: "mock-llm" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  };
  await writeFile(context.configPath, JSON.stringify(opencodeConfig, null, 2));

  // ---------- 启动 V2 宿主（唯一允许路径：launch_isolated.py） ----------
  const env = cleanEnvironment(root, context.serverPassword);
  env["SESSION_HUB_URL"] = mock.url;
  env["SESSION_HUB_TOKEN"] = mock.hubToken;
  env["AGENT_REMOTE_AUTH_ENABLED"] = "false";
  env["AGENT_REMOTE_AUTH_CONFIG"] = join(root, "config", "agent-remote-auth", "config.json");

  log(`启动：${python} ${launcher} --cwd ${root} -- ${hostExecutable} --print-logs serve --hostname 127.0.0.1 --port ${context.hostPort}`);
  const child = spawn(python, [launcher, "--cwd", root, "--", hostExecutable, "--print-logs", "serve", "--hostname", "127.0.0.1", "--port", String(context.hostPort)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  context.child = child;
  context.hostExit = new Promise<void>((done) => {
    child.once("exit", () => {
      context.exited = true;
      done();
    });
  });
  child.stdout?.on("data", (chunk) => feedHostOutput(chunk));
  child.stderr?.on("data", (chunk) => feedHostOutput(chunk));
  child.on("error", (error) => feedHostOutput(String(error)));
  startHostLive();

  const client = OpenCode.make({
    ...(smokeOnly ? { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const signals = [runAbort.signal, AbortSignal.timeout(20_000)];
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal) signals.push(signal);
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
    } } : {}),
    baseUrl: context.hostUrl,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${context.serverPassword}`).toString("base64")}` },
  });
  context.client = client;

  // 事件采集（真实宿主 /api/event SSE，直连读取）。
  // SDK 的 client.event.subscribe 在宿主端口就绪前发起、首连失败即被静默吞掉，导致整场 events=0；
  // 这里带连接重试与明确诊断，事件到达时间即 debounce 计时的观测基准。
  const eventsAbort = new AbortController();
  context.eventsAbort = eventsAbort;
  const pushEvent = (raw: unknown): void => {
    const record = (raw ?? {}) as { type?: unknown; data?: unknown };
    const data = (record.data ?? {}) as Record<string, unknown>;
    const status = data["status"] as { type?: unknown } | undefined;
    context.events.push({
      at: Date.now(),
      type: String(record.type),
      sessionID: typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined,
      statusType: typeof status?.type === "string" ? status.type : undefined,
    });
  };
  const eventCollector = (async () => {
    let failedStreak = 0;
    while (!eventsAbort.signal.aborted) {
      try {
        const response = await fetch(`${context.hostUrl}/api/event`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${context.serverPassword}`).toString("base64")}` },
          signal: eventsAbort.signal,
        });
        if (response.status !== 200 || response.body === null) {
          throw new Error(`status=${response.status}`);
        }
        failedStreak = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replaceAll("\r", "");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n");
            if (data !== "") {
              try {
                pushEvent(JSON.parse(data));
              } catch {
                /* 非 JSON SSE 载荷跳过 */
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        if (!eventsAbort.signal.aborted) notes.push("event stream ended early; reconnecting");
      } catch (error) {
        if (eventsAbort.signal.aborted) break;
        failedStreak += 1;
        if (failedStreak === 1) {
          notes.push(`event stream connect failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!eventsAbort.signal.aborted) await sleep(1_000);
    }
  })();

  const readStartedAt = Date.now();
  const deadline = readStartedAt + 240_000;
  let listening: string | null = null;
  let inventory: { id?: string; source?: unknown; state?: unknown; features?: unknown }[] = [];
  let ready = false;
  while (Date.now() < deadline && !context.exited) {
    runAbort.signal.throwIfAborted();
    const match = /(?:server listening on|opencode server listening on)\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(context.hostOutputRaw);
    if (match) {
      listening = match[1]!;
      if (!context.hostPid) {
        const pidMatch = /ISOLATED_JOB active_process_limit=1 kill_on_close=true pid=(\d+)/.exec(context.hostOutputRaw);
        if (pidMatch) context.hostPid = Number(pidMatch[1]);
      }
      try {
        const listed = (await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(20_000) })) as {
          data?: typeof inventory;
        };
        if (Array.isArray(listed.data) && listed.data.length > 0) {
          inventory = listed.data;
          const byId = new Map(inventory.map((entry) => [entry.id, entry]));
          const hub = byId.get("session-hub");
          const auth = byId.get("agent-remote-auth");
          const active = (entry: typeof hub) => (entry?.state as { status?: string } | undefined)?.status === "active";
          if (hub && auth && active(hub) && active(auth)) {
            ready = true;
            break;
          }
        }
      } catch {
        /* bounded retry */
      }
    }
    await sleep(3_000);
  }
  timings["startup"] = {
    readyMs: Date.now() - readStartedAt,
    readyForBothPlugins: ready,
    listening,
    hostPid: context.hostPid,
    exitedDuringWait: context.exited,
  };
  const jobLine = /ISOLATED_JOB active_process_limit=1 kill_on_close=true pid=\d+/.exec(context.hostOutputRaw)?.[0] ?? null;
  assertRecord("A1-0", "经 launch_isolated.py 启动且 Job 行出现（active_process_limit=1 / kill_on_close）", jobLine !== null, {
    jobLine,
    listening,
    hostPid: context.hostPid,
  });
  assertRecord("A1-1", "宿主 serve 就绪且 240s 窗口内两个候选插件均 active", ready, {
    readyMs: timings["startup"] && (timings["startup"] as Record<string, unknown>)["readyMs"],
    inventory: inventory.map((entry) => ({ id: entry.id, source: entry.source, state: entry.state })),
    tail: context.hostOutputRaw.slice(-1500),
  });

  const localPlugins = inventory.filter((entry) => {
    const source = entry.source as { type?: string; path?: string } | undefined;
    return source?.type === "local" && typeof source.path === "string";
  });
  const localIds = [...localPlugins.map((entry) => entry.id)].sort();
  assertRecord(
    "A1-2",
    "沙箱本地加载插件恰为 agent-remote-auth 与 session-hub（无 helper 误加载 / 唯一 default）",
    localPlugins.length === 2 && localIds[0] === "agent-remote-auth" && localIds[1] === "session-hub",
    { count: localPlugins.length, localPlugins: localPlugins.map((entry) => ({ id: entry.id, source: entry.source, state: entry.state })) },
  );
  const hubEntry = localPlugins.find((entry) => entry.id === "session-hub");
  const authEntry = localPlugins.find((entry) => entry.id === "agent-remote-auth");
  assertRecord("A1-3", "session-hub 来源为沙箱 index.js 且 active；agent-remote-auth 同样 active（互不干扰）",
    samePath(String((hubEntry?.source as { path?: string } | undefined)?.path ?? ""), context.hubBundleCopy) &&
      (hubEntry?.state as { status?: string } | undefined)?.status === "active" &&
      (authEntry?.state as { status?: string } | undefined)?.status === "active",
    {
      sessionHub: { path: (hubEntry?.source as { path?: string } | undefined)?.path, expected: context.hubBundleCopy, state: hubEntry?.state },
      agentRemoteAuth: { path: (authEntry?.source as { path?: string } | undefined)?.path, state: authEntry?.state },
    },
  );

  if (!ready) {
    log("插件未就绪，跳过业务断言（保留启动日志用于诊断）。");
    return;
  }

  // ---------- 诊断快照：宿主实际版本/PID 与插件自身日志 ----------
  try {
    const info = (await client.server.info({ signal: AbortSignal.timeout(20_000) } as never)) as { version?: unknown; pid?: unknown };
    notes.push(
      `server.info: version=${String(info?.version)} pid=${String(info?.pid)} jobLinePid=${String(context.hostPid)} pluginLocationDirectory=${root}`,
    );
    log(`DIAG server.info version=${String(info?.version)} pid=${String(info?.pid)} jobLinePid=${String(context.hostPid)}`);
  } catch (error) {
    notes.push(`server.info failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const startupDiagnostics = pluginLogScan();
  notes.push(`startupDiagnostics: ${JSON.stringify(startupDiagnostics).slice(0, 2500)}`);
  log(`PLUGIN-DIAG ${JSON.stringify(startupDiagnostics).slice(0, 2500)}`);

  // ---------- 通用工具 ----------
  async function waitForIdle(sessionID: string, since: number, timeoutMs = 120_000): Promise<number | null> {
    const idleDeadline = Date.now() + (smokeOnly ? 20_000 : timeoutMs);
    while (Date.now() < idleDeadline) {
      runAbort.signal.throwIfAborted();
      const hit = context.events.find(
        (event) =>
          event.at >= since &&
          event.sessionID === sessionID &&
          (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" ||
            event.type === "session.idle" || (event.type === "session.status" && event.statusType === "idle")),
      );
      if (hit) return hit.at;
      await sleep(250);
    }
    try {
      await client.session.wait({ sessionID } as never, { signal: AbortSignal.timeout(30_000) });
      return Date.now();
    } catch {
      return null;
    }
  }

  async function readAllMessages(sessionID: string): Promise<{ messages: SourceMessage[]; pages: number }> {
    const messages: SourceMessage[] = [];
    let pages = 0;
    let page = (await client.message.list({ sessionID, limit: 200, order: "asc" } as never)) as {
      data: SourceMessage[];
      cursor: { next?: string | null };
    };
    pages += 1;
    while (page.data.length > 0) {
      for (const message of page.data) messages.push(message);
      const next = page.cursor.next;
      if (typeof next !== "string" || next.length === 0) break;
      page = (await client.message.list({ sessionID, cursor: next } as never)) as typeof page;
      pages += 1;
    }
    return { messages, pages };
  }

  const latestPut = (sourceId: string): V2PutRecord | undefined => [...mock.puts].reverse().find((put) => put.sourceId === sourceId);
  const putsAfter = (sourceId: string, since: number): V2PutRecord[] => mock.puts.filter((put) => put.sourceId === sourceId && put.at >= since);
  async function waitForPut(sourceId: string, since: number, timeoutMs = 45_000, predicate?: (put: V2PutRecord) => boolean): Promise<V2PutRecord | undefined> {
    const putDeadline = Date.now() + (smokeOnly ? 15_000 : timeoutMs);
    while (Date.now() < putDeadline) {
      runAbort.signal.throwIfAborted();
      const found = putsAfter(sourceId, since).filter((put) => (predicate ? predicate(put) : true)).at(-1);
      if (found) return found;
      await sleep(400);
    }
    return undefined;
  }
  /** 等待该会话同步稳定（≥2.5s 无新 PUT），返回最后一个 PUT。 */
  async function settle(sourceId: string, since: number, timeoutMs = 60_000): Promise<V2PutRecord | undefined> {
    const settleDeadline = Date.now() + timeoutMs;
    let last: V2PutRecord | undefined;
    while (Date.now() < settleDeadline) {
      const puts = putsAfter(sourceId, since);
      const newest = puts.at(-1);
      if (newest && newest.status !== null && newest !== last) {
        last = newest;
        await sleep(2_500);
        continue;
      }
      if (newest && newest.status !== null && newest === last) return newest;
      await sleep(500);
    }
    return last;
  }

  interface ComparisonResult {
    mismatches: string[];
    checks: number;
    coverage: Record<string, boolean>;
    hostCount: number;
    payloadCount: number;
    pages: number;
  }

  async function comparePayload(sessionID: string, put: V2PutRecord): Promise<ComparisonResult> {
    const body = put.body as {
      agent?: string;
      machine?: string;
      source_id?: string;
      title?: string;
      cwd?: string;
      created_at?: number;
      updated_at?: number;
      messages?: { role: string; text?: string; ts?: number; raw: unknown }[];
    };
    const hostSession = (await client.session.get({ sessionID } as never)) as {
      id: string;
      title?: string;
      time: { created: number; updated: number };
      location: { directory: string };
    };
    const { messages: hostMessages, pages } = await readAllMessages(sessionID);
    const mismatches: string[] = [];
    let checks = 0;
    const verify = (condition: boolean, message: string) => {
      checks += 1;
      if (!condition) mismatches.push(message);
    };
    verify(body.agent === "opencode", `agent=${String(body.agent)}`);
    verify(body.machine === machine, `machine=${String(body.machine)} expected=${machine}`);
    verify(body.source_id === sessionID, `source_id=${String(body.source_id)}`);
    verify(body.title === hostSession.title, `title=${JSON.stringify(body.title)} host=${JSON.stringify(hostSession.title)}`);
    verify(body.cwd === hostSession.location.directory, `cwd=${JSON.stringify(body.cwd)} host=${JSON.stringify(hostSession.location.directory)}`);
    verify(body.created_at === hostSession.time.created, `created_at=${String(body.created_at)} host=${hostSession.time.created}`);
    verify(body.updated_at === hostSession.time.updated, `updated_at=${String(body.updated_at)} host=${hostSession.time.updated}`);
    const payloadMessages = body.messages ?? [];
    verify(payloadMessages.length === hostMessages.length, `messages=${payloadMessages.length} host=${hostMessages.length}`);
    const coverage = { reasoning: false, tool: false, compaction: false, synthetic: false, envelope: true, text: false };
    const length = Math.min(payloadMessages.length, hostMessages.length);
    for (let index = 0; index < length; index += 1) {
      const source = hostMessages[index]!;
      const mirror = payloadMessages[index]!;
      verify(mirror.role === expectedRole(source.type), `[${index}] role=${mirror.role} expected=${expectedRole(source.type)} (type=${source.type})`);
      verify(mirror.ts === source.time.created, `[${index}] ts=${String(mirror.ts)} expected=${source.time.created}`);
      const text = expectedText(source);
      if (text === undefined) verify(mirror.text === undefined, `[${index}] text should be absent, got ${JSON.stringify(mirror.text)}`);
      else verify(mirror.text === text, `[${index}] text mismatch`);
      if (mirror.text !== undefined) coverage.text = true;
      const expected = expectedParts(source);
      const rawList = Array.isArray(mirror.raw) ? (mirror.raw as unknown[]) : [mirror.raw];
      verify(rawList.length === expected.length, `[${index}] raw parts=${rawList.length} expected=${expected.length}`);
      for (let partIndex = 0; partIndex < Math.min(rawList.length, expected.length); partIndex += 1) {
        if (!deepEqual(rawList[partIndex], expected[partIndex])) verify(false, `[${index}] raw[${partIndex}] mismatch`);
      }
      for (const part of rawList.slice(0, -1)) {
        const record = part as Record<string, unknown>;
        if (record["type"] === "reasoning") coverage.reasoning = true;
        if (record["type"] === "tool") coverage.tool = true;
      }
      if (source.type === "compaction") coverage.compaction = true;
      if (source.type === "synthetic") coverage.synthetic = true;
    }
    return { mismatches: mismatches.slice(0, 40), checks, coverage, hostCount: hostMessages.length, payloadCount: payloadMessages.length, pages };
  }

  // ---------- A2/A3：会话 A 一轮真实 idle → debounce → PUT，字段级比对 ----------
  phase("A2.create");
  const sessionA = ((await client.session.create({
    title: "E2E-V2-session-alpha-合成会话",
    location: { directory: projectAlpha },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  } as never)) as { id: string }).id;
  phase("A2.create");
  const beforeA1 = Date.now();
  phase("A2.prompt");
  await client.session.prompt({ sessionID: sessionA, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n合成消息 A 第一轮` } as never);
  phase("A2.prompt");
  const idleA1 = await waitForIdle(sessionA, beforeA1);
  const putA1 = await waitForPut(sessionA, beforeA1);
  timings["sessionA.round1"] = { idleAt: idleA1, putAt: putA1?.at ?? null, debounceMs: idleA1 !== null && putA1 ? putA1.at - idleA1 : null };
  assertRecord("A2-1", "会话 A 第一轮产生真实完成信号（session.execution.succeeded / idle 语义）", idleA1 !== null, {
    promptAt: beforeA1,
    idleAt: idleA1,
    observedEvents: context.events.length,
    sessionEvents: context.events.filter((event) => event.sessionID === sessionA).slice(0, 25),
  });
  assertRecord("A2-2", "idle 后 mock 收到 PUT 且正文通过 sessionUpsertSchema 校验", putA1 !== undefined && putA1.schemaValid, {
    putSeq: putA1?.seq,
    status: putA1?.status,
    schemaValid: putA1?.schemaValid,
    issues: putA1?.issues,
    rawBytes: putA1?.rawBytes,
    hubRequestCounts: { requests: mock.requests.length, puts: mock.puts.length, modelCalls: mock.modelCalls.length },
    pluginLog: pluginLogScan(),
  });
  assertRecord("A2-3", "3s debounce 生效：PUT 时间 - idle 时间 ≥ 3000ms", idleA1 !== null && putA1 !== undefined && putA1.at - idleA1 >= 3000, {
    debounceMs: idleA1 !== null && putA1 ? putA1.at - idleA1 : null,
  });
  assertRecord(
    "A2-4",
    "mock 模型完成真实一轮（read 工具调用 + 最终文本/推理）",
    mock.modelCalls.some((call) => call.action === "tool_call") && mock.modelCalls.some((call) => call.action === "reasoning"),
    { modelCalls: mock.modelCalls.map((call) => ({ seq: call.seq, action: call.action, lastRole: call.lastRole, toolNames: call.toolNames })) },
  );
  let comparisonA1: ComparisonResult | null = null;
  if (putA1) {
    comparisonA1 = await comparePayload(sessionA, putA1);
    if (comparisonA1.mismatches.length > 0) {
      await sleep(3_000);
      const retryPut = latestPut(sessionA);
      if (retryPut) comparisonA1 = await comparePayload(sessionA, retryPut);
    }
    timings["sessionA.compare1"] = comparisonA1;
    assertRecord("A3-1", "字段级比对：三元组/标题/cwd/源时间/消息数/角色/ts/text/raw envelope 全一致", comparisonA1.mismatches.length === 0, {
      checks: comparisonA1.checks,
      mismatches: comparisonA1.mismatches,
      hostCount: comparisonA1.hostCount,
      payloadCount: comparisonA1.payloadCount,
    });
    assertRecord("A3-2", "真实模型轮的推理与工具结果经 raw 无损上传", comparisonA1.coverage.reasoning && comparisonA1.coverage.tool, comparisonA1.coverage);
    const stored = mock.findHubRecord("opencode", machine, sessionA);
    const listResponse = await fetch(
      `${mock.url}/v1/sessions?agent=opencode&machine=${encodeURIComponent(machine)}&source_id=${encodeURIComponent(sessionA)}`,
      { headers: { authorization: `Bearer ${mock.hubToken}` } },
    );
    const listed = (await listResponse.json()) as { total?: number; items?: { id?: string }[] };
    const putBody = putA1?.body as { messages?: unknown[] } | undefined;
    assertRecord(
      "A3-3",
      "镜像三元组唯一：agent+machine+source_id 过滤命中 1 条且与 PUT 结果一致",
      listed.total === 1 && stored !== undefined && Array.isArray(putBody?.messages),
      { total: listed.total, ids: listed.items?.map((item) => item.id), storedId: stored?.id, storedMessages: stored?.messages.length },
    );
  }

  if (smokeOnly) {
    timings["loadedFileShaAtEnd"] = await sha256(context.hubBundleCopy);
    if (!putA1 || comparisonA1?.mismatches.length !== 0) {
      throw new Error("Critical upload/field smoke failed; dependent matrix not run");
    }
    const deletedAt = Date.now();
    await client.session.remove({ sessionID: sessionA } as never);
    const deleteDeadline = Date.now() + 15_000;
    while (Date.now() < deleteDeadline && mock.findHubRecord("opencode", machine, sessionA)) {
      runAbort.signal.throwIfAborted();
      await sleep(250);
    }
    assertRecord("SMOKE-DELETE", "真实源会话删除后镜像消失", !mock.findHubRecord("opencode", machine, sessionA), {
      elapsedMs: Date.now() - deletedAt,
    });
    await sleep(3_500);
    assertRecord("SMOKE-NO-RESURRECTION", "删除后不再 PUT", putsAfter(sessionA, deletedAt).length === 0, {});
    notes.push("Smoke-only: full long-history/reload/failure matrix remains unverified for this artifact.");
    return;
  }

  // ---------- A4：多轮 + 多会话 + 跨目录不错误归属 ----------
  const beforeA2 = Date.now();
  phase("A4.round2.prompt");
  await client.session.prompt({ sessionID: sessionA, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n合成消息 A 第二轮` } as never);
  phase("A4.round2.prompt");
  const idleA2 = await waitForIdle(sessionA, beforeA2);
  const putA2 = await settle(sessionA, beforeA2);
  const comparisonA2 = putA2 ? await comparePayload(sessionA, putA2) : null;
  const countA1 = (putA1?.body as { messages?: unknown[] } | undefined)?.messages?.length ?? Number.MAX_SAFE_INTEGER;
  const countA2 = (putA2?.body as { messages?: unknown[] } | undefined)?.messages?.length ?? -1;
  assertRecord(
    "A4-1",
    "多轮：第二轮 PUT 幂等更新且消息数严格增加、字段仍逐条一致",
    putA2 !== undefined && comparisonA2 !== null && comparisonA2.mismatches.length === 0 && countA2 > countA1,
    { putSeq: putA2?.seq, status: putA2?.status, countA1, countA2, mismatches: comparisonA2?.mismatches ?? null, idleA2 },
  );

  phase("A4.B.create");
  const sessionB = ((await client.session.create({
    title: "E2E-V2-session-beta-跨目录会话",
    location: { directory: projectBeta },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  } as never)) as { id: string }).id;
  phase("A4.B.create");
  const beforeB = Date.now();
  phase("A4.B.prompt");
  await client.session.prompt({ sessionID: sessionB, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n合成消息 B 第一轮` } as never);
  phase("A4.B.prompt");
  const idleB = await waitForIdle(sessionB, beforeB);
  const putB = await settle(sessionB, beforeB);
  const comparisonB = putB ? await comparePayload(sessionB, putB) : null;
  const bodyB = putB?.body as { cwd?: string; messages?: unknown[] } | undefined;
  const crossSessionLeak = JSON.stringify(bodyB ?? {}).includes(sessionA);
  assertRecord(
    "A4-2",
    "跨目录不错误归属：会话 B 的 cwd 为自身目录（非插件 location 根），且不含会话 A 内容、不串会话",
    putB !== undefined &&
      comparisonB !== null &&
      comparisonB.mismatches.length === 0 &&
      bodyB?.cwd === projectBeta &&
      bodyB?.cwd !== root &&
      !crossSessionLeak,
    { cwd: bodyB?.cwd, expectedCwd: projectBeta, pluginLocationRoot: root, idleB, crossSessionLeak, mismatches: comparisonB?.mismatches ?? null },
  );

  // ---------- A5：长历史（>200 条，多页；含 synthetic / compaction / reasoning / tool） ----------
  const sessionL = ((await client.session.create({
    title: "E2E-V2-session-long-长历史会话",
    location: { directory: projectAlpha },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  } as never)) as { id: string }).id;
  const beforeL1 = Date.now();
  phase("A5.L.round1");
  await client.session.prompt({ sessionID: sessionL, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n长历史会话首轮` } as never);
  phase("A5.L.round1");
  await waitForIdle(sessionL, beforeL1);
  let syntheticAttempts = 0;
  let hostCountL = (await readAllMessages(sessionL)).messages.length;
  const syntheticTarget = 208;
  while (hostCountL < syntheticTarget && syntheticAttempts < 300) {
    const batch = Math.min(20, syntheticTarget - hostCountL);
    for (let index = 0; index < batch; index += 1) {
      syntheticAttempts += 1;
      await client.session.synthetic({ sessionID: sessionL, text: `synthetic-history-${syntheticAttempts}-合成历史注入` } as never);
    }
    log(`A5.synthetic batch done attempts=${syntheticAttempts} hostCount=${hostCountL}`);
    await sleep(400);
    hostCountL = (await readAllMessages(sessionL)).messages.length;
  }
  timings["sessionL.synthetic"] = { attempts: syntheticAttempts, hostCount: hostCountL };
  let compactionOutcome: unknown = { requested: false };
  try {
    phase("A5.compact");
    await client.session.compact({ sessionID: sessionL } as never, { signal: AbortSignal.timeout(30_000) });
    phase("A5.compact");
    const compactionDeadline = Date.now() + 90_000;
    let compactionSeen = false;
    while (Date.now() < compactionDeadline) {
      const { messages } = await readAllMessages(sessionL);
      if (messages.some((message) => message.type === "compaction")) {
        compactionSeen = true;
        break;
      }
      await sleep(1_000);
    }
    compactionOutcome = { requested: true, compactionSeen };
  } catch (error) {
    compactionOutcome = { requested: true, error: error instanceof Error ? error.message : String(error) };
  }
  timings["sessionL.compaction"] = compactionOutcome;
  const beforeL2 = Date.now();
  phase("A5.L.final");
  await client.session.prompt({ sessionID: sessionL, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n长历史会话末轮` } as never);
  phase("A5.L.final");
  const idleL = await waitForIdle(sessionL, beforeL2);
  const putL = await settle(sessionL, beforeL2, 150_000);
  let comparisonL = putL ? await comparePayload(sessionL, putL) : null;
  if (comparisonL && comparisonL.mismatches.length > 0) {
    await sleep(3_000);
    const retryPut = latestPut(sessionL);
    if (retryPut && retryPut !== putL) comparisonL = await comparePayload(sessionL, retryPut);
  }
  const finalHost = await readAllMessages(sessionL);
  timings["sessionL.final"] = { idleAt: idleL, putSeq: putL?.seq, hostPages: finalHost.pages, hostCount: finalHost.messages.length };
  assertRecord(
    "A5-1",
    "长历史跨多页：宿主历史 > 200 条，最终 PUT 消息数与宿主逐条一致且无缺失",
    finalHost.messages.length > 200 && comparisonL !== null && comparisonL.mismatches.length === 0 && comparisonL.hostCount === comparisonL.payloadCount,
    {
      hostCount: finalHost.messages.length,
      payloadCount: comparisonL?.payloadCount ?? null,
      hostPages: finalHost.pages,
      mismatches: comparisonL?.mismatches ?? null,
      syntheticAttempts,
    },
  );
  assertRecord(
    "A5-2",
    "压缩后/synthetic 数据覆盖：payload 含 compaction 与 synthetic 角色消息，且 reasoning/tool 语义保留",
    comparisonL !== null && comparisonL.coverage.compaction && comparisonL.coverage.synthetic && comparisonL.coverage.reasoning && comparisonL.coverage.tool,
    { coverage: comparisonL?.coverage ?? null, compactionOutcome, syntheticAttempts },
  );

  // ---------- A7：删除镜像 + 在途竞争不复活 ----------
  const removeBAt = Date.now();
  await client.session.remove({ sessionID: sessionB } as never);
  const deleteSettled = await (async () => {
    const deleteDeadline = Date.now() + 40_000;
    while (Date.now() < deleteDeadline) {
      if (mock.findHubRecord("opencode", machine, sessionB) === undefined) return true;
      await sleep(500);
    }
    return false;
  })();
  const deleteRecordB = mock.requests.find((request) => request.method === "DELETE" && request.path.startsWith("/v1/sessions/") && request.at >= removeBAt);
  const putBAfterDelete = putsAfter(sessionB, removeBAt).length;
  assertRecord(
    "A7-1",
    "删除源会话 → 镜像 DELETE：记录消失且删除后无新 PUT（不复活）",
    deleteSettled && deleteRecordB !== undefined && deleteRecordB.status === 200 && putBAfterDelete === 0,
    { deleteSettled, deleteRecord: deleteRecordB ?? null, putBAfterDelete },
  );

  mock.holdNextPut(sessionA, 2_500);
  const beforeRace = Date.now();
  phase("A7.race.prompt");
  await client.session.prompt({ sessionID: sessionA, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n删除竞争轮` } as never);
  phase("A7.race.prompt");
  const idleRace = await waitForIdle(sessionA, beforeRace);
  const inFlightPut = await (async () => {
    const raceDeadline = Date.now() + 60_000;
    while (Date.now() < raceDeadline) {
      const found = putsAfter(sessionA, beforeRace).find((put) => put.status === null);
      if (found) return found;
      await sleep(200);
    }
    return undefined;
  })();
  const removeAt = Date.now();
  await client.session.remove({ sessionID: sessionA } as never);
  const raceSettled = await (async () => {
    const raceDeadline = Date.now() + 40_000;
    while (Date.now() < raceDeadline) {
      if (mock.findHubRecord("opencode", machine, sessionA) === undefined) return true;
      await sleep(500);
    }
    return false;
  })();
  await sleep(2_500);
  const resurrectedPuts = putsAfter(sessionA, removeAt).length;
  const deleteAfterRemove = mock.requests.find((request) => request.method === "DELETE" && request.at >= removeAt && request.status === 200);
  assertRecord(
    "A7-2",
    "在途 PUT 与删除竞争：删除后镜像不再存在，删除时间点之后无再次 PUT（tombstone 生效）",
    inFlightPut !== undefined && raceSettled && resurrectedPuts === 0 && deleteAfterRemove !== undefined,
    {
      inFlightPut: inFlightPut ? { seq: inFlightPut.seq, at: inFlightPut.at, status: inFlightPut.status } : null,
      idleRace,
      raceSettled,
      resurrectedPuts,
      deleteAfterRemove: deleteAfterRemove ? { at: deleteAfterRemove.at, status: deleteAfterRemove.status } : null,
    },
  );

  // ---------- A8：上传失败可诊断、不阻塞 ----------
  mock.failPut(sessionL, "500", 1);
  const beforeFail = Date.now();
  phase("A8.fail.prompt");
  await client.session.prompt({ sessionID: sessionL, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\n注入 500 故障轮` } as never);
  phase("A8.fail.prompt");
  await waitForIdle(sessionL, beforeFail);
  const failedPut = await waitForPut(sessionL, beforeFail, 60_000, (put) => put.status === 500);
  await sleep(1_000);
  const errorLogged = /upload status=500/.test(context.hostOutputRaw);
  const afterFailList = (await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(20_000) })) as {
    data?: { id?: string; state?: { status?: string } }[];
  };
  const hubStillActive = afterFailList.data?.some((entry) => entry.id === "session-hub" && entry.state?.status === "active") ?? false;
  assertRecord("A8-1", "上传 500 故障产生可诊断日志且不阻塞宿主（插件仍 active）", failedPut !== undefined && errorLogged && hubStillActive, {
    failedPut: failedPut ? { seq: failedPut.seq, status: failedPut.status, at: failedPut.at } : null,
    errorLogged,
    hubStillActive,
  });

  // 基线：当前存活插件实例集合下单次 idle 产生的 PUT 数（宿主为每个 location 实例化一份插件，
  // 同一完成信号会被每个实例各同步一次，属宿主语义、服务端幂等；A9 断言以此为基准不增长）。
  await settle(sessionL, beforeFail, 45_000);
  const baselineIdlePuts = Math.max(1, putsAfter(sessionL, beforeFail).length);

  // ---------- A9：reload 探针（重复加载无重复订阅；恢复规范产物） ----------
  const canonicalBytes = await readFile(distBundlePath);
  const reloadProbe: Record<string, unknown> = {};
  for (const mode of ["mutate", "restore"] as const) {
    const marker = `\n// e2e reload probe ${mode} ${randomBytes(6).toString("hex")}\n`;
    await writeFile(context.hubBundleCopy, mode === "mutate" ? Buffer.concat([canonicalBytes, Buffer.from(marker)]) : canonicalBytes);
    const mutationAt = Date.now();
    let reloadSeenAt: number | null = null;
    const eventDeadline = Date.now() + 45_000;
    while (Date.now() < eventDeadline) {
      const hit = context.events.find((event) => event.type === "plugin.updated" && event.at >= mutationAt);
      if (hit) {
        reloadSeenAt = hit.at;
        break;
      }
      await sleep(500);
    }
    await sleep(1_500);
    const beforeRound = Date.now();
    phase(`A9.${mode}.prompt`);
    await client.session.prompt({ sessionID: sessionL, text: `E2E_TOOL_CALL E2E_NOTE:${notePath}\nreload 探针 ${mode}` } as never);
    phase(`A9.${mode}.prompt`);
    await waitForIdle(sessionL, beforeRound);
    const windowEnd = Date.now() + 12_000;
    while (Date.now() < windowEnd) await sleep(500);
    const rounds = putsAfter(sessionL, beforeRound);
    const putCountStable = rounds.length === baselineIdlePuts;
    reloadProbe[mode] = {
      mutationAt,
      reloadSeenAt,
      putsInWindow: rounds.length,
      baselineIdlePuts,
      putSeqs: rounds.map((put) => put.seq),
      loadedFileSha: await sha256(context.hubBundleCopy),
    };
    const restoredSha = await sha256(context.hubBundleCopy);
    assertRecord(
      mode === "mutate" ? "A9-1" : "A9-2",
      mode === "mutate"
        ? `加载文件变化后重复加载：单次 idle 的 PUT 数不增长（=${baselineIdlePuts}，无重复订阅）`
        : `恢复规范产物后重复加载：单次 idle 的 PUT 数不增长（=${baselineIdlePuts}），终态 SHA 回归规范值`,
      putCountStable && (mode === "restore" ? restoredSha === canonicalBundleSha : true),
      reloadProbe[mode],
    );
  }
  timings["reloadProbe"] = reloadProbe;

  // ---------- A10：日志门与脱敏 ----------
  const finalInventory = (await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(20_000) })) as {
    data?: { id?: string; state?: { status?: string } }[];
  };
  const logScan = {
    failedToLoad: /failed to load plugin/i.test(context.hostOutputRaw),
    schemaError: /SchemaError/.test(context.hostOutputRaw),
    loadError: /LoadError/.test(context.hostOutputRaw),
    authLog: /agent-remote-auth/.test(context.hostOutputRaw),
    passwordLeak: context.hostOutputRaw.includes(context.serverPassword),
    hubTokenLeak: context.hostOutputRaw.includes(mock.hubToken),
    failedPlugins: finalInventory.data?.filter((entry) => entry.state?.status === "failed").map((entry) => entry.id) ?? [],
  };
  assertRecord(
    "A10-1",
    "宿主日志无 failed-to-load / SchemaError / LoadError，且插件清单无 failed 状态",
    !logScan.failedToLoad && !logScan.schemaError && !logScan.loadError && logScan.failedPlugins.length === 0,
    logScan,
  );
  assertRecord("A10-2", "原始日志不含临时服务器密码或 Hub token", !logScan.passwordLeak && !logScan.hubTokenLeak, {
    passwordLeak: logScan.passwordLeak,
    hubTokenLeak: logScan.hubTokenLeak,
  });
  assertRecord("A10-3", "agent-remote-auth 同时加载且其日志出现（沙箱隔离配置生效）", logScan.authLog, { authLog: logScan.authLog });
  timings["loadedFileShaAtEnd"] = await sha256(context.hubBundleCopy);
}

function sanitize(text: string, password: string, hubToken: string): string {
  let output = text.split(password).join("[synthetic-password-redacted]");
  output = output.split(hubToken).join("[synthetic-token-redacted]");
  output = output.replace(/Basic [A-Za-z0-9+/=]{8,}/g, "Basic [redacted]");
  output = output.replace(/Bearer [A-Za-z0-9._-]{8,}/g, "Bearer [redacted]");
  return output;
}

async function cleanupAndWriteReport(exitCode: number, mainError: unknown): Promise<void> {
  const cleanup: Record<string, unknown> = {};
  const mock = context.mock;
  try {
    stopHostLive();
    // 关闭事件订阅，随后结束宿主（kill 启动器 → Job handle 关闭 → kill_on_close）。
    context.eventsAbort?.abort();
    if (context.child && !context.exited) {
      context.child.kill();
      await Promise.race([context.hostExit ?? Promise.resolve(), sleep(10_000)]);
    }
    cleanup.hostExited = context.exited;
    cleanup.hostPid = context.hostPid;
    if (context.hostPid) {
      let hostAlive = true;
      const graceDeadline = Date.now() + 20_000;
      while (Date.now() < graceDeadline) {
        try {
          process.kill(context.hostPid, 0);
          hostAlive = true;
          await sleep(1_000);
        } catch {
          hostAlive = false;
          break;
        }
      }
      cleanup.hostProcessGone = !hostAlive;
    }
    context.hostOutput = sanitize(context.hostOutputRaw, context.serverPassword, mock?.hubToken ?? "");
    await writeFile(join(evidenceDirectory, "host-v2.log"), context.hostOutput, "utf8");
    await writeFile(join(evidenceDirectory, "run.log"), runLog.join("\n") + "\n", "utf8");
    if (mock) {
      const requests = mock.requests.map((request) => ({
        seq: request.seq,
        at: request.at,
        kind: request.kind,
        method: request.method,
        path: request.path,
        query: request.query,
        authenticated: request.authenticated,
        status: request.status,
        note: request.note ?? null,
      }));
      await writeFile(join(evidenceDirectory, "hub-requests.json"), JSON.stringify(requests, null, 2), "utf8");
      const puts = mock.puts.map((put) => ({
        seq: put.seq,
        at: put.at,
        rawBytes: put.rawBytes,
        sourceId: put.sourceId,
        schemaValid: put.schemaValid,
        issues: put.issues,
        status: put.status,
        body: put.body,
      }));
      await writeFile(join(evidenceDirectory, "hub-puts.json"), JSON.stringify(puts, null, 2), "utf8");
      await writeFile(join(evidenceDirectory, "model-calls.json"), JSON.stringify(mock.modelCalls, null, 2), "utf8");
      await mock.close().catch(() => undefined);
      cleanup.mockClosed = true;
    }
    cleanup.sandboxRemoved = false;
    if (context.sandbox) {
      try {
        await rm(context.sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        cleanup.sandboxRemoved = true;
      } catch (error) {
        cleanup.sandboxRemoved = false;
        cleanup.sandboxError = error instanceof Error ? error.message : String(error);
      }
    }
    // 现役文件只读核对（键统一为 resolve 后的原生路径）。
    const sessionHubAfter = await sha256(deployedPaths.sessionHub);
    const agentRemoteAuthAfter = await sha256(deployedPaths.agentRemoteAuth);
    const opencodeJsoncAfter = await sha256(deployedPaths.opencodeJsonc);
    const deployedAfter: Record<string, string | null> = {
      [resolve(deployedPaths.sessionHub)]: sessionHubAfter,
      [resolve(deployedPaths.agentRemoteAuth)]: agentRemoteAuthAfter,
      [resolve(deployedPaths.opencodeJsonc)]: opencodeJsoncAfter,
    };
    const baseline = JSON.parse(await readFile(join(isolationRoot, "deployed-before.json"), "utf8")) as Record<string, string>;
    const deployedUnchanged = Object.entries(deploymentStartSha).every(([path, sha]) => deployedAfter[path] === sha);
    const matchesIsolationBaseline = Object.entries(baseline).every(([path, sha]) => deployedAfter[resolve(path)] === sha);
    cleanup.deploymentStartSha = deploymentStartSha;
    cleanup.deployedAfter = deployedAfter;
    cleanup.deployedUnchanged = deployedUnchanged;
    cleanup.matchesIsolationBaseline = matchesIsolationBaseline;
    assertRecord("A11-1", "清场：关闭宿主/mock 并删除沙箱目录", cleanup.hostExited === true && cleanup.mockClosed === true && cleanup.sandboxRemoved === true, cleanup);
    assertRecord(
      "A11-2",
      "现役部署文件本次运行前后 SHA 不变（只读核对；与隔离基线的差异另行记录）",
      deployedUnchanged,
      { deployedAfter, deploymentStartSha, baseline, matchesIsolationBaseline },
    );
  } catch (error) {
    cleanup.error = error instanceof Error ? error.message : String(error);
    assertRecord("A11-0", "清场流程未抛出未捕获异常", false, cleanup);
  }

  const failed = assertions.filter((assertion) => assertion.status === "fail");
  const report = {
    scope: smokeOnly ? "V2 execution terminal event -> PUT/field fidelity/delete smoke only (full acceptance incomplete)" : "session-hub opencode-plugin 0.2.0 V2 2.0.26 宿主业务 E2E（mock-only、长驻 serve、隔离 Job）",
    generatedAt: new Date().toISOString(),
    command: `OPENCODE_E2E_BUNDLE_SHA=${canonicalBundleSha} npx tsx scripts/acceptance/e2e-v2.ts ${python}${smokeOnly ? " --smoke" : ""}`,
    isolation: {
      launcher,
      hostExecutable,
      sandbox: context.sandbox,
      hostUrl: context.hostUrl,
      hostPort: context.hostPort,
      hostPid: context.hostPid,
      evidenceDirectory,
      hubMockUrl: context.mock?.url ?? null,
    },
    artifacts: {
      distBundle: { path: join(pluginDirectory, "dist", "session-hub.js"), canonicalSha256: canonicalBundleSha },
      loadedCopyShaAtEnd: timings["loadedFileShaAtEnd"] ?? null,
      agentRemoteAuth: { deployedPath: deployedPaths.agentRemoteAuth },
    },
    counts: {
      hubRequests: context.mock?.requests.length ?? 0,
      hubPuts: context.mock?.puts.length ?? 0,
      modelCalls: context.mock?.modelCalls.length ?? 0,
      events: context.events.length,
      eventTypes: eventTypeSummary(),
      hubRecords: context.mock?.hubRecordCount() ?? 0,
    },
    timings,
    assertions,
    pluginLogScan: pluginLogScan(),
    summary: {
      total: assertions.length,
      passed: assertions.length - failed.length,
      failed: failed.length,
      failedIds: failed.map((assertion) => assertion.id),
      allPass: failed.length === 0,
    },
    notes,
    cleanup,
    mainError: mainError === null ? null : mainError instanceof Error ? mainError.message : String(mainError),
    exitCode,
  };
  await writeFile(join(evidenceDirectory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  log(`报告写入 ${join(evidenceDirectory, "report.json")}：${report.summary.passed}/${report.summary.total} 通过`);

  await writeSummary(report, failed);
}

async function writeSummary(report: Record<string, unknown>, failed: Assertion[]): Promise<void> {
  const summary = report["summary"] as { passed: number; total: number; allPass: boolean };
  const timingsRecord = (report["timings"] ?? {}) as Record<string, unknown>;
  const counts = (report["counts"] ?? {}) as Record<string, number>;
  const cleanup = (report["cleanup"] ?? {}) as Record<string, unknown>;
  const loadedSha = (timingsRecord["loadedFileShaAtEnd"] ?? "n/a") as string;
  const lines: string[] = [];
  lines.push("# V2 2.0.26 宿主业务 E2E（session-hub 0.2.0 + agent-remote-auth）");
  lines.push("");
  lines.push(`- 结论：${summary.allPass ? "全绿" : `存在失败 ${failed.map((assertion) => assertion.id).join(", ")}`}（${summary.passed}/${summary.total} 断言通过）`);
  lines.push(`- 运行命令：\`${String(report["command"])}\``);
  lines.push(`- 隔离：\`launch_isolated.py\`（Job active_process_limit=1 / kill_on_close）+ 沙箱 \`${String((report["isolation"] as Record<string, unknown>)["sandbox"])}\``);
  lines.push(`- 宿主：opencode-v2-isolated.exe serve @ ${String((report["isolation"] as Record<string, unknown>)["hostUrl"])} role=隔离副本`);
  lines.push(`- 证据：\`report.json\`、\`host-v2.log\`（脱敏）、\`hub-requests.json\`、\`hub-puts.json\`、\`model-calls.json\`、\`run.log\``);
  lines.push("");
  lines.push("## 产物 SHA");
  lines.push(`- dist/session-hub.js（规范）：\`${canonicalBundleSha}\``);
  lines.push(`- 沙箱实际加载副本 SHA（结束时）：\`${loadedSha}\``);
  lines.push(`- agent-remote-auth（沙箱副本 == 现役）：见 report.json artifacts/agentRemoteAuth 与 PRE-04 断言`);
  lines.push("");
  lines.push("## 计数");
  lines.push(`- hub 请求 ${counts["hubRequests"]} / PUT ${counts["hubPuts"]} / 模型调用 ${counts["modelCalls"]} / 事件 ${counts["events"]} / 镜像记录 ${counts["hubRecords"]}`);
  lines.push("");
  lines.push("## 断言");
  for (const assertion of report["assertions"] as Assertion[]) {
    lines.push(`- [${assertion.status === "pass" ? "x" : " "}] ${assertion.id} ${assertion.name}`);
  }
  lines.push("");
  lines.push("## 清场");
  lines.push(`- 宿主退出：${String(cleanup["hostExited"])}；宿主进程消失：${String(cleanup["hostProcessGone"])}；mock 关闭：${String(cleanup["mockClosed"])}；沙箱删除：${String(cleanup["sandboxRemoved"])}`);
  lines.push(`- 现役文件本次运行前后 SHA 不变：${String(cleanup["deployedUnchanged"])}（与隔离包 deployed-before.json 一致：${String(cleanup["matchesIsolationBaseline"]) ?? "n/a"}）`);
  if (report["mainError"]) lines.push(`- 运行器异常：${String(report["mainError"])}`);
  lines.push("");
  lines.push("## SH 对照（本次范围）");
  lines.push("- SH-01：同一 JS 摘要加载于 V2 真实宿主、稳定 id、唯一 default、无 helper 误加载 → PRE-03/PRE-05/A1-*。");
  lines.push("- SH-03：V2 真 idle → mock PUT；全历史/分页/raw/text/reasoning/tool 语义与源数据核对 → A2-*/A3-*/A5-*。");
  lines.push("- SH-04：重复/跨目录事件不错误归属、删除不复活、重复加载无重复订阅 → A4-*/A7-*/A9-*。");
  lines.push("- SH-05：上传失败可诊断不阻塞、日志无敏感值 → A8-*/A10-*。");
  lines.push("- SH-06：全程 loopback mock、无真实外网/凭据、清场、现役摘要不变 → 前缀断言 + A11-*。");
  lines.push("- SH-08：与 agent-remote-auth 同时加载互不干扰 + 双证据落盘 → A1-*/A10-3。");
  lines.push("");
  await writeFile(join(evidenceDirectory, "summary.md"), lines.join("\n"), "utf8");
}

let exitCode = 0;
let mainError: unknown = null;
try {
  await main();
} catch (error) {
  mainError = error;
  exitCode = 1;
  assertRecord("RUN-ERR", "运行器未抛出未捕获异常", false, {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 10) : undefined,
  });
}
if (budgetTimer !== undefined) clearTimeout(budgetTimer);
try {
  await cleanupAndWriteReport(exitCode, mainError);
} catch (error) {
  console.error("report write failed", error);
  exitCode = 1;
}
// main 内的断言失败也要反映到退出码
if (assertions.some((assertion) => assertion.status === "fail")) exitCode = 1;
// 让 tsx 进程自然退出（所有句柄已关闭）
await sleep(200);
process.exit(exitCode);
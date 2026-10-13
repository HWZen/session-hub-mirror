import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { OpenCode } from "@opencode/client";
import { evaluateQualification } from "../test/helpers/qualification.js";

const isolationRoot = resolve(process.env["OPENCODE_E2E_ISOLATION_ROOT"] ?? join(homedir(), ".cache", "session-hub", "acceptance", "session-hub-opencode-v2-isolation"));
const isolationRulePrefix = "Hermes-OpenCode-Isolation-v2-20261013";
const expectedRemoteAddress = [
  "0.0.0.0-126.255.255.255",
  "128.0.0.0-255.255.255.255",
  "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
];
const python = process.argv[2];
const scratch = resolve(process.env["OPENCODE_E2E_SCRATCH"] ?? join(homedir(), ".cache", "session-hub", "acceptance"));
if (!python) throw new Error("Pass an explicit Windows Python executable");
const evidenceRoot = await mkdtemp(join(scratch, "opencode-host-qualification-"));
const outcomes: unknown[] = [];
const probeSource = `
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
function connection(host, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.connect({host, port});
    const done = result => { socket.destroy(); resolve({...result, ms: Date.now()-started}); };
    socket.setTimeout(3000, () => done({host, connected:false, code:'TIMEOUT'}));
    socket.once('connect', () => done({host, connected:true}));
    socket.once('error', error => done({host, connected:false, code:error.code}));
  });
}
async function qualify(generation, context) {
  const keys=['HOME','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','TEMP','TMP','TMPDIR','OPENCODE_CONFIG_DIR','OPENCODE_TEST_HOME','OPENCODE_TEST_MANAGED_CONFIG_DIR','OPENCODE_DB'];
  const root = process.env.PROBE_ROOT;
  const within = value => { const rel=path.relative(root,value); return rel==='' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const roots=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const marker=await readFile(path.join(os.homedir(),'sandbox-marker.txt'),'utf8');
  const loopback=await connection('127.0.0.1',Number(process.env.PROBE_PORT));
  const ipv4=await connection('1.1.1.1',443);
  const ipv6=await connection('2606:4700:4700::1111',443);
  const result={generation,pid:process.pid,home:os.homedir(),tmp:os.tmpdir(),roots,marker,location:context?.location ?? {directory:context?.directory},loopback,ipv4,ipv6};
  result.qualified=marker===process.env.PROBE_MARKER && within(os.homedir()) && within(os.tmpdir()) && Object.values(roots).every(value=>typeof value==='string' && within(value)) && loopback.connected;
  await writeFile(process.env.PROBE_RESULT,JSON.stringify(result,null,2));
}
export default {id:'synthetic-isolation-probe',setup:async context=>{await qualify('v2',context)},server:async context=>{await qualify('v1',context);return {}}};
`;

function cleanEnvironment(root: string, port: number, password: string, marker: string) {
  const home = join(root, "home");
  return {
    SystemRoot: process.env.SystemRoot ?? "C:/Windows", WINDIR: process.env.WINDIR ?? "C:/Windows",
    PATH: "C:/Windows/System32", PYTHONIOENCODING: "utf-8",
    HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
    ProgramData: join(root, "managed"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    TEMP: join(root, "temp"), TMP: join(root, "temp"), TMPDIR: join(root, "temp"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"), OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed", "opencode"),
    OPENCODE_DB: join(root, "data", "opencode", "synthetic.db"),
    OPENCODE_AUTH_CONTENT: "{}", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_FILEWATCHER_DISABLE: "true",
    OPENCODE_DISABLE_FFF: "true", OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
    PROBE_PORT: String(port), PROBE_ROOT: root, PROBE_MARKER: marker, PROBE_RESULT: join(root, "probe-result.json"),
    SESSION_HUB_URL: `http://127.0.0.1:${port}`, SESSION_HUB_TOKEN: randomBytes(24).toString("hex"),
  };
}

function verifyFirewallRule(generation: "v1" | "v2", executable: string) {
  const suffix = generation === "v2" ? "V2" : "V1";
  const script = "$r=Get-NetFirewallRule -Name '" + isolationRulePrefix + "-" + suffix + "' -PolicyStore ActiveStore -ErrorAction Stop; $p=$r | Get-NetFirewallApplicationFilter; $a=$r | Get-NetFirewallAddressFilter; [pscustomobject]@{Enabled=$r.Enabled.ToString();Action=$r.Action.ToString();Direction=$r.Direction.ToString();Program=$p.Program;RemoteAddress=@($a.RemoteAddress)} | ConvertTo-Json -Compress";
  const shell = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const run = spawnSync(shell, ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) return { verified: false, detail: String(run.stderr || run.error || "rule query failed").trim() };
  try {
    const rule = JSON.parse(run.stdout) as { Enabled: string; Action: string; Direction: string; Program: string; RemoteAddress: string[] };
    const matching =
      rule.Enabled === "True" && rule.Action === "Block" && rule.Direction === "Outbound" &&
      resolve(rule.Program).toLowerCase() === resolve(executable).toLowerCase() &&
      [...rule.RemoteAddress].sort().join(",") === [...expectedRemoteAddress].sort().join(",");
    return { verified: matching, detail: matching ? "rule filters match" : JSON.stringify(rule) };
  } catch (error) {
    return { verified: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 差分控制：证明"主机内毫秒级 ECONNREFUSED"确实来自本机阻断规则，而非环境本身的拒绝。
 * - 沙箱外基线（本进程直连 1.1.1.1:443）：不得出现毫秒级 ECONNREFUSED；
 * - 同形规则下的 Node 控制探针（node-isolated.exe）：IPv4 必须被 EACCES 拒绝。
 */
async function computeLocalRefusalDifferential() {
  const baseline = await new Promise<{ connected: boolean; code: string; ms: number }>((done) => {
    const startedMs = Date.now();
    const socket = net.connect({ host: "1.1.1.1", port: 443 });
    const finish = (connected: boolean, code: string) => {
      socket.destroy();
      done({ connected, code, ms: Date.now() - startedMs });
    };
    socket.setTimeout(5_000, () => finish(false, "TIMEOUT"));
    socket.once("connect", () => finish(true, ""));
    socket.once("error", (error) => finish(false, (error as NodeJS.ErrnoException).code ?? "UNKNOWN"));
  });
  const listener = createServer((_request, response) => response.end("synthetic-loopback"));
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("No control loopback port");
  let control: Record<string, unknown> | null = null;
  let controlError = "";
  try {
    const run = spawnSync(
      python!,
      [join(isolationRoot, "launch_isolated.py"), "--cwd", scratch, "--", join(isolationRoot, "node-isolated.exe"), join(isolationRoot, "network_probe.cjs")],
      {
        env: {
          SystemRoot: process.env.SystemRoot ?? "C:/Windows",
          WINDIR: process.env.WINDIR ?? "C:/Windows",
          PATH: "C:/Windows/System32",
          HOME: scratch, USERPROFILE: scratch,
          PROBE_PORT: String(address.port),
        },
        encoding: "utf8", timeout: 60_000, windowsHide: true,
      },
    );
    const parsed = run.stdout.trim().split("\n").at(-1) ?? "";
    control = JSON.parse(parsed) as Record<string, unknown>;
  } catch (error) {
    controlError = error instanceof Error ? error.message : String(error);
  } finally {
    await new Promise<void>((done) => { listener.close(() => done()); listener.closeAllConnections(); });
  }
  const controlIpv4 = control?.["ipv4"] as { connected?: unknown; code?: unknown } | undefined;
  const controlDenied = control?.["loopback"] !== undefined && controlIpv4?.connected === false && controlIpv4?.code === "EACCES";
  const baselineInstantRefusal = !baseline.connected && baseline.code === "ECONNREFUSED" && baseline.ms <= 50;
  return {
    baseline,
    control,
    controlError,
    controlDenied,
    baselineInstantRefusal,
    differential: controlDenied && !baselineInstantRefusal,
  };
}

async function qualifyHost(generation: "v1" | "v2", differential: Awaited<ReturnType<typeof computeLocalRefusalDifferential>>) {
  const root = join(evidenceRoot, generation);
  const listener = createServer((_request, response) => response.end("synthetic-loopback"));
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  const password = randomBytes(24).toString("hex");
  const marker = randomBytes(16).toString("hex");
  const env = cleanEnvironment(root, address.port, password, marker);
  const packageRoot = join(root, "probe-package");
  for (const directory of [root, packageRoot, ...Object.values(env).filter((value) => value.startsWith(root) && !value.endsWith(".json") && !value.endsWith(".db"))]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(env.HOME, "sandbox-marker.txt"), marker);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "synthetic-isolation-probe", version: "0.0.0", type: "module", exports: { ".": "./index.js" }, opencode: { server: "./index.js" } }));
  await writeFile(join(packageRoot, "index.js"), probeSource);
  const plugin = generation === "v2" ? packageRoot : join(packageRoot, "index.js");
  await writeFile(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(generation === "v1" ? { plugin: [plugin], autoupdate: false } : { plugins: [{ package: packageRoot }] }));
  const launcher = join(isolationRoot, "launch_isolated.py");
  const executable = join(isolationRoot, `opencode-${generation}-isolated.exe`);
  const rule = verifyFirewallRule(generation, executable);
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const reserved = reservation.address();
  if (reserved === null || typeof reserved === "string") throw new Error("No host port");
  const hostPort = reserved.port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const child = spawn(python!, [launcher, "--cwd", root, "--", executable, "--print-logs", "serve", "--hostname", "127.0.0.1", "--port", String(hostPort)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let exited = false;
  let forcedKill = false;
  const exit = new Promise<void>((done) => child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; exited = true; done(); }));
  child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-100_000); });
  child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-100_000); });
  child.on("error", (error) => { output += String(error); });
  let probe: unknown = null;
  let endpoint: string | null = null;
  const requests: unknown[] = [];
  let attempts = 0;
  let requestsDone = false;
  const started = Date.now();
  try {
    const deadlineMs = generation === "v1" ? 260_000 : 150_000;
    const deadline = started + deadlineMs;
    while (Date.now() < deadline && !exited) {
      const match = /(?:server listening on|opencode server listening on)\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      const probeLoaded = probe !== null;
      if (match && !requestsDone && attempts < 8 && (probeLoaded || Date.now() - started > 90_000)) {
        endpoint = match[1]!;
        attempts += 1;
        try {
          const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
          if (generation === "v2") {
            const client = OpenCode.make({ baseUrl: endpoint, headers: { authorization } });
            let plugins = await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(15_000) });
            for (let retry = 0; retry < 3 && (plugins.data ?? []).length === 0; retry++) {
              await new Promise((done) => setTimeout(done, 2_000));
              plugins = await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(15_000) });
            }
            requests.push({ operation: "plugin.list", count: (plugins.data ?? []).length, plugins });
          } else {
            const query = new URLSearchParams({ directory: root });
            const response = await fetch(`${endpoint}/config?${query}`, { headers: { authorization }, signal: AbortSignal.timeout(15_000) });
            requests.push({ operation: "config", status: response.status, body: await response.text() });
            const sessions = await fetch(`${endpoint}/session?${query}`, { headers: { authorization }, signal: AbortSignal.timeout(15_000) });
            requests.push({ operation: "session.list", status: sessions.status });
            await sessions.body?.cancel();
          }
          requestsDone = true;
        } catch (error) {
          requests.push({ attempt: attempts, error: error instanceof Error ? error.message : String(error) });
          await new Promise((done) => setTimeout(done, 3_000));
        }
      }
      try {
        probe = JSON.parse(await readFile(env.PROBE_RESULT, "utf8"));
        if (requestsDone || attempts >= 8) break;
      } catch {}
      await new Promise((done) => setTimeout(done, 250));
    }
  } finally {
    if (!exited) { forcedKill = true; child.kill(); }
    await Promise.race([exit, new Promise((done) => setTimeout(done, 8_000))]);
    await new Promise<void>((done) => { listener.close(() => done()); listener.closeAllConnections(); });
    const jobConfirmed = output.includes("ISOLATED_JOB active_process_limit=1 kill_on_close=true");
    output = output.split(password).join("[synthetic-password-redacted]").split(env.SESSION_HUB_TOKEN).join("[synthetic-token-redacted]");
    await writeFile(join(evidenceRoot, `${generation}-host.log`), output);
    let sandboxRemoved = false;
    let cleanupError = "";
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      sandboxRemoved = true;
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    const evaluation = evaluateQualification({
      probe, sandboxRoot: root, expectedMarker: marker, ruleFilterVerified: rule.verified,
      jobConfirmed, ownProcessExited: exited, sandboxRemoved, cleanupError,
      localRefusalDifferential: differential.differential,
    });
    outcomes.push({
      generation, ...evaluation, endpoint, exitCode, exitSignal, forcedKill, waitedMs: Date.now() - started, attempts, rule, probe,
      localRefusalDifferential: differential,
      requests: requests.slice(-4), jobConfirmed, ownProcessExited: exited,
      logPath: join(evidenceRoot, `${generation}-host.log`), sandboxRemoved, cleanupError,
    });
  }
}

const differential = await computeLocalRefusalDifferential();
try {
  const only = process.argv[3];
  for (const generation of only ? [only as "v1" | "v2"] : ["v1", "v2"] as const) {
    await qualifyHost(generation, differential);
  }
} finally {
  const report = { scope: "host isolation qualification only; business E2E requires success=true for each generation", evidenceRoot, differential, outcomes };
  await writeFile(join(evidenceRoot, "qualification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (outcomes.some((outcome) => !(outcome as { success: boolean }).success)) process.exitCode = 1;

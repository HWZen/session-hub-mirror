import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worktreesDirectory = dirname(dirname(dirname(root)));
const runtimeRoot = basename(worktreesDirectory) === ".worktrees"
  ? join(dirname(worktreesDirectory), "plugins", "hermes")
  : root;
const profileNames = ["default", "dev", "qa", "operations"];
const hookEvents = ["post_api_request", "on_session_end", "on_session_finalize", "on_session_reset"];
const startMarker = "  # session-hub-hermes-plugin:start";
const endMarker = "  # session-hub-hermes-plugin:end";

function forwardPath(value) {
  return value.replaceAll("\\", "/");
}

function quoteYamlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function managedHooksBlock(command) {
  const lines = [startMarker];
  for (const event of hookEvents) {
    lines.push(`  ${event}:`, `    - command: ${quoteYamlString(command)}`, "      timeout: 10");
  }
  lines.push(endMarker);
  return lines;
}

function removeManagedBlock(lines) {
  const start = lines.indexOf(startMarker);
  const end = lines.indexOf(endMarker);
  if (start === -1 && end === -1) return lines;
  if (start === -1 || end === -1 || end < start) throw new Error("Hermes 插件配置标记不完整");
  return [...lines.slice(0, start), ...lines.slice(end + 1)];
}

function findHooksSection(lines) {
  return lines.findIndex((line) => /^hooks:\s*(?:(?:\{\}|\[\])\s*)?(?:#.*)?$/.test(line));
}

function isTopLevelKey(line) {
  return /^[A-Za-z0-9_-]+\s*:/.test(line);
}

export function updateConfigYaml(source, command) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const sourceLines = source.split(/\r?\n/);
  if (hadFinalNewline) sourceLines.pop();
  const lines = removeManagedBlock(sourceLines);
  const sectionIndex = findHooksSection(lines);
  const block = managedHooksBlock(command);
  if (sectionIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push("hooks:", ...block);
  } else {
    if (/^hooks:\s*(?:\{\}|\[\])\s*(?:#.*)?$/.test(lines[sectionIndex])) lines[sectionIndex] = "hooks:";
    else if (!/^hooks:\s*(?:#.*)?$/.test(lines[sectionIndex])) {
      throw new Error("Hermes config.yaml 的 hooks 必须是 YAML 映射");
    }
    let sectionEnd = sectionIndex + 1;
    while (sectionEnd < lines.length) {
      const line = lines[sectionEnd];
      if (line.trim() && !/^\s/.test(line) && !line.startsWith("#") && isTopLevelKey(line)) break;
      sectionEnd++;
    }
    while (sectionEnd > sectionIndex + 1 && lines[sectionEnd - 1] === "") sectionEnd--;
    lines.splice(sectionEnd, 0, ...block);
  }
  const result = lines.join(eol);
  return hadFinalNewline ? `${result}${eol}` : result;
}

export function mergeAllowlist(source, approvals) {
  let document = { approvals: [] };
  if (source !== null) {
    document = JSON.parse(source);
    if (typeof document !== "object" || document === null || !Array.isArray(document.approvals)) {
      throw new Error("Hermes shell hook allowlist 格式无效");
    }
  }
  for (const approval of approvals) {
    if (!document.approvals.some((item) => item?.event === approval.event && item?.command === approval.command)) {
      document.approvals.push({ event: approval.event, command: approval.command });
    }
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function buildPlugin() {
  const result = spawnSync(process.execPath, [join(runtimeRoot, "scripts", "build.mjs")], {
    cwd: runtimeRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Hermes 插件构建失败");
}

function resolveProfilesRoot() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "hermes", "profiles");
}

function resolveHermesCli() {
  if (process.env.HERMES_CLI) return process.env.HERMES_CLI;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const installed = join(localAppData, "hermes", "hermes-agent", ".hermes", "bin", "hermes.exe");
  return existsSync(installed) ? installed : "hermes";
}

function installProfile(profileName, profilesRoot) {
  const profileHome = join(profilesRoot, profileName);
  const configPath = join(profileHome, "config.yaml");
  const allowlistPath = join(profileHome, "shell-hooks-allowlist.json");
  if (!existsSync(profileHome) || !existsSync(configPath)) {
    throw new Error(`Hermes profile 配置不存在：${profileName}`);
  }
  const scriptPath = forwardPath(join(runtimeRoot, "dist", "hook.js"));
  const command = `node "${scriptPath}" --profile "${forwardPath(profileHome)}"`;
  const updatedConfig = updateConfigYaml(readFileSync(configPath, "utf8"), command);
  const oldAllowlist = existsSync(allowlistPath) ? readFileSync(allowlistPath, "utf8") : null;
  const approvals = hookEvents.map((event) => ({ event, command }));
  const updatedAllowlist = mergeAllowlist(oldAllowlist, approvals);
  atomicWrite(configPath, updatedConfig);
  atomicWrite(allowlistPath, updatedAllowlist);
  verifyProfile(profileName, profileHome, command);
}

function verifyProfile(profileName, profileHome, command) {
  const result = spawnSync(resolveHermesCli(), ["hooks", "list"], {
    cwd: profileHome,
    env: { ...process.env, HERMES_HOME: profileHome },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`hermes hooks list 验证失败：${profileName}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!hookEvents.every((event) => output.includes(event)) || !output.includes(command)) {
    throw new Error(`hermes hooks list 未显示完整配置：${profileName}`);
  }
  console.log(`Hermes profile 已配置并验证：${profileName}`);
}

async function main() {
  buildPlugin();
  const profilesRoot = resolveProfilesRoot();
  for (const profileName of profileNames) installProfile(profileName, profilesRoot);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

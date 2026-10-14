const deniedCodes = new Set(["EACCES", "EPERM"]);
const localRefusalCodes = new Set(["ECONNREFUSED"]);
const instantRefusalMs = 50;

function normalize(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function collapse(value: string) {
  const parts: string[] = [];
  for (const segment of normalize(value).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return "";
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function withinSandbox(sandboxRoot: string, value: unknown) {
  if (typeof value !== "string" || value.length === 0) return false;
  const root = collapse(sandboxRoot);
  const candidate = collapse(value);
  if (root === "" || candidate === "") return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

type ProbeRecord = Record<string, unknown>;

const requiredRootKeys = [
  "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "TEMP", "TMP", "TMPDIR", "OPENCODE_CONFIG_DIR", "OPENCODE_TEST_HOME",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR", "OPENCODE_DB",
];

function isRecord(value: unknown): value is ProbeRecord {
  return typeof value === "object" && value !== null;
}

function connectionDenied(value: unknown, codes: Set<string>) {
  if (!isRecord(value) || value.connected !== false) return false;
  return typeof value.code === "string" && codes.has(value.code);
}

/**
 * 本机即时拒绝：本轮差分控制（沙箱外基线不产生即时拒绝，且同形规则下的 Node 控制探针被拒）
 * 成立时，运行时把 WFP 阻断表现为 ECONNREFUSED 也算阻断证据；仅限毫秒级拒绝。
 */
function localRefusalDenied(value: unknown, evidence: ProbeRecord) {
  if (!isRecord(value) || value.connected !== false) return false;
  if (typeof value.code !== "string" || !localRefusalCodes.has(value.code)) return false;
  if (typeof value.ms !== "number" || !Number.isFinite(value.ms) || value.ms > instantRefusalMs) return false;
  return evidence.localRefusalDifferential === true;
}

export function evaluateQualification(evidence: ProbeRecord) {
  const failures: string[] = [];
  const probe = evidence.probe;
  if (!isRecord(probe)) return { success: false, failures: ["probe result missing"] };

  if (probe.qualified !== true) failures.push("in-host probe did not qualify");
  const sandboxRoot = typeof evidence.sandboxRoot === "string" ? evidence.sandboxRoot : "";
  if (sandboxRoot === "") failures.push("sandbox root missing");

  if (evidence.ruleFilterVerified !== true) failures.push("firewall rule filter not verified");
  if (evidence.jobConfirmed !== true) failures.push("job object not confirmed");
  if (evidence.ownProcessExited !== true) failures.push("host process exit not confirmed");
  if (evidence.sandboxRemoved !== true) failures.push("sandbox not removed");
  if (evidence.cleanupError !== "") failures.push("cleanup error present");

  if (typeof evidence.expectedMarker !== "string" || probe.marker !== evidence.expectedMarker)
    failures.push("home sandbox marker mismatch");
  if (!withinSandbox(sandboxRoot, probe.home)) failures.push("home outside sandbox");
  if (!withinSandbox(sandboxRoot, probe.tmp)) failures.push("temp outside sandbox");
  if (!isRecord(probe.roots)) failures.push("environment roots missing");
  else {
    const roots = probe.roots;
    if (requiredRootKeys.some((key) => !(key in roots))) failures.push("environment root missing");
    else if (requiredRootKeys.some((key) => !withinSandbox(sandboxRoot, roots[key])))
      failures.push("environment root outside sandbox");
  }
  if (!isRecord(probe.location) || !withinSandbox(sandboxRoot, probe.location.directory))
    failures.push("host location outside sandbox");

  if (!isRecord(probe.loopback) || probe.loopback.connected !== true) failures.push("loopback not reachable");
  const ipv4Denied =
    connectionDenied(probe.ipv4, new Set(["EACCES"])) || localRefusalDenied(probe.ipv4, evidence);
  if (!ipv4Denied) failures.push("IPv4 not denied");
  const explicitDenial = connectionDenied(probe.ipv6, deniedCodes);
  const noRoute = connectionDenied(probe.ipv6, new Set(["ENETUNREACH"])) && evidence.ruleFilterVerified === true;
  const localRefusal = localRefusalDenied(probe.ipv6, evidence);
  if (!explicitDenial && !noRoute && !localRefusal)
    failures.push("IPv6 not denied (requires explicit denial, ENETUNREACH with verified rule filters, or instant local refusal with differential evidence)");

  return { success: failures.length === 0, failures };
}

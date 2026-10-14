import { describe, expect, it } from "vitest";
import { evaluateQualification } from "./helpers/qualification.js";

type ProbeConnection = { connected: boolean; code: string; ms?: number };
type Evidence = {
  sandboxRoot: string; expectedMarker: string; ruleFilterVerified: boolean; jobConfirmed: boolean;
  ownProcessExited: boolean; sandboxRemoved: boolean; cleanupError: string;
  localRefusalDifferential?: boolean;
  probe: {
    qualified: boolean; home: string; tmp: string; roots: Record<string, string>; marker: string;
    location: { directory: string }; loopback: { connected: boolean };
    ipv4: ProbeConnection; ipv6: ProbeConnection;
  };
};

function evidence(): Evidence {
  const sandboxRoot = "C:/synthetic/sandbox";
  const roots = Object.fromEntries([
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "TEMP", "TMP", "TMPDIR", "OPENCODE_CONFIG_DIR", "OPENCODE_TEST_HOME",
    "OPENCODE_TEST_MANAGED_CONFIG_DIR", "OPENCODE_DB",
  ].map((key) => [key, `${sandboxRoot}/${key}`]));
  return {
    sandboxRoot, expectedMarker: "synthetic-marker", ruleFilterVerified: true,
    jobConfirmed: true, ownProcessExited: true, sandboxRemoved: true, cleanupError: "",
    probe: {
      qualified: true, home: `${sandboxRoot}/HOME`, tmp: `${sandboxRoot}/TMP`, roots, marker: "synthetic-marker",
      location: { directory: sandboxRoot }, loopback: { connected: true },
      ipv4: { connected: false, code: "EACCES" }, ipv6: { connected: true, code: "EACCES" },
    },
  };
}

describe("evaluateQualification without launching a host", () => {
  it("rejects a connected IPv6 probe even if the old probe claims qualified", () => {
    expect(evaluateQualification(evidence()).success).toBe(false);
  });

  function completeEvidence() {
    const result = evidence();
    result.probe.ipv6.connected = false;
    return result;
  }

  it("rejects paths that escape the sandbox via .. segments", () => {
    const result = completeEvidence();
    result.probe.home = `${result.sandboxRoot}/../escape`;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("accepts complete isolation and cleanup evidence", () => {
    expect(evaluateQualification(completeEvidence()).success).toBe(true);
  });

  it.each(["jobConfirmed", "ownProcessExited", "sandboxRemoved", "ruleFilterVerified"] as const)(
    "rejects an unconfirmed %s gate", (gate) => {
      const result = completeEvidence();
      result[gate] = false;
      expect(evaluateQualification(result).success).toBe(false);
    },
  );

  it("rejects cleanup errors even when sandbox removal is reported", () => {
    expect(evaluateQualification({ ...completeEvidence(), cleanupError: "synthetic cleanup failure" }).success).toBe(false);
  });

  it.each(["ECONNREFUSED", "TIMEOUT", "ECONNRESET", "UNKNOWN", ""])(
    "rejects ambiguous IPv6 %s", (code) => {
      const result = completeEvidence();
      result.probe.ipv6.code = code;
      expect(evaluateQualification(result).success).toBe(false);
    },
  );

  it("accepts IPv6 ENETUNREACH only with verified rule filters", () => {
    const result = completeEvidence();
    result.probe.ipv6.code = "ENETUNREACH";
    expect(evaluateQualification(result).success).toBe(true);
    result.ruleFilterVerified = false;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it.each(["EACCES", "EPERM"])("accepts explicit IPv6 %s denial", (code) => {
    const result = completeEvidence();
    result.probe.ipv6.code = code;
    expect(evaluateQualification(result).success).toBe(true);
  });

  it("accepts an instant local IPv4 refusal only with the differential control", () => {
    const result = completeEvidence();
    result.probe.ipv4 = { connected: false, code: "ECONNREFUSED", ms: 1 };
    expect(evaluateQualification(result).success).toBe(false);
    result.localRefusalDifferential = true;
    expect(evaluateQualification(result).success).toBe(true);
  });

  it("rejects a slow ECONNREFUSED even with the differential control", () => {
    const result = completeEvidence();
    result.probe.ipv4 = { connected: false, code: "ECONNREFUSED", ms: 2000 };
    result.localRefusalDifferential = true;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("rejects an instant ECONNREFUSED without differential evidence", () => {
    const result = completeEvidence();
    result.probe.ipv6 = { connected: false, code: "ECONNREFUSED", ms: 0 };
    expect(evaluateQualification(result).success).toBe(false);
    result.localRefusalDifferential = true;
    expect(evaluateQualification(result).success).toBe(true);
  });

  it("rejects an instant ECONNREFUSED when the differential baseline control failed", () => {
    const result = completeEvidence();
    result.probe.ipv4 = { connected: false, code: "ECONNREFUSED", ms: 2 };
    result.localRefusalDifferential = false;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it.each(["ECONNREFUSED", "TIMEOUT", "ENETUNREACH"] as const)("rejects IPv4 %s", (code) => {
    const result = completeEvidence();
    result.probe.ipv4.code = code;
    result.probe.ipv4.ms = 1;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("rejects connected IPv4 despite a denial code", () => {
    const result = completeEvidence();
    result.probe.ipv4.connected = true;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("requires loopback connectivity", () => {
    const result = completeEvidence();
    result.probe.loopback.connected = false;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it.each(["home", "tmp"] as const)("rejects %s outside the sandbox", (key) => {
    const result = completeEvidence();
    result.probe[key] = "C:/synthetic/sandbox-escape";
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("rejects any environment root outside the sandbox", () => {
    const result = completeEvidence();
    result.probe.roots.APPDATA = "C:/synthetic/real-user";
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("rejects a missing environment root", () => {
    const result = completeEvidence();
    delete result.probe.roots.TMPDIR;
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("requires matching in-host home marker", () => {
    const result = completeEvidence();
    result.probe.marker = "wrong-marker";
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("requires the host location to be inside the sandbox", () => {
    const result = completeEvidence();
    result.probe.location.directory = "C:/synthetic/other";
    expect(evaluateQualification(result).success).toBe(false);
  });

  it("fails closed for missing probe and missing bookkeeping", () => {
    expect(evaluateQualification({ probe: null }).success).toBe(false);
    expect(evaluateQualification({ probe: completeEvidence().probe }).success).toBe(false);
  });
});

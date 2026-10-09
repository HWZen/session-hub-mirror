import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@session-hub/shared";
import { buildSessionMetaHeader } from "../src/indexing/session-meta.js";

function meta(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session-1",
    agent: "opencode",
    machine: "WORKSTATION-A",
    source_id: "src-1",
    title: "debug session",
    cwd: "D:/work/app",
    created_at: 1700000000000,
    updated_at: 1700000100000,
    deleted_at: null,
    indexed_at: null,
    indexed_model: null,
    ...overrides,
  };
}

describe("buildSessionMetaHeader", () => {
  it("returns the title alone", () => {
    expect(buildSessionMetaHeader(meta())).toBe("debug session");
  });

  it("ignores agent, machine, source_id and cwd", () => {
    expect(
      buildSessionMetaHeader(
        meta({ agent: "workbuddy", machine: "OTHER", source_id: "src-2", cwd: "C:/somewhere/else" }),
      ),
    ).toBe("debug session");
  });

  it("returns an empty string for null or blank title", () => {
    expect(buildSessionMetaHeader(meta({ title: null }))).toBe("");
    expect(buildSessionMetaHeader(meta({ title: "   " }))).toBe("");
    expect(buildSessionMetaHeader(meta({ title: "\t\n" }))).toBe("");
  });

  it("trims the title", () => {
    expect(buildSessionMetaHeader(meta({ title: "  t  " }))).toBe("t");
  });
});

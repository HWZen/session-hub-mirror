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
  it("includes all five fields in a stable format", () => {
    expect(buildSessionMetaHeader(meta())).toBe(
      "会话元数据：标题=debug session；Agent=opencode；机器=WORKSTATION-A；源会话ID=src-1；工作目录=D:/work/app",
    );
  });

  it("omits null or blank title and cwd", () => {
    expect(buildSessionMetaHeader(meta({ title: null, cwd: null }))).toBe(
      "会话元数据：Agent=opencode；机器=WORKSTATION-A；源会话ID=src-1",
    );
    expect(buildSessionMetaHeader(meta({ title: "   ", cwd: "\t" }))).toBe(
      "会话元数据：Agent=opencode；机器=WORKSTATION-A；源会话ID=src-1",
    );
  });

  it("trims title and cwd", () => {
    expect(buildSessionMetaHeader(meta({ title: "  t  ", cwd: " c " }))).toBe(
      "会话元数据：标题=t；Agent=opencode；机器=WORKSTATION-A；源会话ID=src-1；工作目录=c",
    );
  });
});

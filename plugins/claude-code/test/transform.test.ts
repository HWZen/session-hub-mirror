import { describe, expect, it } from "vitest";
import { AGENT, transformSession, MAX_CWD_LENGTH } from "../src/transform.js";
import { MAX_MESSAGES, TRUNCATE_MARK, type TranscriptSession } from "../src/transcript.js";

function baseSession(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  return {
    sessionId: "sess-7",
    cwd: "C:\\from-transcript",
    createdAt: 1_000,
    updatedAt: 2_000,
    title: "a title",
    messages: [
      { role: "user", text: "hello", ts: 1_000 },
      { role: "assistant", text: "hi", ts: 1_500, raw: [{ type: "reasoning", text: "think" }, { type: "text", text: "hi" }] },
    ],
    ...overrides,
  };
}

describe("transformSession", () => {
  it("maps identity fields", () => {
    const payload = transformSession(baseSession(), undefined, "WORKSTATION-A");
    expect(payload.agent).toBe(AGENT);
    expect(payload.agent).toBe("claude-code");
    expect(payload.machine).toBe("WORKSTATION-A");
    expect(payload.source_id).toBe("sess-7");
    expect(payload.created_at).toBe(1_000);
    expect(payload.updated_at).toBe(2_000);
    expect(payload.title).toBe("a title");
    expect(payload.cwd).toBe("C:\\from-transcript");
  });

  it("cwd override from hook payload wins over transcript cwd", () => {
    const payload = transformSession(baseSession(), "D:\\hook-cwd");
    expect(payload.cwd).toBe("D:\\hook-cwd");
  });

  it("falls back to transcript cwd when override is empty", () => {
    const payload = transformSession(baseSession(), "");
    expect(payload.cwd).toBe("C:\\from-transcript");
  });

  it("omits cwd and title when absent", () => {
    const session = baseSession({ cwd: "" });
    delete session.title;
    const payload = transformSession(session);
    expect(payload.cwd).toBeUndefined();
    expect(payload.title).toBeUndefined();
  });

  it("passes through messages with role/text/ts/raw", () => {
    const payload = transformSession(baseSession());
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]).toEqual({ role: "user", text: "hello", ts: 1000 });
    expect(payload.messages[1]?.raw).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "hi" },
    ]);
  });

  it("keeps only the last MAX_MESSAGES messages", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({
      role: "user",
      text: `m-${i}`,
      ts: i,
    }));
    const payload = transformSession(baseSession({ messages }));
    expect(payload.messages).toHaveLength(MAX_MESSAGES);
    expect(payload.messages[0]?.text).toBe("m-5");
  });

  it("truncates title and cwd to schema limits", () => {
    const payload = transformSession(
      baseSession({ title: "t".repeat(3000), cwd: "c".repeat(MAX_CWD_LENGTH + 10) }),
    );
    expect(payload.title?.endsWith(TRUNCATE_MARK)).toBe(true);
    expect(payload.title?.length).toBe(2000 + TRUNCATE_MARK.length);
    expect(payload.cwd?.length).toBe(MAX_CWD_LENGTH + TRUNCATE_MARK.length);
  });
});

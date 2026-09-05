import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  extractMessages,
  extractSessionInfo,
  transformSession,
  type PluginSourceMessage,
  type PluginSourceSession,
} from "../src/plugin.js";

const session: PluginSourceSession = {
  id: "ses_1",
  title: "test session",
  directory: "/work/proj",
  time_created: 1700000000000,
  time_updated: 1700000050000,
};

const MACHINE = "M1";

function msg(role: string, parts: unknown[], ts = 1700000001000): PluginSourceMessage {
  return { role, parts, time_created: ts };
}

describe("transformSession", () => {
  it("routes field sources per the mapping contract", () => {
    const payload = transformSession(session, [], MACHINE);
    expect(payload).toEqual({
      agent: "opencode",
      machine: MACHINE,
      source_id: "ses_1",
      title: "test session",
      cwd: "/work/proj",
      created_at: 1700000000000,
      updated_at: 1700000050000,
      messages: [],
    });
  });

  it("filters synthetic text parts and keeps other types out of text but in raw", () => {
    const messages = [
      msg("user", [
        { type: "text", text: "question", synthetic: true },
        { type: "text", text: "real question" },
      ], 1),
      msg("assistant", [
        { type: "step-start", foo: 1 },
        { type: "reasoning", text: "thinking..." },
        { type: "tool", state: { status: "done", output: "tool output" } },
        { type: "text", text: "answer" },
      ], 2),
    ];
    const payload = transformSession(session, messages, MACHINE);
    expect(payload.messages[0]!.text).toBe("real question");
    expect(payload.messages[0]!.raw).toEqual([
      { type: "text", text: "question", synthetic: true },
      { type: "text", text: "real question" },
    ]);
    expect(payload.messages[1]!.text).toBe("answer");
    expect(payload.messages[1]!.raw).toHaveLength(4);
    expect(payload.messages[0]!.ts).toBe(1);
  });

  it("joins multiple real text parts with blank line", () => {
    const messages = [msg("user", [{ type: "text", text: "a" }, { type: "text", text: "b" }], 1)];
    expect(transformSession(session, messages, MACHINE).messages[0]!.text).toBe("a\n\nb");
  });

  it("truncates oversized text with a mark", () => {
    const big = "x".repeat(1_100_000);
    const payload = transformSession(session, [msg("user", [{ type: "text", text: big }], 1)], MACHINE);
    expect(payload.messages[0]!.text!.length).toBeLessThanOrEqual(1_000_000 + TRUNCATE_MARK_LENGTH);
    expect(payload.messages[0]!.text).toContain("truncated");
  });

  it("keeps only the most recent 5000 messages", () => {
    const messages: PluginSourceMessage[] = [];
    for (let i = 0; i < 5100; i++) {
      messages.push(msg("user", [{ type: "text", text: `m${i}` }], i));
    }
    const payload = transformSession(session, messages, MACHINE);
    expect(payload.messages).toHaveLength(5000);
    expect(payload.messages[0]!.text).toBe("m100");
    expect(payload.messages.at(-1)!.text).toBe("m5099");
  });

  it("is defensive against malformed input", () => {
    const payload = transformSession(session, [
      null,
      { parts: "not-array" },
      { role: 42, parts: [] },
      { role: "assistant", parts: [] },
      msg("user", [42, null, { type: "text" }, { type: "text", text: "ok" }], 1),
    ] as unknown as PluginSourceMessage[], MACHINE);
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages.at(-1)!.text).toBe("ok");
  });

  it("omits empty optional fields", () => {
    const payload = transformSession(
      { id: "s", title: "", directory: "", time_created: 1, time_updated: 2 },
      [{ role: "user", parts: [42] }],
      MACHINE,
    );
    expect("title" in payload).toBe(false);
    expect("cwd" in payload).toBe(false);
    expect("text" in payload.messages[0]!).toBe(false);
  });
});

const TRUNCATE_MARK_LENGTH = "\n\n[session-hub: truncated]".length;

describe("extractSessionInfo / extractMessages / classifyEvent", () => {
  it("extracts session from SDK shape", () => {
    const info = extractSessionInfo({
      id: "ses_1",
      title: "t",
      directory: "/d",
      time: { created: 111, updated: 222 },
    });
    expect(info).toEqual({
      id: "ses_1",
      title: "t",
      directory: "/d",
      time_created: 111,
      time_updated: 222,
    });
    expect(extractSessionInfo({ id: "x" })).toBeNull();
    expect(extractSessionInfo(null)).toBeNull();
  });

  it("extracts messages dropping malformed entries", () => {
    const messages = extractMessages([
      { info: { role: "user", time: { created: 5 } }, parts: [{ type: "text", text: "hi" }] },
      { info: null },
      { info: { role: "assistant" }, parts: [{ type: "tool" }] },
      "junk",
    ]);
    expect(messages).toEqual([
      { role: "user", time_created: 5, parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", time_created: null, parts: [{ type: "tool" }] },
    ]);
  });

  it("classifies idle and deleted events", () => {
    expect(classifyEvent({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual({
      type: "session.idle",
      source_id: "s1",
    });
    expect(classifyEvent({ type: "session.deleted", properties: { info: { id: "s2" } } })).toEqual({
      type: "session.deleted",
      source_id: "s2",
    });
    expect(classifyEvent({ type: "other", properties: {} })).toBeNull();
    expect(classifyEvent({ type: "session.idle", properties: {} })).toBeNull();
    expect(classifyEvent({})).toBeNull();
  });
});

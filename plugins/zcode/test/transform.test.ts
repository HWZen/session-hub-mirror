import { describe, expect, it } from "vitest";
import {
  type ZcodeMessageRow,
  type ZcodeSessionRow,
  isDialogMessage,
  transformSession,
} from "../src/transform.js";

const SESSION: ZcodeSessionRow = {
  id: "sess_test_1",
  title: "t".repeat(2100),
  directory: "D:\\work\\demo",
  time_created: 1000,
  time_updated: 2000,
};

function msg(
  id: string,
  role: string,
  kind: string,
  timeCreated: number,
  parts: unknown[],
  sequence: number | null = null,
): ZcodeMessageRow {
  return {
    id,
    time_created: timeCreated,
    sequence,
    data: {
      role,
      time: { created: timeCreated },
      semantics: { kind, uiVisibility: "visible" },
    },
    parts,
  };
}

describe("isDialogMessage", () => {
  it("keeps user_prompt and assistant_response", () => {
    expect(isDialogMessage({ semantics: { kind: "user_prompt" } })).toBe(true);
    expect(isDialogMessage({ semantics: { kind: "assistant_response" } })).toBe(true);
  });

  it("drops injected and timeline kinds", () => {
    expect(isDialogMessage({ semantics: { kind: "todo_reminder" } })).toBe(false);
    expect(isDialogMessage({ semantics: { kind: "background_notification" } })).toBe(false);
    expect(isDialogMessage({ semantics: { kind: "timeline_event" } })).toBe(false);
  });

  it("drops malformed data", () => {
    expect(isDialogMessage(null)).toBe(false);
    expect(isDialogMessage("x")).toBe(false);
    expect(isDialogMessage({ role: "user" })).toBe(false);
    expect(isDialogMessage({ semantics: {} })).toBe(false);
  });
});

describe("transformSession", () => {
  it("maps role/ts/text/raw per the mapping table", () => {
    const result = transformSession(SESSION, [
      msg("m1", "user", "user_prompt", 1100, [
        { type: "text", text: "帮我改 bug" },
        { type: "tool", callID: "c1", tool: "Bash", state: { status: "completed" } },
      ]),
      msg("m2", "assistant", "assistant_response", 1200, [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "已修复" },
      ]),
    ]);
    expect(result.agent).toBe("zcode");
    expect(result.source_id).toBe("sess_test_1");
    expect(result.cwd).toBe("D:\\work\\demo");
    expect(result.created_at).toBe(1000);
    expect(result.updated_at).toBe(2000);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: "user", ts: 1100, text: "帮我改 bug" });
    expect(result.messages[0]!.raw).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ role: "assistant", ts: 1200, text: "已修复" });
    expect(result.messages[1]!.raw).toHaveLength(2);
  });

  it("filters non-dialog messages and sorts by time then sequence", () => {
    const result = transformSession(SESSION, [
      msg("noise", "user", "todo_reminder", 1050, [{ type: "text", text: "reminder" }]),
      msg("b", "assistant", "assistant_response", 1300, [{ type: "text", text: "second" }], 2),
      msg("a", "assistant", "assistant_response", 1300, [{ type: "text", text: "first" }], 1),
    ]);
    expect(result.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("joins multiple text parts with blank line", () => {
    const result = transformSession(SESSION, [
      msg("m", "user", "user_prompt", 1100, [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ]),
    ]);
    expect(result.messages[0]!.text).toBe("part one\n\npart two");
  });

  it("skips messages with invalid role", () => {
    const row = msg("m", "user", "user_prompt", 1100, []);
    (row.data as Record<string, unknown>)["role"] = 42;
    const result = transformSession(SESSION, [row]);
    expect(result.messages).toHaveLength(0);
  });

  it("keeps the last 5000 messages when over the cap", () => {
    const many: ZcodeMessageRow[] = [];
    for (let i = 0; i < 5010; i++) {
      many.push(msg(`m${i}`, "user", "user_prompt", 1000 + i, [{ type: "text", text: `t${i}` }]));
    }
    const result = transformSession(SESSION, many);
    expect(result.messages).toHaveLength(5000);
    expect(result.messages[0]!.text).toBe("t10");
    expect(result.messages.at(-1)!.text).toBe("t5009");
  });

  it("truncates title at 2000 and huge text at 1MB with a marker", () => {
    const big = "x".repeat(1_100_000);
    const result = transformSession(SESSION, [
      msg("m", "user", "user_prompt", 1100, [{ type: "text", text: big }]),
    ]);
    expect(result.title).toHaveLength(2000 + "\n\n[session-hub: truncated]".length);
    expect(result.messages[0]!.text).toHaveLength(1_000_000 + "\n\n[session-hub: truncated]".length);
    expect(result.messages[0]!.text!.endsWith("[session-hub: truncated]")).toBe(true);
  });

  it("omits empty title/cwd", () => {
    const result = transformSession({ ...SESSION, title: "", directory: null }, []);
    expect(result.title).toBeUndefined();
    expect(result.cwd).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_CWD_LENGTH,
  MAX_MESSAGES,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  TRUNCATE_MARK,
  type HermesMessageRow,
  type HermesSessionRow,
  transformSession,
} from "../src/transform.js";

const SESSION: HermesSessionRow = {
  id: "sess-1",
  title: "Hermes conversation",
  cwd: null,
  git_repo_root: "D:/work/repo",
  started_at: 1_700_000_000.125,
  last_activity_at: 1_700_000_100.5,
};

function message(
  id: string,
  role: string,
  content: string | null,
  extras: Partial<HermesMessageRow> = {},
): HermesMessageRow {
  return {
    id,
    session_id: SESSION.id,
    role,
    content,
    tool_call_id: null,
    tool_name: null,
    tool_calls: null,
    ...extras,
  };
}

describe("transformSession", () => {
  it("maps identity, timestamps, cwd fallback, text, tool output and tool calls", () => {
    const result = transformSession(
      SESSION,
      [
        message("m1", "user", "請查一下"),
        message("m2", "assistant", null, {
          tool_calls: JSON.stringify([{ id: "call-1", function: { name: "search", arguments: "{}" } }]),
        }),
        message("m3", "tool", "查詢結果", { tool_name: "search", tool_call_id: "call-1" }),
        message("meta", "session_meta", null),
      ],
      "machine-test",
    );

    expect(result).toMatchObject({
      agent: "hermes",
      machine: "machine-test",
      source_id: "sess-1",
      cwd: "D:/work/repo",
      created_at: 1_700_000_000_125,
      updated_at: 1_700_000_100_500,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({
      role: "user",
      text: "請查一下",
      raw: { type: "text", text: "請查一下" },
    });
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[1]!.text).toBeUndefined();
    expect(result.messages[1]!.raw).toEqual({
      type: "tool",
      text: '[{"id":"call-1","function":{"name":"search","arguments":"{}"}}]',
    });
    expect(result.messages[2]).toEqual({
      role: "tool",
      raw: { type: "tool", text: "查詢結果", tool_name: "search", tool_call_id: "call-1" },
    });
    expect(result.messages[2]!.text).toBeUndefined();
  });

  it("keeps tool output only in raw so non-full API responses hide tool calls", () => {
    const result = transformSession(
      SESSION,
      [
        message("u1", "user", "问题"),
        message("t1", "tool", "工具产出正文", { tool_name: "terminal", tool_call_id: "c1" }),
        message("a1", "assistant", "回答"),
      ],
      "machine-test",
    );
    const toolMessage = result.messages.find((entry) => entry.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.text).toBeUndefined();
    expect(toolMessage!.raw).toEqual({
      type: "tool",
      text: "工具产出正文",
      tool_name: "terminal",
      tool_call_id: "c1",
    });
    const assistant = result.messages.find((entry) => entry.role === "assistant");
    expect(assistant!.text).toBe("回答");
  });

  it("preserves other roles and filters only session_meta", () => {
    const result = transformSession(SESSION, [
      message("1", "developer", "开发者消息"),
      message("2", "session_meta", "metadata"),
      message("3", "assistant", "完成"),
    ]);
    expect(result.messages.map((entry) => entry.role)).toEqual(["developer", "assistant"]);
  });

  it("truncates title and each message text to their schema limits", () => {
    const longText = "x".repeat(MAX_TEXT_LENGTH + 10_000);
    const result = transformSession(
      { ...SESSION, title: "标题".repeat(MAX_TITLE_LENGTH) },
      [message("large", "user", longText)],
    );
    expect(result.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(result.title?.endsWith(TRUNCATE_MARK)).toBe(true);
    expect(result.messages[0]!.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(result.messages[0]!.text?.endsWith(TRUNCATE_MARK)).toBe(true);
  });

  it("keeps the last 5000 messages and marks the retained tail", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 3 }, (_, index) =>
      message(`m${index}`, "user", `text-${index}`),
    );
    const result = transformSession(SESSION, messages);
    expect(result.messages).toHaveLength(MAX_MESSAGES);
    expect(result.messages[0]!.text).toBe("text-3");
    expect(result.messages.at(-1)!.text).toBe(`text-${MAX_MESSAGES + 2}${TRUNCATE_MARK}`);
    expect(result.messages.at(-1)!.raw).toEqual([
      { type: "text", text: `text-${MAX_MESSAGES + 2}` },
      { type: "text", text: TRUNCATE_MARK },
    ]);
  });

  it("clamps roles to the API limit and omits empty metadata", () => {
    const result = transformSession(
      { ...SESSION, title: "", cwd: null, git_repo_root: null },
      [message("long-role", "r".repeat(80), "text")],
    );
    expect(result.messages[0]!.role).toHaveLength(64);
    expect(result.title).toBeUndefined();
    expect(result.cwd).toBeUndefined();
  });

  it("limits cwd to the API field size", () => {
    const result = transformSession(
      { ...SESSION, cwd: "c".repeat(2500), git_repo_root: null },
      [],
    );
    expect(result.cwd).toHaveLength(MAX_CWD_LENGTH);
  });
});

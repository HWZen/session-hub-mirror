import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGES,
  MAX_TEXT_LENGTH,
  TRUNCATE_MARK,
  extractUserText,
  parseTranscript,
  type WorkbuddySource,
} from "../src/workbuddy/parse.js";

const source: WorkbuddySource = {
  sessionId: "ses_1",
  cwd: "D:/proj",
  machine: "M1",
  fallbackCreatedMs: 111,
  fallbackUpdatedMs: 222,
};

function userLine(text: string, ts = 1000, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    timestamp: new Date(ts).toISOString(),
    sessionId: "ses_1",
    cwd: "D:/proj",
    message: { role: "user", content: text },
    ...extra,
  });
}

function assistantLine(parts: unknown[], ts = 2000): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    sessionId: "ses_1",
    message: { role: "assistant", content: parts },
  });
}

describe("extractUserText", () => {
  it("extracts user_query tag content", () => {
    expect(extractUserText("<user_query>hello world</user_query>")).toBe("hello world");
  });

  it("joins multiple user_query tags", () => {
    expect(extractUserText("<user_query>a</user_query><user_query>b</user_query>")).toBe("a\n\nb");
  });

  it("drops pure system-reminder content", () => {
    expect(extractUserText("<system-reminder>context stuff</system-reminder>")).toBeNull();
  });

  it("strips system-reminder from mixed text", () => {
    expect(extractUserText("<system-reminder>x</system-reminder>real input")).toBe("real input");
  });

  it("keeps plain text untouched", () => {
    expect(extractUserText("plain question")).toBe("plain question");
  });

  it("returns null for unterminated reminder-only text", () => {
    expect(extractUserText("<system-reminder>never closed")).toBeNull();
  });
});

describe("parseTranscript", () => {
  it("parses user/assistant messages with ts, title, cwd and timestamps", () => {
    const jsonl = [
      userLine("<user_query>fix the bug</user_query>", 1000),
      assistantLine([{ type: "text", text: "looking" }, { type: "tool_use", name: "read" }], 2000),
      assistantLine([{ type: "text", text: "done" }], 3000),
    ].join("\n");
    const { payload, stats } = parseTranscript(jsonl, source);
    expect(payload).not.toBeNull();
    expect(payload!.agent).toBe("workbuddy");
    expect(payload!.machine).toBe("M1");
    expect(payload!.source_id).toBe("ses_1");
    expect(payload!.cwd).toBe("D:/proj");
    expect(payload!.created_at).toBe(1000);
    expect(payload!.updated_at).toBe(3000);
    expect(payload!.title).toBe("fix the bug");
    expect(payload!.messages).toHaveLength(3);
    expect(payload!.messages[0]).toMatchObject({ role: "user", text: "fix the bug", ts: 1000 });
    expect(payload!.messages[1]!.text).toBe("looking");
    const rawParts = payload!.messages[1]!.raw;
    expect(Array.isArray(rawParts)).toBe(true);
    expect(rawParts).toContainEqual({ type: "tool_use", name: "read" });
    expect(stats).toEqual({ lines: 3, parseErrors: 0, kept: 3, dropped: 0 });
  });

  it("derives source_id from transcript basename when session_id missing", () => {
    const { payload } = parseTranscript(userLine("hi"), {
      transcriptPath: "C:/x/projects/abc/uuid-123.jsonl",
      machine: "M1",
    });
    expect(payload!.source_id).toBe("uuid-123");
  });

  it("returns null payload without session_id and transcript_path", () => {
    const { payload, stats } = parseTranscript(userLine("hi"), { machine: "M1" });
    expect(payload).toBeNull();
    expect(stats.lines).toBe(0);
  });

  it("skips bad JSON lines and invalid roles with counters", () => {
    const jsonl = [
      "not-json{",
      JSON.stringify({ type: "summary", timestamp: "1970-01-01T00:00:05.000Z" }),
      userLine("ok", 5000),
    ].join("\n");
    const { payload, stats } = parseTranscript(jsonl, source);
    expect(stats).toEqual({ lines: 3, parseErrors: 1, kept: 1, dropped: 1 });
    expect(payload!.created_at).toBe(5000);
  });

  it("handles string content messages", () => {
    const line = JSON.stringify({
      timestamp: 7000,
      message: { role: "user", content: "plain string input" },
    });
    const { payload } = parseTranscript(line, source);
    expect(payload!.messages[0]).toMatchObject({ role: "user", text: "plain string input", ts: 7000 });
  });

  it("uses fallback timestamps when no line has ts", () => {
    const { payload } = parseTranscript('{"message":{"role":"user","content":"x"}}', source);
    expect(payload!.created_at).toBe(111);
    expect(payload!.updated_at).toBe(222);
  });

  it("returns empty messages payload for empty file with resolvable session", () => {
    const { payload, stats } = parseTranscript("", source);
    expect(payload).not.toBeNull();
    expect(payload!.messages).toEqual([]);
    expect(stats.lines).toBe(0);
  });

  it("keeps last 5000 messages and first-line created_at when over cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_MESSAGES + 10; i++) {
      lines.push(userLine(`m${i}`, 1000 + i));
    }
    const { payload, stats } = parseTranscript(lines.join("\n"), source);
    expect(stats.kept).toBe(MAX_MESSAGES + 10);
    expect(payload!.messages).toHaveLength(MAX_MESSAGES);
    expect(payload!.messages[0]!.text).toBe("m10");
    expect(payload!.created_at).toBe(1000);
    expect(payload!.updated_at).toBe(1000 + MAX_MESSAGES + 9);
  });

  it("truncates oversized text with mark", () => {
    const long = "x".repeat(MAX_TEXT_LENGTH + 10);
    const { payload } = parseTranscript(userLine(long), source);
    expect(payload!.messages[0]!.text!.length).toBe(MAX_TEXT_LENGTH + TRUNCATE_MARK.length);
    expect(payload!.messages[0]!.text!.endsWith(TRUNCATE_MARK)).toBe(true);
  });

  it("keeps non-text assistant-only parts as raw without text", () => {
    const { payload } = parseTranscript(assistantLine([{ type: "tool_use", id: "t1" }]), source);
    expect(payload!.messages[0]!.text).toBeUndefined();
    expect(payload!.messages[0]!.raw).toMatchObject({ type: "tool_use", id: "t1" });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_MESSAGES,
  MAX_TEXT_LENGTH,
  MAX_TOOL_OUTPUT_LENGTH,
  MAX_TITLE_LENGTH,
  TRUNCATE_MARK,
  groupTranscript,
  readTranscript,
  type ClaudeEntry,
} from "../src/transcript.js";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

let uuidCounter = 0;
function entry(partial: Partial<ClaudeEntry> & { type: string } & Record<string, unknown>): ClaudeEntry {
  uuidCounter += 1;
  return {
    uuid: `u-${uuidCounter}`,
    sessionId: "sess-1",
    cwd: "C:\\repo",
    timestamp: "2026-10-09T06:56:44.139Z",
    ...partial,
  };
}

type MessageContent = NonNullable<NonNullable<ClaudeEntry["message"]>["content"]>;

function assistantEntry(messageId: string, blocks: MessageContent, extra: Partial<ClaudeEntry> = {}): ClaudeEntry {
  return entry({ type: "assistant", apiBlockIndex: 0, message: { id: messageId, role: "assistant", content: blocks }, ...extra });
}

function userTextEntry(text: string, extra: Partial<ClaudeEntry> = {}): ClaudeEntry {
  return entry({ type: "user", message: { role: "user", content: text }, ...extra });
}

function toolResultEntry(toolUseId: string, content: string | Array<{ type: string; text?: string }>): ClaudeEntry {
  return entry({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  });
}

describe("readTranscript", () => {
  it("parses JSONL lines and skips blank/malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-cc-test-"));
    tempDirs.push(dir);
    const file = join(dir, "t.jsonl");
    writeFileSync(file, `${JSON.stringify(userTextEntry("hello"))}\n\n{broken json\n${JSON.stringify(userTextEntry("world"))}\n`);
    const entries = readTranscript(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe("user");
  });
});

describe("groupTranscript entry filtering", () => {
  it("drops non-dialog entry types", () => {
    const entries = [
      entry({ type: "attachment", attachment: {} }),
      entry({ type: "ai-title", aiTitle: "T" }),
      entry({ type: "last-prompt", lastPrompt: {} }),
      entry({ type: "system", subtype: "x" }),
      entry({ type: "queue-operation", operation: "x" }),
      entry({ type: "mode", mode: "default" }),
      entry({ type: "permission-mode", permissionMode: "default" }),
      entry({ type: "atis-latch", atis: {} }),
      entry({ type: "file-history-snapshot", snapshot: {} }),
      entry({ type: "file-history-delta", backup: {} }),
      entry({ type: "cost-state", totalCostUSD: 0 }),
      userTextEntry("hi"),
    ];
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe("user");
  });

  it("keeps real user input (string content) and skips tool_result carriers as standalone messages", () => {
    const entries = [
      userTextEntry("what is up"),
      assistantEntry("m1", [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }]),
      toolResultEntry("tu-1", "file-a\nfile-b"),
      userTextEntry("thanks"),
    ];
    const session = groupTranscript(entries);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("skips user inputs that start with <system-reminder", () => {
    const entries = [
      userTextEntry("<system-reminder>injected context</system-reminder>"),
      userTextEntry("real question"),
    ];
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.text).toBe("real question");
  });

  it("skips sidechain entries", () => {
    const entries = [userTextEntry("main", { isSidechain: true }), userTextEntry("real")];
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(1);
  });
});

describe("assistant aggregation", () => {
  it("merges entries sharing message.id, ordered by apiBlockIndex", () => {
    const entries = [
      userTextEntry("q"),
      assistantEntry(
        "m1",
        [{ type: "thinking", thinking: "let me think", signature: "sig" }],
        { apiBlockIndex: 0, timestamp: "2026-10-09T06:56:44.000Z" },
      ),
      assistantEntry(
        "m1",
        [{ type: "text", text: "second block" }],
        { apiBlockIndex: 1, timestamp: "2026-10-09T06:56:45.000Z" },
      ),
    ];
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(2);
    const assistant = session.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(Array.isArray(assistant?.raw)).toBe(true);
    const parts = assistant?.raw as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "reasoning", text: "let me think" });
    expect(parts[1]).toEqual({ type: "text", text: "second block" });
    expect(assistant?.text).toBe("second block");
    expect(assistant?.ts).toBe(Date.parse("2026-10-09T06:56:44.000Z"));
  });

  it("normalizes thinking blocks to reasoning parts with text field", () => {
    const entries = [assistantEntry("m1", [{ type: "thinking", thinking: "deep thought", signature: "s" }])];
    const session = groupTranscript(entries);
    expect(session.messages[0]?.raw).toEqual({ type: "reasoning", text: "deep thought" });
    expect(session.messages[0]?.text).toBeUndefined();
  });

  it("maps tool_use to tool part and merges tool_result by tool_use_id into state.output", () => {
    const entries = [
      assistantEntry("m1", [
        { type: "text", text: "running" },
        { type: "tool_use", id: "tu-9", name: "Read", input: { file_path: "/x" } },
      ]),
      toolResultEntry("tu-9", "file content"),
      toolResultEntry("tu-other", "orphan result"),
    ];
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(1);
    const parts = session.messages[0]?.raw as Array<Record<string, any>>;
    const toolPart = parts.find((p) => p.type === "tool");
    expect(toolPart).toMatchObject({ callID: "tu-9", tool: "Read" });
    expect(toolPart?.state).toMatchObject({ status: "completed", input: { file_path: "/x" }, output: "file content" });
  });

  it("joins tool_result content arrays of text blocks", () => {
    const entries = [
      assistantEntry("m1", [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }]),
      toolResultEntry("tu-1", [{ type: "text", text: "line1" }, { type: "text", text: "line2" }]),
    ];
    const session = groupTranscript(entries);
    const toolPart = session.messages[0]?.raw as Record<string, any>;
    expect(toolPart.state?.output).toBe("line1\n\nline2");
  });
});

describe("truncation", () => {
  it("truncates message text at 1MB", () => {
    const big = "a".repeat(MAX_TEXT_LENGTH + 10);
    const entries = [userTextEntry(big)];
    const session = groupTranscript(entries);
    expect(session.messages[0]?.text?.endsWith(TRUNCATE_MARK)).toBe(true);
    expect(session.messages[0]?.text?.length).toBe(MAX_TEXT_LENGTH + TRUNCATE_MARK.length);
  });

  it("truncates tool output at 100KB", () => {
    const big = "b".repeat(MAX_TOOL_OUTPUT_LENGTH + 5);
    const entries = [
      assistantEntry("m1", [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }]),
      toolResultEntry("tu-1", big),
    ];
    const session = groupTranscript(entries);
    const toolPart = session.messages[0]?.raw as Record<string, any>;
    expect(toolPart.state?.output?.length).toBe(MAX_TOOL_OUTPUT_LENGTH + TRUNCATE_MARK.length);
  });

  it("keeps only the last 5000 messages", () => {
    const entries: ClaudeEntry[] = [];
    for (let i = 0; i < MAX_MESSAGES + 10; i++) {
      entries.push(userTextEntry(`msg-${i}`, { timestamp: new Date(1_000_000_000_000 + i * 1000).toISOString() }));
    }
    const session = groupTranscript(entries);
    expect(session.messages).toHaveLength(MAX_MESSAGES);
    expect(session.messages[0]?.text).toBe(`msg-10`);
    expect(session.messages[MAX_MESSAGES - 1]?.text).toBe(`msg-${MAX_MESSAGES + 9}`);
  });

  it("truncates title at 2000 chars", () => {
    const entries = [entry({ type: "ai-title", aiTitle: "t".repeat(MAX_TITLE_LENGTH + 5) }), userTextEntry("hi")];
    const session = groupTranscript(entries);
    expect(session.title?.length).toBe(MAX_TITLE_LENGTH + TRUNCATE_MARK.length);
  });
});

describe("title resolution", () => {
  it("prefers the latest ai-title entry", () => {
    const entries = [
      entry({ type: "ai-title", aiTitle: "old title" }),
      userTextEntry("first question"),
      entry({ type: "ai-title", aiTitle: "new title" }),
    ];
    const session = groupTranscript(entries);
    expect(session.title).toBe("new title");
  });

  it("falls back to the first user message sliced to 200 chars", () => {
    const entries = [userTextEntry("x".repeat(300)), userTextEntry("second")];
    const session = groupTranscript(entries);
    expect(session.title).toBe("x".repeat(200));
  });

  it("has no title when nothing usable exists", () => {
    const entries = [assistantEntry("m1", [{ type: "text", text: "hello" }])];
    const session = groupTranscript(entries);
    expect(session.title).toBeUndefined();
  });
});

describe("session metadata", () => {
  it("maps ISO timestamps to ms for created_at/updated_at", () => {
    const entries = [
      userTextEntry("a", { timestamp: "2026-10-09T06:00:00.000Z" }),
      userTextEntry("b", { timestamp: "2026-10-09T08:00:00.000Z" }),
      userTextEntry("c", { timestamp: "2026-10-09T07:00:00.000Z" }),
    ];
    const session = groupTranscript(entries);
    expect(session.createdAt).toBe(Date.parse("2026-10-09T06:00:00.000Z"));
    expect(session.updatedAt).toBe(Date.parse("2026-10-09T08:00:00.000Z"));
  });

  it("reads sessionId and cwd from entries", () => {
    const entries = [userTextEntry("a", { sessionId: "s-42", cwd: "D:\\proj" })];
    const session = groupTranscript(entries);
    expect(session.sessionId).toBe("s-42");
    expect(session.cwd).toBe("D:\\proj");
  });
});

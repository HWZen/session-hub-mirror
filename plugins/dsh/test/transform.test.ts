import { describe, expect, it } from "vitest";
import { TransformError, transformSession } from "../src/transform.js";
import type { DshSessionEvent, DshSessionHeader, DshSessionSnapshot } from "../src/types.js";
import {
  deltaOnlyDshLlmProviderReasoningStream,
  durableBlockEndOverrideDshLlmProviderReasoningStream,
  durablePackedDshLlmProviderReasoningStream,
  rawDshLlmProviderReasoningStream,
} from "./fixtures/dsh-llm-provider-reasoning.fixture.js";

const header: DshSessionHeader = {
  id: "session-1",
  createdAt: 1_700_000_000_000,
  cwd: "D:\\work\\project",
  parentSession: "parent-1",
  origin: "subagent",
};

function event(type: string, seq: number, data: unknown, time = 1_700_000_000_100 + seq): DshSessionEvent {
  return { type, seq, time, data };
}

function snapshot(events: DshSessionEvent[], sessionHeader = header): DshSessionSnapshot {
  return {
    header: sessionHeader,
    events,
    lastSeq: events.length === 0 ? -1 : events[events.length - 1]!.seq,
  };
}

function rawEventSeqs(messages: Array<{ raw: unknown }>): number[] {
  const seqs: number[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.raw)) continue;
    for (const part of message.raw) {
      if (part !== null && typeof part === "object" && "type" in part && part.type === "dsh-event"
        && "event" in part && part.event !== null && typeof part.event === "object" && "seq" in part.event
        && typeof part.event.seq === "number") {
        seqs.push(part.event.seq);
      }
    }
  }
  return seqs;
}

describe("transformSession", () => {
  it("maps both message envelopes and preserves every event in global sequence order", () => {
    const events = [
      event("session/title", 0, { title: "Reviewed title" }),
      event("turn/start", 1, { requestId: "r-1" }),
      event("user/message", 2, { content: [{ type: "text", text: "question" }, { type: "image", url: "private" }] }),
      event("assistant/attempt", 3, { stream: deltaOnlyDshLlmProviderReasoningStream }),
      event("assistant/retry", 4, { attempt: 2 }),
      event("assistant/message", 5, {
        message: { content: [{ type: "text", text: "answer" }, { type: "image", url: "private" }] },
        stream: durablePackedDshLlmProviderReasoningStream,
        usage: { outputTokens: 3 },
      }),
      event("tool/call", 6, { callId: "call-1", name: "read", arguments: { path: "secret.txt" } }),
      event("tool/result", 7, { message: { content: "tool output" }, meta: { duration: 12 } }),
      event("turn/end", 8, { status: "success" }),
    ];

    const payload = transformSession(snapshot(events), "DESKTOP-A");

    expect(payload).toMatchObject({
      agent: "dsh",
      machine: "DESKTOP-A",
      source_id: "session-1",
      title: "Reviewed title",
      cwd: "D:\\work\\project",
      created_at: header.createdAt,
      updated_at: events[8]!.time,
    });
    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(payload.messages[0]).toMatchObject({ text: "question", ts: events[2]!.time });
    expect(payload.messages[1]).toMatchObject({ text: "answer", ts: events[5]!.time });
    expect(payload.messages[2]).not.toHaveProperty("text");
    expect(rawEventSeqs(payload.messages)).toEqual(events.map((item) => item.seq));

    const userRaw = payload.messages[0]!.raw as Array<Record<string, unknown>>;
    const assistantRaw = payload.messages[1]!.raw as Array<Record<string, unknown>>;
    const toolRaw = payload.messages[2]!.raw as Array<Record<string, unknown>>;
    expect(assistantRaw.filter((part) => part["type"] === "reasoning").map((part) => part["text"]))
      .toEqual(["delta-only interrupted", "durable packed"]);
    expect(userRaw.some((part) => part["type"] === "dsh-header" && part["header"] === header)).toBe(true);
    expect(toolRaw.some((part) => part["type"] === "dsh-event"
      && (part["event"] as DshSessionEvent).type === "tool/call")).toBe(true);
  });

  it("lets wrapped block-end text override durable packed deltas", () => {
    const events = [event("assistant/message", 0, {
      message: { content: "answer" },
      stream: durableBlockEndOverrideDshLlmProviderReasoningStream,
    })];
    const payload = transformSession(snapshot(events), "machine");
    const raw = payload.messages[0]?.raw as Array<Record<string, unknown>>;
    expect(raw.filter((part) => part["type"] === "reasoning").map((part) => part["text"]))
      .toEqual(["complete reasoning"]);
  });

  it("continues to decode unwrapped provider chunks", () => {
    const events = [event("assistant/message", 0, {
      message: { content: "answer" },
      stream: rawDshLlmProviderReasoningStream,
    })];
    const payload = transformSession(snapshot(events), "machine");
    const raw = payload.messages[0]?.raw as Array<Record<string, unknown>>;
    expect(raw.filter((part) => part["type"] === "reasoning").map((part) => part["text"]))
      .toEqual(["raw completed"]);
  });

  it("ignores malformed durable reasoning indexes and text arrays", () => {
    const events = [event("assistant/message", 0, {
      message: { content: "answer" },
      stream: [
        { type: "reasoning-chunks", time0: 1, index: -1, dt: 2, texts: ["bad index"] },
        { type: "reasoning-chunks", time0: 1, index: 1, dt: 2, texts: "not an array" },
        { type: "reasoning-chunks", time0: 1, index: 2, dt: 2, texts: ["valid", 3] },
      ],
    })];
    const payload = transformSession(snapshot(events), "machine");
    const raw = payload.messages[0]?.raw as Array<Record<string, unknown>>;
    expect(raw.filter((part) => part["type"] === "reasoning")).toEqual([]);
  });

  it("uses nested message envelopes for developer, system, and tool results", () => {
    const events = [
      event("developer/message", 0, { message: { content: "internal" } }),
      event("system/message", 1, { message: { content: "system" } }),
      event("tool/result", 2, { message: { content: "result" }, error: null, meta: { tool: "x" } }),
    ];
    const payload = transformSession(snapshot(events), "machine");
    expect(payload.messages.map((message) => message.role)).toEqual(["developer", "system", "tool"]);
    expect(payload.messages.every((message) => !Object.hasOwn(message, "text"))).toBe(true);
    expect(rawEventSeqs(payload.messages)).toEqual([0, 1, 2]);
  });

  it("keeps all events in a synthetic event message when no message-bearing event exists", () => {
    const events = [event("tool/call", 0, { callId: "c", arguments: { value: 1 } }), event("turn/end", 1, {})];
    const payload = transformSession(snapshot(events), "machine");
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.role).toBe("event");
    expect(rawEventSeqs(payload.messages)).toEqual([0, 1]);
  });

  it("keeps interrupted reasoning in a synthetic assistant message at session end", () => {
    const attempt = event("assistant/attempt", 1, { stream: deltaOnlyDshLlmProviderReasoningStream });
    const events = [
      event("user/message", 0, { content: "question" }),
      attempt,
      event("turn/end", 2, { status: "interrupted" }),
    ];
    const payload = transformSession(snapshot(events), "machine");

    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(payload.messages[1]).toMatchObject({ text: "", ts: attempt.time });
    expect(rawEventSeqs(payload.messages)).toEqual([0, 1, 2]);
    expect((payload.messages[1]!.raw as Array<Record<string, unknown>>)
      .filter((part) => part["type"] === "reasoning").map((part) => part["text"]))
      .toEqual(["delta-only interrupted"]);
  });

  it("separates interrupted attempt reasoning before a following user message", () => {
    const attempt = event("assistant/attempt", 1, { stream: deltaOnlyDshLlmProviderReasoningStream });
    const events = [
      event("user/message", 0, { content: "first" }),
      attempt,
      event("user/message", 2, { content: "next" }),
    ];
    const payload = transformSession(snapshot(events), "machine");

    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(payload.messages[1]).toMatchObject({ text: "", ts: attempt.time });
    expect(rawEventSeqs(payload.messages)).toEqual([0, 1, 2]);
    expect((payload.messages[1]!.raw as Array<Record<string, unknown>>)
      .filter((part) => part["type"] === "reasoning").map((part) => part["text"]))
      .toEqual(["delta-only interrupted"]);
  });

  it("extracts only confirmed reasoning block chunks and skips encrypted or summary forms", () => {
    const events = [
      event("assistant/message", 0, {
        message: { content: "visible" },
        stream: [
          { type: "block-start", index: 0, blockType: "text" },
          { type: "block-end", index: 0, block: { type: "text", text: "visible" } },
          { type: "block-start", index: 1, blockType: "encrypted_reasoning" },
          { type: "block-end", index: 1, block: { type: "encrypted_reasoning", text: "ciphertext" } },
          { type: "reasoning_summary", summary: [{ text: "summary only" }] },
        ],
      }),
    ];
    const payload = transformSession(snapshot(events), "machine");
    const raw = payload.messages[0]?.raw as Array<Record<string, unknown>>;
    expect(raw.filter((part) => part["type"] === "reasoning")).toEqual([]);
    expect(rawEventSeqs(payload.messages)).toEqual([0]);
  });

  it("rejects over-limit sessions without truncating", () => {
    const tooLong = [event("user/message", 0, { content: "x".repeat(1_000_001) })];
    expect(() => transformSession(snapshot(tooLong), "machine"))
      .toThrowError(expect.objectContaining({ code: "text_too_long" }));

    const tooMany = Array.from({ length: 5_001 }, (_, index) =>
      event("user/message", index, { content: `message-${index}` }));
    expect(() => transformSession(snapshot(tooMany), "machine"))
      .toThrowError(expect.objectContaining({ code: "too_many_messages" }));
  });

  it("rejects non-contiguous sequences and invalid source timestamps", () => {
    expect(() => transformSession(snapshot([event("turn/start", 1, {})]), "machine"))
      .toThrowError(expect.objectContaining({ code: "non_contiguous_sequence" } satisfies Partial<TransformError>));
    const invalidTimestamp = [{ ...event("turn/start", 0, {}), time: -1 }];
    expect(() => transformSession(snapshot(invalidTimestamp), "machine"))
      .toThrowError(expect.objectContaining({ code: "invalid_timestamp" }));
  });
});

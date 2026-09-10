import { describe, expect, it } from "vitest";
import { extractReasoning } from "../src/indexing/raw-extract.js";

describe("extractReasoning", () => {
  it("returns [] for null, undefined and plain strings", () => {
    expect(extractReasoning("opencode", null)).toEqual([]);
    expect(extractReasoning("opencode", undefined)).toEqual([]);
    expect(extractReasoning("opencode", "plain text")).toEqual([]);
  });

  it("extracts reasoning parts from an array (opencode/zcode shape)", () => {
    const raw = [
      { type: "text", text: "answer" },
      { type: "reasoning", text: "think one", time: { start: 1 } },
      { type: "tool", tool: "bash" },
      { type: "reasoning", text: "think two" },
    ];
    expect(extractReasoning("opencode", raw)).toEqual(["think one", "think two"]);
  });

  it("handles a single bare object (non-array)", () => {
    expect(extractReasoning("zcode", { type: "reasoning", text: "solo" })).toEqual(["solo"]);
  });

  it("supports the Anthropic-style thinking field", () => {
    expect(extractReasoning("x", { type: "thinking", thinking: "deep" })).toEqual(["deep"]);
    expect(extractReasoning("x", { type: "thinking", text: "preferred" })).toEqual(["preferred"]);
  });

  it("joins OpenAI Responses style summary arrays", () => {
    const raw = {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "part a" }, { text: "part b" }],
    };
    expect(extractReasoning("workbuddy", raw)).toEqual(["part a\n\npart b"]);
  });

  it("skips encrypted-only reasoning without plaintext", () => {
    expect(extractReasoning("workbuddy", { type: "reasoning", encrypted_content: "abc" })).toEqual([]);
    expect(extractReasoning("workbuddy", { type: "reasoning", text: "   " })).toEqual([]);
  });

  it("ignores unknown part shapes and null entries", () => {
    expect(extractReasoning("x", [null, 42, { type: "text", text: "no" }])).toEqual([]);
  });
});

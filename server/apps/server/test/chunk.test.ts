import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_MAX_CHARS, chunkText } from "../src/indexing/chunk.js";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t ")).toEqual([]);
  });

  it("keeps short text as a single trimmed chunk", () => {
    expect(chunkText("hello world")).toEqual([{ text: "hello world", char_start: 0 }]);
    expect(chunkText("  hello  ")).toEqual([{ text: "hello", char_start: 2 }]);
  });

  it("splits on paragraph boundaries before the hard limit", () => {
    const a = "A".repeat(100);
    const b = "B".repeat(100);
    const chunks = chunkText(`${a}\n\n${b}`, { maxChars: 150, overlapChars: 0 });
    expect(chunks.map((c) => c.text)).toEqual([a, b]);
    expect(chunks[0]!.char_start).toBe(0);
    expect(chunks[1]!.char_start).toBe(a.length + 2);
  });

  it("hard-cuts long lines without separators", () => {
    const text = "x".repeat(250);
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 0 });
    expect(chunks.map((c) => c.text)).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
    expect(chunks.map((c) => c.char_start)).toEqual([0, 100, 200]);
  });

  it("applies overlap between adjacent hard-cut chunks", () => {
    const text = "y".repeat(250);
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 20 });
    expect(chunks.map((c) => c.char_start)).toEqual([0, 80, 160]);
  });

  it("caps overlap below maxChars and always makes progress", () => {
    const chunks = chunkText("z".repeat(50), { maxChars: 10, overlapChars: 999 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.char_start).toBeGreaterThan(chunks[i - 1]!.char_start);
    }
  });

  it("exposes the default chunk size constant", () => {
    expect(DEFAULT_CHUNK_MAX_CHARS).toBe(1200);
  });
});

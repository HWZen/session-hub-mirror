import { describe, expect, it } from "vitest";
import { buildLexicalMatch, MAX_LEXICAL_TRIGRAMS } from "../src/db/lexical.js";

function parse(matchExpr: string): string[] {
  return matchExpr.split(" OR ").map((t) => {
    expect(t.startsWith('"')).toBe(true);
    expect(t.endsWith('"')).toBe(true);
    return t.slice(1, -1).replaceAll('""', '"');
  });
}

describe("buildLexicalMatch", () => {
  it("returns null for queries without any 3-codepoint atom", () => {
    expect(buildLexicalMatch("ab")).toBeNull();
    expect(buildLexicalMatch("a b cd")).toBeNull();
    expect(buildLexicalMatch("   ")).toBeNull();
    expect(buildLexicalMatch("")).toBeNull();
  });

  it("emits sliding trigrams for ascii identifiers", () => {
    expect(parse(buildLexicalMatch("abc")!)).toEqual(["abc"]);
  });

  it("keeps separators inside kebab-case trigrams", () => {
    const trigrams = parse(buildLexicalMatch("no-negative-echo")!);
    expect(trigrams).toContain("no-");
    expect(trigrams).toContain("neg");
    expect(trigrams).toContain("ech");
    expect(trigrams).toContain("cho");
    expect(new Set(trigrams).size).toBe(trigrams.length);
  });

  it("works on contiguous chinese text without a word tokenizer", () => {
    expect(parse(buildLexicalMatch("混合检索")!)).toEqual(["混合检", "合检索"]);
  });

  it("splits atoms on unicode whitespace and windows each atom independently", () => {
    expect(parse(buildLexicalMatch("abcde efgh")!)).toEqual(["abc", "bcd", "cde", "efg", "fgh"]);
  });

  it("dedupes repeated trigrams", () => {
    expect(parse(buildLexicalMatch("aaa aaa")!)).toEqual(["aaa"]);
  });

  it("uses unicode code points, not utf-16 code units, for surrogate pairs", () => {
    const atom = "😀x😀";
    expect([...atom]).toHaveLength(3);
    expect(parse(buildLexicalMatch(atom)!)).toEqual([atom]);
  });

  it("escapes embedded double quotes", () => {
    expect(parse(buildLexicalMatch('a"b')!)).toEqual(['a"b']);
    expect(buildLexicalMatch('a"b')).toBe('"a""b"');
  });

  it("combines atoms from mixed scripts", () => {
    const trigrams = parse(buildLexicalMatch("ECONNRESET 连接重置")!);
    expect(trigrams).toContain("ECO");
    expect(trigrams).toContain("SET");
    expect(trigrams).toContain("连接重");
    expect(trigrams).toContain("接重置");
    expect(trigrams.some((t) => t.includes(" "))).toBe(false);
  });

  it("caps the trigram count with even sampling that keeps the first and last", () => {
    const atom = Array.from({ length: 150 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    const expr = buildLexicalMatch(atom)!;
    const trigrams = parse(expr);
    expect(trigrams).toHaveLength(MAX_LEXICAL_TRIGRAMS);
    expect(trigrams[0]).toBe(atom.slice(0, 3));
    expect(trigrams[MAX_LEXICAL_TRIGRAMS - 1]).toBe(atom.slice(-3));
    const unique = new Set(trigrams);
    expect(unique.size).toBe(MAX_LEXICAL_TRIGRAMS);
  });
});

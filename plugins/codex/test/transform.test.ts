import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRolloutText } from "../src/parse.js";
import { MAX_MESSAGES, MAX_TEXT_LENGTH, transformRollout, truncateText } from "../src/transform.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("transformRollout", () => {
  it("groups desktop tools and reasoning into one assistant turn", () => {
    const parsed = parseRolloutText(fixture("desktop-rollout.jsonl"), "desktop.jsonl")!;
    const transformed = transformRollout(parsed, {
      machine: "TEST-PC",
      title: "Indexed title",
      titleUpdatedAt: Date.parse("2026-09-18T02:00:00Z"),
    });
    expect(transformed).toMatchObject({
      agent: "codex",
      machine: "TEST-PC",
      source_id: "11111111-1111-4111-8111-111111111111",
      title: "Indexed title",
      cwd: "D:\\workspace\\demo",
    });
    expect(transformed.messages).toHaveLength(2);
    expect(transformed.messages[0]).toMatchObject({ role: "user", text: "Inspect the demo project." });
    expect(transformed.messages[1]?.text).toBe("I found the entry point.\n\nThe requested change is complete.");
    const raw = transformed.messages[1]?.raw as Array<Record<string, unknown>>;
    expect(raw.find((part) => part["type"] === "reasoning")).toMatchObject({
      text: "I should inspect the files first.",
    });
    expect(raw.filter((part) => part["type"] === "tool")).toHaveLength(3);
  });

  it("drops developer messages and uses legacy plaintext reasoning only", () => {
    const parsed = parseRolloutText(fixture("cli-legacy-rollout.jsonl"), "cli.jsonl")!;
    const transformed = transformRollout(parsed, { machine: "CLI-PC" });
    expect(transformed.title).toBe("Run the checks.");
    expect(transformed.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Run the checks."],
      ["assistant", "All checks passed."],
    ]);
    expect(JSON.stringify(transformed.messages)).not.toContain("Injected repository instructions");
    const assistantRaw = transformed.messages[1]?.raw as Array<Record<string, unknown>>;
    expect(assistantRaw.find((part) => part["type"] === "reasoning")).toMatchObject({
      text: "I need to run the test command.",
    });
    expect(JSON.stringify(assistantRaw)).toContain("encrypted-only");
  });

  it("enforces text and message limits", () => {
    expect(truncateText("x".repeat(MAX_TEXT_LENGTH + 1))).toHaveLength(MAX_TEXT_LENGTH);
    const parsed = parseRolloutText(fixture("cli-legacy-rollout.jsonl"), "cli.jsonl")!;
    const original = parsed.legacyItems;
    parsed.legacyItems = Array.from({ length: MAX_MESSAGES + 2 }, (_, index) => original[index % original.length]!);
    expect(transformRollout(parsed).messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
  });
});

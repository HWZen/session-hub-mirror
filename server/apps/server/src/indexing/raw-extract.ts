function toParts(raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function textFromSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  const pieces: string[] = [];
  for (const item of summary) {
    if (typeof item === "string") {
      if (item.trim() !== "") pieces.push(item);
      continue;
    }
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const text = record.text ?? record.summary_text;
      if (typeof text === "string" && text.trim() !== "") pieces.push(text);
    }
  }
  return pieces.join("\n\n");
}

function reasoningPartText(part: Record<string, unknown>): string {
  if (typeof part.text === "string" && part.text.trim() !== "") return part.text;
  if (typeof part.thinking === "string" && part.thinking.trim() !== "") return part.thinking;
  return textFromSummary(part.summary);
}

export function extractReasoning(_agent: string, raw: unknown): string[] {
  const out: string[] = [];
  for (const part of toParts(raw)) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    const isReasoningPart = record.type === "reasoning" || record.type === "thinking";
    const text = isReasoningPart ? reasoningPartText(record) : textFromSummary(record.summary);
    if (text !== "") out.push(text);
  }
  return out;
}

import { hostname } from "node:os";
import { asRecord, extractReasoningText, type ParsedEventItem, type ParsedLegacyItem, type ParsedRollout } from "./parse.js";

export const MAX_MESSAGES = 5000;
export const MAX_TEXT_LENGTH = 1_000_000;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

export interface TransformedMessage {
  role: "user" | "assistant";
  text?: string;
  ts?: number;
  raw: unknown;
}

export interface TransformedSession {
  agent: "codex";
  machine: string;
  source_id: string;
  title?: string;
  cwd?: string;
  created_at: number;
  updated_at: number;
  messages: TransformedMessage[];
}

export interface TransformOptions {
  machine?: string;
  title?: string;
  titleUpdatedAt?: number;
  cwd?: string;
}

interface AssistantAccumulator {
  texts: string[];
  raw: unknown[];
  ts?: number;
}

export function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.slice(0, MAX_TEXT_LENGTH - TRUNCATE_MARK.length) + TRUNCATE_MARK;
}

function itemText(item: Record<string, unknown>): string[] {
  const content = item["content"];
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const result: string[] = [];
  for (const part of content) {
    if (typeof part === "string" && part.length > 0) result.push(part);
    const record = asRecord(part);
    if (!record) continue;
    const type = typeof record["type"] === "string" ? record["type"].toLowerCase() : "";
    if (["text", "input_text", "output_text"].includes(type) && typeof record["text"] === "string") {
      if (record["text"].length > 0) result.push(record["text"]);
    }
  }
  return result;
}

function eventTime(entry: ParsedEventItem): number | undefined {
  return entry.startedAtMs ?? entry.timestampMs ?? entry.completedAtMs;
}

function legacyTime(entry: ParsedLegacyItem): number | undefined {
  const metadata = asRecord(entry.payload["internal_chat_message_metadata_passthrough"]);
  return entry.timestampMs ?? (metadata ? timestampFromSeconds(metadata["create_time"]) : undefined);
}

function timestampFromSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value < 100_000_000_000 ? value * 1000 : value)
    : undefined;
}

function assistantMessage(accumulator: AssistantAccumulator): TransformedMessage | null {
  if (accumulator.texts.length === 0 && accumulator.raw.length === 0) return null;
  const text = accumulator.texts.join("\n\n");
  return {
    role: "assistant",
    ...(text.length === 0 ? {} : { text: truncateText(text) }),
    ...(accumulator.ts === undefined ? {} : { ts: accumulator.ts }),
    raw: accumulator.raw.length === 1 ? accumulator.raw[0] : accumulator.raw,
  };
}

function transformEventItems(entries: ParsedEventItem[]): TransformedMessage[] {
  const messages: TransformedMessage[] = [];
  let assistant: AssistantAccumulator = { texts: [], raw: [] };
  const flush = (): void => {
    const message = assistantMessage(assistant);
    if (message) messages.push(message);
    assistant = { texts: [], raw: [] };
  };
  for (const entry of entries) {
    const type = entry.item["type"];
    if (type === "UserMessage") {
      flush();
      const pieces = itemText(entry.item);
      const text = pieces.join("\n\n");
      const ts = eventTime(entry);
      messages.push({
        role: "user",
        ...(text.length === 0 ? {} : { text: truncateText(text) }),
        ...(ts === undefined ? {} : { ts }),
        raw: entry.item,
      });
      continue;
    }
    const ts = eventTime(entry);
    if (assistant.ts === undefined && ts !== undefined) assistant.ts = ts;
    if (type === "AgentMessage") {
      assistant.texts.push(...itemText(entry.item));
      assistant.raw.push(entry.item);
      continue;
    }
    if (type === "Reasoning") {
      const text = extractReasoningText(entry.item);
      if (text.length > 0) {
        assistant.raw.push({ type: "reasoning", text: text.join("\n\n"), original: entry.item });
      } else {
        assistant.raw.push(entry.item);
      }
      continue;
    }
    const state = typeof entry.item["status"] === "string" ? entry.item["status"] : "completed";
    const tool = type === "Extension" && typeof entry.item["kind"] === "string"
      ? entry.item["kind"]
      : typeof type === "string" ? type : "unknown";
    assistant.raw.push({ type: "tool", tool, state, original: entry.item });
  }
  flush();
  return messages;
}

function transformLegacyItems(entries: ParsedLegacyItem[]): TransformedMessage[] {
  const messages: TransformedMessage[] = [];
  let assistant: AssistantAccumulator = { texts: [], raw: [] };
  const flush = (): void => {
    const message = assistantMessage(assistant);
    if (message) messages.push(message);
    assistant = { texts: [], raw: [] };
  };
  for (const entry of entries) {
    const payload = entry.payload;
    const type = payload["type"];
    if (type === "message") {
      const role = payload["role"];
      if (role !== "user" && role !== "assistant") continue;
      const pieces = itemText(payload);
      if (role === "user") {
        flush();
        const text = pieces.join("\n\n");
        const ts = legacyTime(entry);
        messages.push({
          role: "user",
          ...(text.length === 0 ? {} : { text: truncateText(text) }),
          ...(ts === undefined ? {} : { ts }),
          raw: payload,
        });
      } else {
        const ts = legacyTime(entry);
        if (assistant.ts === undefined && ts !== undefined) assistant.ts = ts;
        assistant.texts.push(...pieces);
        assistant.raw.push(payload);
      }
      continue;
    }
    const ts = legacyTime(entry);
    if (assistant.ts === undefined && ts !== undefined) assistant.ts = ts;
    if (type === "reasoning") {
      const text = extractReasoningText(payload);
      if (text.length > 0) {
        assistant.raw.push({ type: "reasoning", text: text.join("\n\n"), original: payload });
      } else {
        assistant.raw.push(payload);
      }
      continue;
    }
    if (typeof type === "string") {
      const state = typeof payload["status"] === "string" ? payload["status"] : "completed";
      const tool = typeof payload["name"] === "string" ? payload["name"] : type;
      assistant.raw.push({ type: "tool", tool, state, original: payload });
    }
  }
  flush();
  return messages;
}

export function transformRollout(
  rollout: ParsedRollout,
  options: TransformOptions = {},
): TransformedSession {
  let messages = rollout.stats.usedLegacyFallback
    ? transformLegacyItems(rollout.legacyItems)
    : transformEventItems(rollout.eventItems);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  const fallbackTitle = messages.find((message) => message.role === "user" && message.text)?.text;
  const title = options.title ?? fallbackTitle;
  const cwd = rollout.cwd ?? options.cwd;
  const updatedAt = Math.max(rollout.updatedAt, options.titleUpdatedAt ?? 0);
  return {
    agent: "codex",
    machine: options.machine ?? hostname(),
    source_id: rollout.sourceId,
    ...(title === undefined ? {} : { title: title.slice(0, 2000) }),
    ...(cwd === undefined ? {} : { cwd: cwd.slice(0, 2000) }),
    created_at: rollout.createdAt,
    updated_at: updatedAt,
    messages,
  };
}

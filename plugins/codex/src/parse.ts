import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface ParsedEventItem {
  item: Record<string, unknown>;
  ordinal: number;
  timestampMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  turnId?: string;
}

export interface ParsedLegacyItem {
  payload: Record<string, unknown>;
  ordinal: number;
  timestampMs?: number;
}

export interface ParseStats {
  lines: number;
  invalidLines: number;
  unknownEvents: number;
  skippedEncryptedReasoning: number;
  usedLegacyFallback: boolean;
}

export interface ParsedRollout {
  filePath: string;
  sourceId: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  isSubagent: boolean;
  eventItems: ParsedEventItem[];
  legacyItems: ParsedLegacyItem[];
  stats: ParseStats;
}

export interface TitleEntry {
  title: string;
  updatedAt?: number;
}

const EVENT_ITEM_TYPES = new Set([
  "UserMessage",
  "AgentMessage",
  "Reasoning",
  "CommandExecution",
  "Extension",
  "FileChange",
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value > 0 && value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return toTimestampMs(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sourceIdFromPath(filePath: string): string | null {
  const match = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return match?.[1] ?? null;
}

export function parseRolloutText(text: string, filePath = "rollout.jsonl"): ParsedRollout | null {
  const lines = text.split(/\r?\n/);
  let meta: Record<string, unknown> | null = null;
  const eventItems: ParsedEventItem[] = [];
  const legacyItems: ParsedLegacyItem[] = [];
  const timestamps: number[] = [];
  const stats: ParseStats = {
    lines: 0,
    invalidLines: 0,
    unknownEvents: 0,
    skippedEncryptedReasoning: 0,
    usedLegacyFallback: false,
  };

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    stats.lines++;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      stats.invalidLines++;
      continue;
    }
    const row = asRecord(value);
    if (!row || typeof row["type"] !== "string") {
      stats.unknownEvents++;
      continue;
    }
    const timestampMs = toTimestampMs(row["timestamp"]);
    if (timestampMs !== undefined) timestamps.push(timestampMs);
    const ordinal = typeof row["ordinal"] === "number" && Number.isFinite(row["ordinal"])
      ? row["ordinal"]
      : stats.lines;
    const payload = asRecord(row["payload"]);
    if (row["type"] === "session_meta" && payload) {
      meta ??= payload;
      const metaTimestamp = toTimestampMs(payload["timestamp"]);
      if (metaTimestamp !== undefined) timestamps.push(metaTimestamp);
      continue;
    }
    if (row["type"] === "event_msg" && payload?.["type"] === "item_completed") {
      const item = asRecord(payload["item"]);
      if (!item || typeof item["type"] !== "string") {
        stats.unknownEvents++;
        continue;
      }
      if (!EVENT_ITEM_TYPES.has(item["type"])) stats.unknownEvents++;
      const startedAtMs = toTimestampMs(payload["started_at_ms"]);
      const completedAtMs = toTimestampMs(payload["completed_at_ms"]);
      if (startedAtMs !== undefined) timestamps.push(startedAtMs);
      if (completedAtMs !== undefined) timestamps.push(completedAtMs);
      const turnId = typeof payload["turn_id"] === "string" ? payload["turn_id"] : undefined;
      eventItems.push({
        item,
        ordinal,
        ...(timestampMs === undefined ? {} : { timestampMs }),
        ...(startedAtMs === undefined ? {} : { startedAtMs }),
        ...(completedAtMs === undefined ? {} : { completedAtMs }),
        ...(turnId === undefined ? {} : { turnId }),
      });
      continue;
    }
    if (row["type"] === "response_item" && payload) {
      legacyItems.push({ payload, ordinal, ...(timestampMs === undefined ? {} : { timestampMs }) });
      if (
        payload["type"] === "reasoning" &&
        typeof payload["encrypted_content"] === "string" &&
        extractReasoningText(payload).length === 0
      ) {
        stats.skippedEncryptedReasoning++;
      }
      continue;
    }
  }

  eventItems.sort((a, b) => a.ordinal - b.ordinal);
  legacyItems.sort((a, b) => a.ordinal - b.ordinal);
  const hasEventDialogue = eventItems.some((entry) => {
    const type = entry.item["type"];
    return type === "UserMessage" || type === "AgentMessage";
  });
  stats.usedLegacyFallback = !hasEventDialogue;
  const sourceId =
    (typeof meta?.["session_id"] === "string" && meta["session_id"].length > 0 ? meta["session_id"] : null) ??
    (typeof meta?.["id"] === "string" && meta["id"].length > 0 ? meta["id"] : null) ??
    sourceIdFromPath(filePath);
  if (!sourceId) return null;
  const metaTimestamp = toTimestampMs(meta?.["timestamp"]);
  const createdAt = metaTimestamp ?? (timestamps.length > 0 ? Math.min(...timestamps) : 0);
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : createdAt;
  const cwd = typeof meta?.["cwd"] === "string" && meta["cwd"].length > 0 ? meta["cwd"] : undefined;
  const source = asRecord(meta?.["source"]);
  return {
    filePath,
    sourceId,
    ...(cwd === undefined ? {} : { cwd }),
    createdAt,
    updatedAt,
    isSubagent: source?.["subagent"] !== undefined,
    eventItems,
    legacyItems,
    stats,
  };
}

export function extractReasoningText(payload: Record<string, unknown>): string[] {
  const text: string[] = [];
  for (const field of ["summary_text", "raw_content", "summary"]) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) text.push(value);
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) text.push(entry);
      const record = asRecord(entry);
      if (record && typeof record["text"] === "string" && record["text"].length > 0) {
        text.push(record["text"]);
      }
    }
  }
  return text;
}

export function readRolloutFile(filePath: string): ParsedRollout | null {
  return parseRolloutText(readFileSync(filePath, "utf8"), filePath);
}

export function readTitleIndex(indexPath: string): Map<string, TitleEntry> {
  const titles = new Map<string, TitleEntry>();
  let text: string;
  try {
    text = readFileSync(indexPath, "utf8");
  } catch {
    return titles;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const row = asRecord(value);
    const id = typeof row?.["id"] === "string" ? row["id"] : null;
    const title = typeof row?.["thread_name"] === "string" ? row["thread_name"] : null;
    if (!id || !title) continue;
    const updatedAt = toTimestampMs(row?.["updated_at"]);
    const previous = titles.get(id);
    if (!previous || (updatedAt ?? 0) >= (previous.updatedAt ?? 0)) {
      titles.set(id, { title, ...(updatedAt === undefined ? {} : { updatedAt }) });
    }
  }
  return titles;
}

export function defaultCodexHome(env: Record<string, string | undefined> = process.env): string {
  return env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

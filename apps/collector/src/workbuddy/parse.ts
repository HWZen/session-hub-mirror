import type { MessageInput, SessionUpsertInput } from "@session-hub/shared";

export const AGENT_ID = "workbuddy";

export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGES = 5000;
export const MAX_TITLE_LENGTH = 100;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

export interface WorkbuddySource {
  sessionId?: string | null;
  transcriptPath?: string | null;
  cwd?: string | null;
  machine?: string;
  fallbackCreatedMs?: number;
  fallbackUpdatedMs?: number;
}

export interface ParseStats {
  lines: number;
  parseErrors: number;
  kept: number;
  dropped: number;
}

export interface ParseResult {
  payload: SessionUpsertInput | null;
  stats: ParseStats;
}

interface ParsedLine {
  ts: number | null;
  role: string | null;
  content: unknown;
  message: unknown;
  aiTitle: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}

function parseTs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (typeof value !== "string") return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractUserText(text: string): string | null {
  const matches = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) =>
    (m[1] ?? "").trim(),
  );
  const tagged = matches.filter((s) => s.length > 0);
  if (tagged.length > 0) return tagged.join("\n\n");
  const stripped = text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-reminder[\s\S]*$/, "");
  const trimmed = stripped.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLine(line: string): ParsedLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const message = record["message"];
  const messageRecord = asRecord(message);
  const role =
    typeof messageRecord?.["role"] === "string"
      ? (messageRecord["role"] as string)
      : typeof record["role"] === "string"
        ? (record["role"] as string)
        : null;
  return {
    ts: parseTs(record["timestamp"]),
    role: role !== null && role.length >= 1 && role.length <= 64 ? role : null,
    content: messageRecord
      ? messageRecord["content"] !== undefined
        ? messageRecord["content"]
        : record["content"]
      : record["content"],
    message,
    aiTitle: typeof record["aiTitle"] === "string" && record["aiTitle"].length > 0 ? record["aiTitle"] : null,
  };
}

const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

function joinTextParts(parts: unknown[]): { text: string | null; raw: unknown } {
  const pieces: string[] = [];
  for (const part of parts) {
    const p = asRecord(part);
    if (!p) continue;
    if (!TEXT_PART_TYPES.has(typeof p["type"] === "string" ? p["type"] : "") || typeof p["text"] !== "string") {
      continue;
    }
    pieces.push(p["text"]);
  }
  const raw = parts.length === 1 ? (parts[0] ?? null) : parts;
  if (pieces.length === 0) return { text: null, raw };
  return { text: pieces.join("\n\n"), raw };
}

export function parseTranscript(jsonl: string, source: WorkbuddySource): ParseResult {
  const stats: ParseStats = { lines: 0, parseErrors: 0, kept: 0, dropped: 0 };
  const rawLines = jsonl.split(/\r?\n/).filter((l) => l.trim().length > 0);

  let sessionId = source.sessionId ?? null;
  if ((!sessionId || sessionId.length === 0) && source.transcriptPath) {
    const base = source.transcriptPath.replace(/\\/g, "/").split("/").pop() ?? "";
    sessionId = base.replace(/\.jsonl$/i, "");
  }
  if (!sessionId || sessionId.length === 0) {
    return { payload: null, stats };
  }

  const messages: MessageInput[] = [];
  let firstUserText: string | null = null;
  let aiTitle: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const line of rawLines) {
    stats.lines++;
    const parsed = parseLine(line);
    if (!parsed) {
      stats.parseErrors++;
      continue;
    }
    if (parsed.ts !== null) {
      if (firstTs === null) firstTs = parsed.ts;
      lastTs = parsed.ts;
    }
    if (parsed.aiTitle !== null && aiTitle === null) aiTitle = parsed.aiTitle;
    if (parsed.role === null) {
      stats.dropped++;
      continue;
    }
    let text: string | null = null;
    let raw: unknown;
    if (typeof parsed.content === "string") {
      text = parsed.content;
      raw = parsed.content;
    } else if (Array.isArray(parsed.content)) {
      const joined = joinTextParts(parsed.content);
      text = joined.text;
      raw = joined.raw;
    } else {
      raw = parsed.message ?? null;
    }
    if (parsed.role === "user" && text !== null) {
      text = extractUserText(text);
    }
    if (text !== null) text = truncateText(text, MAX_TEXT_LENGTH);
    const message: MessageInput = { role: parsed.role, raw };
    if (text !== null) message.text = text;
    if (parsed.ts !== null) message.ts = parsed.ts;
    if (parsed.role === "user" && text !== null && firstUserText === null) {
      firstUserText = text;
    }
    messages.push(message);
    stats.kept++;
  }

  const trimmedMessages = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;

  const created = firstTs ?? source.fallbackCreatedMs ?? 0;
  const updated = lastTs ?? source.fallbackUpdatedMs ?? created;
  const payload: SessionUpsertInput = {
    agent: AGENT_ID,
    machine: source.machine && source.machine.length > 0 ? source.machine : "unknown",
    source_id: sessionId,
    created_at: Math.floor(created),
    updated_at: Math.floor(updated),
    messages: trimmedMessages,
  };
  if (source.cwd) payload.cwd = truncateText(source.cwd, 2000);
  if (aiTitle !== null) payload.title = truncateText(aiTitle, 2000);
  else if (firstUserText !== null) payload.title = firstUserText.slice(0, MAX_TITLE_LENGTH);
  return { payload, stats };
}

import { readFileSync } from "node:fs";

export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGES = 5000;
export const MAX_TOOL_OUTPUT_LENGTH = 100_000;
export const MAX_TITLE_LENGTH = 2000;
export const TITLE_FALLBACK_LENGTH = 200;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

const NON_DIALOG_ENTRY_TYPES = new Set([
  "attachment",
  "ai-title",
  "last-prompt",
  "system",
  "queue-operation",
  "mode",
  "permission-mode",
  "atis-latch",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
]);

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface ClaudeEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  version?: string;
  timestamp?: string;
  apiBlockIndex?: number;
  aiTitle?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
  };
}

export interface TranscriptMessage {
  role: string;
  text?: string;
  ts?: number;
  raw?: unknown;
}

export interface TranscriptSession {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messages: TranscriptMessage[];
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}

export function readTranscript(path: string): ClaudeEntry[] {
  const content = readFileSync(path, "utf8");
  const entries: ClaudeEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ClaudeEntry);
    } catch {
      // skip malformed lines; partial trailing line can appear while transcript is being written
    }
  }
  return entries;
}

function entryTimestampMs(entry: ClaudeEntry): number {
  if (typeof entry.timestamp !== "string") return Number.NaN;
  const ms = Date.parse(entry.timestamp);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function toolResultText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      pieces.push(block.text);
    }
  }
  return pieces.join("\n\n");
}

function isRealUserInput(entry: ClaudeEntry): boolean {
  return entry.type === "user" && typeof entry.message?.content === "string";
}

function isToolResultCarrier(entry: ClaudeEntry): boolean {
  return entry.type === "user" && Array.isArray(entry.message?.content);
}

function isInjectedPrompt(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

interface AssistantGroup {
  key: string;
  entries: ClaudeEntry[];
}

export function groupTranscript(entries: ClaudeEntry[]): TranscriptSession {
  const sessionId = entries.find((e) => typeof e.sessionId === "string")?.sessionId ?? "";
  const cwd = entries.find((e) => typeof e.cwd === "string")?.cwd ?? "";

  const title = [...entries]
    .reverse()
    .find((e) => e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.length > 0)?.aiTitle;

  const toolResults = new Map<string, string>();
  for (const entry of entries) {
    const content = isToolResultCarrier(entry) ? entry.message?.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        toolResults.set(block.tool_use_id, toolResultText(block.content));
      }
    }
  }

  const ordered: Array<TranscriptMessage | AssistantGroup> = [];
  const groups = new Map<string, AssistantGroup>();

  for (const entry of entries) {
    if (NON_DIALOG_ENTRY_TYPES.has(entry.type)) continue;
    if (entry.isSidechain === true) continue;

    if (isRealUserInput(entry) && entry.message) {
      const text = entry.message.content as string;
      if (isInjectedPrompt(text)) continue;
      const ts = entryTimestampMs(entry);
      ordered.push({
        role: "user",
        text: truncateText(text, MAX_TEXT_LENGTH),
        ...(Number.isFinite(ts) ? { ts } : {}),
      });
      continue;
    }

    if (isToolResultCarrier(entry)) continue;

    if (entry.type === "assistant" && entry.message && Array.isArray(entry.message.content)) {
      const key = typeof entry.message.id === "string" && entry.message.id.length > 0
        ? entry.message.id
        : (entry.uuid ?? "");
      let group = groups.get(key);
      if (!group) {
        group = { key, entries: [] };
        groups.set(key, group);
        ordered.push(group);
      }
      group.entries.push(entry);
    }
  }

  const messages: TranscriptMessage[] = [];
  for (const item of ordered) {
    if (!("key" in item)) {
      messages.push(item);
      continue;
    }
    const group = item as AssistantGroup;
    const sorted = [...group.entries].sort((a, b) => (a.apiBlockIndex ?? 0) - (b.apiBlockIndex ?? 0));
    const parts: Array<Record<string, unknown>> = [];
    const textPieces: string[] = [];
    for (const entry of sorted) {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          parts.push({ type: "reasoning", text: block.thinking });
        } else if (block.type === "text" && typeof block.text === "string") {
          parts.push({ type: "text", text: block.text });
          textPieces.push(block.text);
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const state: Record<string, unknown> = { status: "completed", input: block.input };
          const output = toolResults.get(block.id);
          if (output !== undefined) state["output"] = truncateText(output, MAX_TOOL_OUTPUT_LENGTH);
          parts.push({ type: "tool", callID: block.id, tool: block.name, state });
        }
      }
    }
    const ts = entryTimestampMs(sorted[0] ?? group.entries[0]!);
    const message: TranscriptMessage = {
      role: "assistant",
      raw: parts.length === 1 ? parts[0] : parts,
      ...(Number.isFinite(ts) ? { ts } : {}),
    };
    if (textPieces.length > 0) message.text = truncateText(textPieces.join("\n\n"), MAX_TEXT_LENGTH);
    messages.push(message);
  }

  const trimmed = messages.slice(-MAX_MESSAGES);

  const timestamps = entries
    .map(entryTimestampMs)
    .filter((ms) => Number.isFinite(ms));
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  const fallbackTitle = trimmed.find((m) => m.role === "user" && typeof m.text === "string" && m.text.length > 0)
    ?.text?.slice(0, TITLE_FALLBACK_LENGTH);

  const session: TranscriptSession = {
    sessionId,
    cwd,
    createdAt,
    updatedAt,
    messages: trimmed,
  };
  const effectiveTitle = title ?? fallbackTitle;
  if (effectiveTitle !== undefined && effectiveTitle.length > 0) {
    session.title = truncateText(effectiveTitle, MAX_TITLE_LENGTH);
  }
  return session;
}

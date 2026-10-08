import { hostname } from "node:os";

export const AGENT_ID = "hermes";
export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGES = 5000;
export const MAX_TITLE_LENGTH = 2000;
export const MAX_CWD_LENGTH = 2000;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

export interface HermesSessionRow {
  id: string;
  title: string | null;
  cwd: string | null;
  git_repo_root: string | null;
  started_at: number;
  last_activity_at: number;
}

export interface HermesMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls: string | null;
}

export interface TransformedMessage {
  role: string;
  text?: string;
  raw: unknown;
}

export interface TransformedSession {
  agent: string;
  machine: string;
  source_id: string;
  title?: string;
  cwd?: string;
  created_at: number;
  updated_at: number;
  messages: TransformedMessage[];
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATE_MARK.length) return TRUNCATE_MARK.slice(0, limit);
  return text.slice(0, limit - TRUNCATE_MARK.length) + TRUNCATE_MARK;
}

function timestampToMilliseconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value);
}

function parseToolCalls(value: string | null): string | null {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function messageRaw(message: HermesMessageRow, text: string | undefined): unknown {
  const parts: unknown[] = [];
  if (message.role === "tool") {
    const toolPart: Record<string, unknown> = { type: "tool" };
    if (text !== undefined) toolPart["text"] = text;
    if (message.tool_name) toolPart["tool_name"] = message.tool_name;
    if (message.tool_call_id) toolPart["tool_call_id"] = message.tool_call_id;
    parts.push(toolPart);
  } else if (text !== undefined) {
    parts.push({ type: "text", text });
  }
  if (message.role === "assistant") {
    const calls = parseToolCalls(message.tool_calls);
    if (calls !== null) parts.push({ type: "tool", text: truncateText(calls, MAX_TEXT_LENGTH) });
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : parts;
}

function appendTruncationMarker(message: TransformedMessage): void {
  const priorText = message.text ?? "";
  message.text = truncateText(priorText + TRUNCATE_MARK, MAX_TEXT_LENGTH);
  const markerPart = { type: "text", text: TRUNCATE_MARK };
  if (Array.isArray(message.raw)) {
    message.raw = [...message.raw, markerPart];
  } else if (message.raw === null || message.raw === undefined) {
    message.raw = markerPart;
  } else {
    message.raw = [message.raw, markerPart];
  }
}

export function transformSession(
  session: HermesSessionRow,
  messages: HermesMessageRow[],
  machine: string = hostname(),
): TransformedSession {
  const eligible = messages.filter((message) => message.role !== "session_meta");
  const trimmed = eligible.length > MAX_MESSAGES;
  const selected = trimmed ? eligible.slice(-MAX_MESSAGES) : eligible;
  const transformedMessages: TransformedMessage[] = selected.map((message) => {
    const role = message.role.slice(0, 64);
    const isTool = message.role === "tool";
    const contentText = typeof message.content === "string"
      ? truncateText(message.content, MAX_TEXT_LENGTH)
      : undefined;
    const transformed: TransformedMessage = { role, raw: messageRaw(message, contentText) };
    // tool 消息：顶层不设 text（非全量接口与 Web 列表不显示），产出保留在 raw 的 toolPart.text（/full 可见）
    if (!isTool && contentText !== undefined) transformed.text = contentText;
    return transformed;
  });
  if (trimmed && transformedMessages.length > 0) {
    appendTruncationMarker(transformedMessages[transformedMessages.length - 1]!);
  }

  const result: TransformedSession = {
    agent: AGENT_ID,
    machine,
    source_id: session.id,
    created_at: timestampToMilliseconds(session.started_at),
    updated_at: timestampToMilliseconds(session.last_activity_at),
    messages: transformedMessages,
  };
  if (session.title) result.title = truncateText(session.title, MAX_TITLE_LENGTH);
  const cwd = session.cwd || session.git_repo_root;
  if (cwd) result.cwd = cwd.slice(0, MAX_CWD_LENGTH);
  return result;
}

import { hostname } from "node:os";

export const AGENT_ID = "zcode";

export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGES = 5000;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

export interface ZcodeSessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
}

export interface ZcodeMessageRow {
  id: string;
  time_created: number;
  sequence: number | null;
  data: unknown;
  parts: unknown[];
}

export interface TransformedMessage {
  role: string;
  text?: string;
  ts?: number;
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

const DIALOG_KINDS = new Set(["user_prompt", "assistant_response"]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}

export function isDialogMessage(data: unknown): boolean {
  const record = asRecord(data);
  if (!record) return false;
  const semantics = asRecord(record["semantics"]);
  if (!semantics) return false;
  return typeof semantics["kind"] === "string" && DIALOG_KINDS.has(semantics["kind"]);
}

export function transformSession(
  session: ZcodeSessionRow,
  messages: ZcodeMessageRow[],
  machine: string = hostname(),
): TransformedSession {
  const dialog = messages.filter((m) => isDialogMessage(m.data));
  let selected = dialog.filter((m) => {
    const record = asRecord(m.data);
    const role = record?.["role"];
    return typeof role === "string" && role.length >= 1 && role.length <= 64;
  });
  selected.sort((a, b) => a.time_created - b.time_created || (a.sequence ?? 0) - (b.sequence ?? 0));
  if (selected.length > MAX_MESSAGES) {
    selected = selected.slice(-MAX_MESSAGES);
  }
  const transformed: TransformedMessage[] = selected.map((m) => {
    const record = asRecord(m.data);
    const role = typeof record?.["role"] === "string" ? (record?.["role"] as string) : "";
    const textPieces: string[] = [];
    for (const part of m.parts) {
      const p = asRecord(part);
      if (!p || p["type"] !== "text" || typeof p["text"] !== "string") continue;
      textPieces.push(p["text"] as string);
    }
    const rawJoined = m.parts.length === 1 ? (m.parts[0] ?? null) : m.parts;
    const message: TransformedMessage = { role, raw: rawJoined };
    if (textPieces.length > 0) {
      message.text = truncateText(textPieces.join("\n\n"), MAX_TEXT_LENGTH);
    }
    if (Number.isFinite(m.time_created) && m.time_created > 0) {
      message.ts = m.time_created;
    }
    return message;
  });
  const result: TransformedSession = {
    agent: AGENT_ID,
    machine,
    source_id: session.id,
    created_at: session.time_created,
    updated_at: session.time_updated,
    messages: transformed,
  };
  if (typeof session.title === "string" && session.title.length > 0) {
    result.title = truncateText(session.title, 2000);
  }
  if (typeof session.directory === "string" && session.directory.length > 0) {
    result.cwd = session.directory;
  }
  return result;
}

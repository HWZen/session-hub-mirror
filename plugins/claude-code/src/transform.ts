import { hostname } from "node:os";
import type { TranscriptSession } from "./transcript.js";
import { MAX_MESSAGES, MAX_TEXT_LENGTH, MAX_TITLE_LENGTH, truncateText } from "./transcript.js";

export const AGENT = "claude-code";
export const MAX_CWD_LENGTH = 2000;

export interface UpsertMessage {
  role: string;
  text?: string;
  ts?: number;
  raw?: unknown;
}

export interface SessionUpsertPayload {
  agent: string;
  machine: string;
  source_id: string;
  title?: string;
  cwd?: string;
  created_at: number;
  updated_at: number;
  messages: UpsertMessage[];
}

export function transformSession(
  transcript: TranscriptSession,
  cwdOverride?: string,
  machine: string = hostname(),
): SessionUpsertPayload {
  const messages: UpsertMessage[] = transcript.messages.slice(-MAX_MESSAGES).map((m) => {
    const out: UpsertMessage = { role: m.role };
    if (m.text !== undefined) out.text = truncateText(m.text, MAX_TEXT_LENGTH);
    if (m.ts !== undefined) out.ts = m.ts;
    if (m.raw !== undefined) out.raw = m.raw;
    return out;
  });

  const payload: SessionUpsertPayload = {
    agent: AGENT,
    machine,
    source_id: transcript.sessionId,
    created_at: transcript.createdAt,
    updated_at: transcript.updatedAt,
    messages,
  };
  if (transcript.title !== undefined && transcript.title.length > 0) {
    payload.title = truncateText(transcript.title, MAX_TITLE_LENGTH);
  }
  const cwd = cwdOverride !== undefined && cwdOverride.length > 0 ? cwdOverride : transcript.cwd;
  if (cwd.length > 0) payload.cwd = truncateText(cwd, MAX_CWD_LENGTH);
  return payload;
}

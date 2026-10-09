import type { ConversationMessage, SearchHit, SessionRecord } from "./session.js";

export interface SessionListItem extends SessionRecord {
  message_count: number;
}

export interface SessionMessagesResponse {
  messages: ConversationMessage[];
}

export interface SessionFullLengthResponse {
  full_length: number;
}

export interface SessionListResponse {
  total: number;
  limit: number;
  offset: number;
  items: SessionListItem[];
}

export interface UpsertResult {
  id: string;
  created: boolean;
  indexed: boolean;
}

export interface SearchResponse {
  model: string;
  provider: string;
  results: SearchHit[];
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  warnings: string[];
  db: { ok: boolean; journal_mode: string; size_bytes: number };
  embedding: {
    current: string | null;
    model: string;
    providers: Array<{ name: string; kind: string; model: string; ready: boolean; lastError: string | null }>;
  };
  now: number;
}

export interface StatsSummary {
  sessions: number;
  messages: number;
  indexed: number;
  unindexed: number;
  by_agent: Record<string, number>;
  by_machine: Record<string, number>;
  first_session_at: number | null;
  last_session_at: number | null;
}

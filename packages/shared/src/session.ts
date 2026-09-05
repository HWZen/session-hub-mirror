import { z } from "zod";

export const messageInputSchema = z.object({
  role: z.string().min(1).max(64),
  text: z.string().max(1_000_000).optional(),
  ts: z.number().int().nonnegative().optional(),
  raw: z.unknown().optional(),
});

export const sessionUpsertSchema = z.object({
  agent: z.string().min(1).max(64),
  machine: z.string().min(1).max(128),
  source_id: z.string().min(1).max(256),
  title: z.string().max(2000).optional(),
  cwd: z.string().max(2000).optional(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  messages: z.array(messageInputSchema).max(5000).default([]),
});

const timeValueSchema = z
  .union([z.number().int(), z.string()])
  .transform((v) => (typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v)))
  .refine((n) => Number.isFinite(n), { message: "invalid time value" });

export const sessionFilterSchema = z.object({
  agent: z.string().min(1).max(64).optional(),
  machine: z.string().min(1).max(128).optional(),
  source_id: z.string().min(1).max(256).optional(),
  created_from: timeValueSchema.optional(),
  created_to: timeValueSchema.optional(),
  updated_from: timeValueSchema.optional(),
  updated_to: timeValueSchema.optional(),
});

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(8000),
  top_k: z.number().int().min(1).max(50).optional(),
  filters: sessionFilterSchema.optional(),
});

export type MessageInput = z.infer<typeof messageInputSchema>;
export type SessionUpsertInput = z.infer<typeof sessionUpsertSchema>;
export type SessionFilters = z.infer<typeof sessionFilterSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export interface SessionRecord {
  id: string;
  agent: string;
  machine: string;
  source_id: string;
  title: string | null;
  cwd: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  indexed_at: number | null;
  indexed_model: string | null;
}

export interface MessageRecord {
  idx: number;
  role: string;
  text: string;
  ts: number | null;
  raw: unknown;
}

export interface SessionDetail extends SessionRecord {
  messages: MessageRecord[];
}

export interface SearchSnippet {
  message_idx: number;
  role: string;
  text: string;
  ts: number | null;
  distance: number;
}

export interface SearchHit {
  session: SessionRecord;
  distance: number;
  snippets: SearchSnippet[];
}

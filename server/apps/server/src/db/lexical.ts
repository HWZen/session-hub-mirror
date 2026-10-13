import type { MessageSource, SessionFilters } from "@session-hub/shared";
import { buildSessionFilter } from "./sessions.js";
import type { SqliteDatabase } from "./connection.js";

export const MAX_LEXICAL_TRIGRAMS = 128;
const LEXICAL_CANDIDATE_MULTIPLIER = 50;
const LEXICAL_CANDIDATE_MAX = 1024;

export interface LexicalRow {
  chunk_id: number;
  lexical_score: number;
  source: MessageSource;
  chunk_text: string;
  message_idx: number;
  role: string;
  ts: number | null;
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

function sampleTrigrams(trigrams: Set<string>, max: number): string[] {
  const arr = [...trigrams];
  if (arr.length <= max) return arr;
  const out: string[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]!);
  return out;
}

export function buildLexicalMatch(query: string): string | null {
  const trigrams = new Set<string>();
  for (const atom of query.trim().split(/\s+/u)) {
    const chars = [...atom];
    for (let i = 0; i + 3 <= chars.length; i++) {
      trigrams.add(chars.slice(i, i + 3).join(""));
    }
  }
  if (trigrams.size === 0) return null;
  return sampleTrigrams(trigrams, MAX_LEXICAL_TRIGRAMS)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function searchLexicalChunks(
  db: SqliteDatabase,
  matchExpr: string,
  topK: number,
  filters: SessionFilters,
): LexicalRow[] {
  const k = Math.min(Math.max(topK * LEXICAL_CANDIDATE_MULTIPLIER, topK), LEXICAL_CANDIDATE_MAX);
  const { sql: where, params } = buildSessionFilter(filters);
  return db
    .prepare(
      `SELECT message_chunks_fts.rowid AS chunk_id, bm25(message_chunks_fts) AS lexical_score,
              c.source AS source, c.text AS chunk_text,
              m.idx AS message_idx, m.role AS role, m.ts AS ts,
              s.id AS id, s.agent AS agent, s.machine AS machine, s.source_id AS source_id,
              s.title AS title, s.cwd AS cwd, s.created_at AS created_at, s.updated_at AS updated_at,
              s.deleted_at AS deleted_at, s.indexed_at AS indexed_at, s.indexed_model AS indexed_model
       FROM message_chunks_fts
       JOIN message_chunks c ON c.id = message_chunks_fts.rowid
       JOIN messages m ON m.id = c.message_id
       JOIN sessions s ON s.id = m.session_id
       ${where} AND message_chunks_fts MATCH ?
       ORDER BY lexical_score
       LIMIT ?`,
    )
    .all(...params, matchExpr, k) as unknown as LexicalRow[];
}

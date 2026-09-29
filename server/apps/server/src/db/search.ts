import type {
  MessageSource,
  SearchChannel,
  SearchHit,
  SearchSnippet,
  SessionFilters,
  SessionRecord,
} from "@session-hub/shared";
import { buildSessionFilter } from "./sessions.js";
import { chunkEmbeddingTableFor } from "./chunks.js";
import { toVectorBlob } from "./embeddings.js";
import { buildLexicalMatch, searchLexicalChunks, type LexicalRow } from "./lexical.js";
import type { SqliteDatabase } from "./connection.js";

const SNIPPET_MAX_CHARS = 500;
const MAX_SNIPPETS_PER_SESSION = 5;
const KNN_CANDIDATE_MULTIPLIER = 50;
const KNN_CANDIDATE_MAX = 1024;
const RRF_K = 60;
const DENSE_WEIGHT = 1;
const LEXICAL_WEIGHT = 1;

interface CandidateRow {
  chunk_id: number;
  distance: number | null;
  lexical_score: number | null;
  source: MessageSource;
  chunk_text: string;
  message_idx: number;
  role: string;
  ts: number | null;
  session: SessionRecord;
}

interface SessionCandidate {
  session: SessionRecord;
  rank: number;
  rows: CandidateRow[];
}

function truncate(text: string): string {
  return text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS)}…`;
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function toSession(row: {
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
}): SessionRecord {
  return {
    id: row.id,
    agent: row.agent,
    machine: row.machine,
    source_id: row.source_id,
    title: row.title,
    cwd: row.cwd,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    indexed_at: row.indexed_at,
    indexed_model: row.indexed_model,
  };
}

interface DenseRow {
  chunk_id: number;
  distance: number;
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

function searchDenseChunks(
  db: SqliteDatabase,
  model: string,
  queryVector: Float32Array,
  topK: number,
  filters: SessionFilters,
): CandidateRow[] {
  const table = chunkEmbeddingTableFor(model);
  if (!hasTable(db, table)) return [];
  const { sql: where, params } = buildSessionFilter(filters);
  const k = Math.min(Math.max(topK * KNN_CANDIDATE_MULTIPLIER, topK), KNN_CANDIDATE_MAX);
  const rows = db
    .prepare(
      `WITH knn AS (
         SELECT chunk_id, distance
         FROM ${table}
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT knn.chunk_id AS chunk_id, knn.distance AS distance,
              c.source AS source, c.text AS chunk_text,
              m.idx AS message_idx, m.role AS role, m.ts AS ts,
              s.id AS id, s.agent AS agent, s.machine AS machine, s.source_id AS source_id,
              s.title AS title, s.cwd AS cwd, s.created_at AS created_at, s.updated_at AS updated_at,
              s.deleted_at AS deleted_at, s.indexed_at AS indexed_at, s.indexed_model AS indexed_model
       FROM knn
       JOIN message_chunks c ON c.id = knn.chunk_id
       JOIN messages m ON m.id = c.message_id
       JOIN sessions s ON s.id = m.session_id
       ${where}
       ORDER BY knn.distance`,
    )
    .all(toVectorBlob(queryVector), k, ...params) as unknown as DenseRow[];
  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    distance: r.distance,
    lexical_score: null,
    source: r.source,
    chunk_text: r.chunk_text,
    message_idx: r.message_idx,
    role: r.role,
    ts: r.ts,
    session: toSession(r),
  }));
}

function aggregateBySession(rows: CandidateRow[]): SessionCandidate[] {
  const bySession = new Map<string, SessionCandidate>();
  for (const row of rows) {
    let entry = bySession.get(row.session.id);
    if (!entry) {
      entry = { session: row.session, rank: bySession.size + 1, rows: [row] };
      bySession.set(row.session.id, entry);
    } else if (entry.rows.length < MAX_SNIPPETS_PER_SESSION) {
      entry.rows.push(row);
    }
  }
  return [...bySession.values()];
}

function fusionDepth(topK: number): number {
  return Math.min(Math.max(topK * 5, 50), 200);
}

function mergeSnippets(denseRows: CandidateRow[], lexicalRows: CandidateRow[]): SearchSnippet[] {
  const byChunk = new Map<number, SearchSnippet>();
  const out: SearchSnippet[] = [];
  const push = (row: CandidateRow, channel: SearchChannel) => {
    const existing = byChunk.get(row.chunk_id);
    if (existing) {
      if (!existing.matched_by.includes(channel)) existing.matched_by.push(channel);
      return;
    }
    const snippet: SearchSnippet = {
      message_idx: row.message_idx,
      role: row.role,
      text: truncate(row.chunk_text),
      ts: row.ts,
      source: row.source,
      distance: row.distance,
      matched_by: [channel],
    };
    byChunk.set(row.chunk_id, snippet);
    if (out.length < MAX_SNIPPETS_PER_SESSION) out.push(snippet);
  };
  let i = 0;
  let j = 0;
  while (i < denseRows.length || j < lexicalRows.length) {
    if (i < denseRows.length) push(denseRows[i++]!, "dense");
    if (j < lexicalRows.length) push(lexicalRows[j++]!, "lexical");
    if (out.length >= MAX_SNIPPETS_PER_SESSION) break;
  }
  return out;
}

export function searchSessions(
  db: SqliteDatabase,
  model: string,
  query: string,
  queryVector: Float32Array,
  topK: number,
  filters: SessionFilters,
): SearchHit[] {
  const depth = fusionDepth(topK);
  const dense = aggregateBySession(searchDenseChunks(db, model, queryVector, topK, filters)).slice(0, depth);
  const matchExpr = buildLexicalMatch(query);
  const lexical = matchExpr
    ? aggregateBySession(searchLexicalChunks(db, matchExpr, topK, filters).map(toCandidateRow)).slice(0, depth)
    : [];

  interface FusedEntry {
    session: SessionRecord;
    score: number;
    bestRank: number;
    dense: SessionCandidate | null;
    lexical: SessionCandidate | null;
  }
  const fused = new Map<string, FusedEntry>();
  const put = (candidate: SessionCandidate, channel: "dense" | "lexical") => {
    let entry = fused.get(candidate.session.id);
    if (!entry) {
      entry = { session: candidate.session, score: 0, bestRank: Number.POSITIVE_INFINITY, dense: null, lexical: null };
      fused.set(candidate.session.id, entry);
    }
    entry[channel] = candidate;
    entry.score += (channel === "dense" ? DENSE_WEIGHT : LEXICAL_WEIGHT) / (RRF_K + candidate.rank);
    entry.bestRank = Math.min(entry.bestRank, candidate.rank);
  };
  dense.forEach((c) => put(c, "dense"));
  lexical.forEach((c) => put(c, "lexical"));

  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.session.id.localeCompare(b.session.id))
    .slice(0, topK)
    .map((entry) => ({
      session: entry.session,
      score: entry.score,
      distance: entry.dense ? entry.dense.rows[0]!.distance : null,
      matched_by: [...(entry.dense ? (["dense"] as const) : []), ...(entry.lexical ? (["lexical"] as const) : [])],
      snippets: mergeSnippets(entry.dense?.rows ?? [], entry.lexical?.rows ?? []),
    }));
}

function toCandidateRow(row: LexicalRow): CandidateRow {
  return {
    chunk_id: row.chunk_id,
    distance: null,
    lexical_score: row.lexical_score,
    source: row.source,
    chunk_text: row.chunk_text,
    message_idx: row.message_idx,
    role: row.role,
    ts: row.ts,
    session: toSession(row),
  };
}

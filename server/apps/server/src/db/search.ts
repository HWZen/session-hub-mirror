import type { SearchHit, SearchSnippet, SessionFilters } from "@session-hub/shared";
import { buildSessionFilter } from "./sessions.js";
import { embeddingTableFor, toVectorBlob } from "./embeddings.js";
import type { SqliteDatabase } from "./connection.js";

const SNIPPET_MAX_CHARS = 500;
const MAX_SNIPPETS_PER_SESSION = 5;

interface KnnRow {
  distance: number;
  message_idx: number;
  role: string;
  text: string;
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

function truncate(text: string): string {
  return text.length <= SNIPPET_MAX_CHARS ? text : `${text.slice(0, SNIPPET_MAX_CHARS)}…`;
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function searchSessions(
  db: SqliteDatabase,
  model: string,
  queryVector: Float32Array,
  topK: number,
  filters: SessionFilters,
): SearchHit[] {
  const table = embeddingTableFor(model);
  if (!hasTable(db, table)) return [];
  const { sql: where, params } = buildSessionFilter(filters);
  const k = Math.min(Math.max(topK * 20, topK), 512);
  const rows = db
    .prepare(
      `WITH knn AS (
         SELECT message_id, distance
         FROM ${table}
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT knn.distance AS distance, m.idx AS message_idx, m.role AS role, m.text AS text, m.ts AS ts,
              s.id AS id, s.agent AS agent, s.machine AS machine, s.source_id AS source_id,
              s.title AS title, s.cwd AS cwd, s.created_at AS created_at, s.updated_at AS updated_at,
              s.deleted_at AS deleted_at, s.indexed_at AS indexed_at, s.indexed_model AS indexed_model
       FROM knn
       JOIN messages m ON m.id = knn.message_id
       JOIN sessions s ON s.id = m.session_id
       ${where}
       ORDER BY knn.distance`,
    )
    .all(toVectorBlob(queryVector), k, ...params) as unknown as KnnRow[];

  const bySession = new Map<string, { session: KnnRow; distance: number; snippets: SearchSnippet[] }>();
  for (const row of rows) {
    let entry = bySession.get(row.id);
    if (!entry) {
      entry = { session: row, distance: row.distance, snippets: [] };
      bySession.set(row.id, entry);
    }
    if (entry.snippets.length < MAX_SNIPPETS_PER_SESSION) {
      entry.snippets.push({
        message_idx: row.message_idx,
        role: row.role,
        text: truncate(row.text),
        ts: row.ts,
        distance: row.distance,
      });
    }
  }
  return [...bySession.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK)
    .map((entry) => ({
      session: {
        id: entry.session.id,
        agent: entry.session.agent,
        machine: entry.session.machine,
        source_id: entry.session.source_id,
        title: entry.session.title,
        cwd: entry.session.cwd,
        created_at: entry.session.created_at,
        updated_at: entry.session.updated_at,
        deleted_at: entry.session.deleted_at,
        indexed_at: entry.session.indexed_at,
        indexed_model: entry.session.indexed_model,
      },
      distance: entry.distance,
      snippets: entry.snippets,
    }));
}

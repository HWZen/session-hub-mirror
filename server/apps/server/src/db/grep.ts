import type { GrepHit, SessionFilters } from "@session-hub/shared";
import { buildSessionFilter, escapeLike } from "./sessions.js";
import type { SqliteDatabase } from "./connection.js";

const SNIPPET_MAX_CHARS = 500;
const SNIPPET_CONTEXT_BEFORE = 120;
const MAX_SNIPPETS_PER_SESSION = 5;

interface GrepRow {
  message_idx: number;
  role: string;
  text: string;
  ts: number | null;
  match_at: number;
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

function buildSnippet(text: string, matchStart: number): { snippet: string; match_start: number } {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return { snippet: text, match_start: matchStart };
  }
  const start = Math.max(0, Math.min(matchStart - SNIPPET_CONTEXT_BEFORE, text.length - SNIPPET_MAX_CHARS));
  return { snippet: text.slice(start, start + SNIPPET_MAX_CHARS), match_start: matchStart - start };
}

export function grepMessages(
  db: SqliteDatabase,
  q: string,
  caseSensitive: boolean,
  filters: SessionFilters,
  options: { limit: number; offset: number },
): { total: number; items: GrepHit[] } {
  const { sql: where, params } = buildSessionFilter(filters);
  const textCond = caseSensitive ? "instr(m.text, ?) > 0" : "m.text LIKE '%' || ? || '%' ESCAPE '\\'";
  const matchExpr = caseSensitive ? "instr(m.text, ?)" : "instr(lower(m.text), lower(?))";
  const textParam = caseSensitive ? q : escapeLike(q);
  const countParams = [...params, textParam];

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         ${where} AND ${textCond}`,
      )
      .get(...countParams) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT m.idx AS message_idx, m.role AS role, m.text AS text, m.ts AS ts, ${matchExpr} AS match_at,
              s.id AS id, s.agent AS agent, s.machine AS machine, s.source_id AS source_id,
              s.title AS title, s.cwd AS cwd, s.created_at AS created_at, s.updated_at AS updated_at,
              s.deleted_at AS deleted_at, s.indexed_at AS indexed_at, s.indexed_model AS indexed_model
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       ${where} AND ${textCond}
       ORDER BY s.updated_at DESC, s.id, m.idx
       LIMIT ? OFFSET ?`,
    )
    .all(q, ...countParams, options.limit, options.offset) as unknown as GrepRow[];

  const bySession = new Map<string, GrepHit>();
  for (const row of rows) {
    let hit = bySession.get(row.id);
    if (!hit) {
      hit = {
        session: {
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
        },
        hits: [],
      };
      bySession.set(row.id, hit);
    }
    if (hit.hits.length >= MAX_SNIPPETS_PER_SESSION) continue;
    const { snippet, match_start } = buildSnippet(row.text, Math.max(row.match_at, 1) - 1);
    hit.hits.push({ message_idx: row.message_idx, role: row.role, ts: row.ts, snippet, match_start });
  }
  return { total, items: [...bySession.values()] };
}

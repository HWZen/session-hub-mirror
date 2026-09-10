import { randomUUID } from "node:crypto";
import type {
  MessageRecord,
  SessionDetail,
  SessionFilters,
  SessionRecord,
  SessionUpsertInput,
  StatsSummary,
} from "@session-hub/shared";
import { clearSessionEmbeddings } from "./embeddings.js";
import type { SqliteDatabase } from "./connection.js";

export interface SessionListItem extends SessionRecord {
  message_count: number;
}

export interface ListOptions {
  limit: number;
  offset: number;
}

export interface FilterClause {
  sql: string;
  params: Array<string | number>;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildSessionFilter(filters: SessionFilters): FilterClause {
  const conds: string[] = ["deleted_at IS NULL"];
  const params: Array<string | number> = [];
  if (filters.agent !== undefined) {
    conds.push("agent = ?");
    params.push(filters.agent);
  }
  if (filters.machine !== undefined) {
    conds.push("machine = ?");
    params.push(filters.machine);
  }
  if (filters.source_id !== undefined) {
    conds.push("source_id = ?");
    params.push(filters.source_id);
  }
  if (filters.title !== undefined) {
    conds.push("title LIKE '%' || ? || '%' ESCAPE '\\'");
    params.push(escapeLike(filters.title));
  }
  if (filters.created_from !== undefined) {
    conds.push("created_at >= ?");
    params.push(filters.created_from);
  }
  if (filters.created_to !== undefined) {
    conds.push("created_at <= ?");
    params.push(filters.created_to);
  }
  if (filters.updated_from !== undefined) {
    conds.push("updated_at >= ?");
    params.push(filters.updated_from);
  }
  if (filters.updated_to !== undefined) {
    conds.push("updated_at <= ?");
    params.push(filters.updated_to);
  }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

const SESSION_COLUMNS = "id, agent, machine, source_id, title, cwd, created_at, updated_at, deleted_at, indexed_at, indexed_model";

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    agent: row.agent as string,
    machine: row.machine as string,
    source_id: row.source_id as string,
    title: (row.title as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    deleted_at: (row.deleted_at as number | null) ?? null,
    indexed_at: (row.indexed_at as number | null) ?? null,
    indexed_model: (row.indexed_model as string | null) ?? null,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type MessageRow = { idx: number; role: string; text: string; ts: number | null; raw: string | null };

function mapMessageRows(rows: MessageRow[]): MessageRecord[] {
  return rows.map((m) => ({
    idx: m.idx,
    role: m.role,
    text: m.text,
    ts: m.ts ?? null,
    raw: m.raw === null ? null : safeParseJson(m.raw),
  }));
}

export class SessionRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  upsert(input: SessionUpsertInput): { id: string; created: boolean } {
    const { agent, machine, source_id, title, cwd, created_at, updated_at, messages } = input;
    const run = this.#db.transaction((): { id: string; created: boolean } => {
      const existing = this.#db
        .prepare("SELECT id FROM sessions WHERE agent = ? AND machine = ? AND source_id = ?")
        .get(agent, machine, source_id) as { id: string } | undefined;
      let id: string;
      let created: boolean;
      if (existing) {
        id = existing.id;
        created = false;
        this.#db
          .prepare(
            "UPDATE sessions SET title = ?, cwd = ?, created_at = ?, updated_at = ?, deleted_at = NULL, indexed_at = NULL, indexed_model = NULL WHERE id = ?",
          )
          .run(title ?? null, cwd ?? null, created_at, updated_at, id);
      } else {
        created = true;
        id = randomUUID();
        this.#db
          .prepare(
            "INSERT INTO sessions (id, agent, machine, source_id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(id, agent, machine, source_id, title ?? null, cwd ?? null, created_at, updated_at);
      }
      clearSessionEmbeddings(this.#db, id);
      this.#db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      const insertMessage = this.#db.prepare(
        "INSERT INTO messages (session_id, idx, role, text, ts, raw) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx]!;
        insertMessage.run(id, idx, m.role, m.text ?? "", m.ts ?? null, m.raw === undefined ? null : JSON.stringify(m.raw));
      }
      return { id, created };
    });
    return run();
  }

  list(filters: SessionFilters, options: ListOptions): { total: number; items: SessionListItem[] } {
    const { sql: where, params } = buildSessionFilter(filters);
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`).get(...params) as { n: number }).n;
    const rows = this.#db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ${where}
         ORDER BY s.updated_at DESC, s.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset) as Array<Record<string, unknown>>;
    return {
      total,
      items: rows.map((row) => ({ ...mapSessionRow(row), message_count: row.message_count as number })),
    };
  }

  get(id: string): SessionDetail | null {
    const row = this.#db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const record = mapSessionRow(row);
    if (record.deleted_at !== null) return null;
    const messages = mapMessageRows(
      this.#db
        .prepare("SELECT idx, role, text, ts, raw FROM messages WHERE session_id = ? ORDER BY idx")
        .all(id) as MessageRow[],
    );
    return { ...record, messages };
  }

  getMessages(id: string): MessageRecord[] | null {
    const row = this.#db.prepare("SELECT deleted_at FROM sessions WHERE id = ?").get(id) as
      | { deleted_at: number | null }
      | undefined;
    if (!row || row.deleted_at !== null) return null;
    return mapMessageRows(
      this.#db
        .prepare("SELECT idx, role, text, ts, raw FROM messages WHERE session_id = ? ORDER BY idx")
        .all(id) as MessageRow[],
    );
  }

  delete(id: string): boolean {
    const result = this.#db
      .prepare("UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(Date.now(), id);
    return result.changes > 0;
  }

  setIndexed(id: string, model: string, at: number = Date.now()): void {
    this.#db.prepare("UPDATE sessions SET indexed_at = ?, indexed_model = ? WHERE id = ?").run(at, model, id);
  }

  listUnindexed(limit: number, activeModel: string | null): SessionRecord[] {
    const where =
      activeModel === null
        ? "deleted_at IS NULL"
        : "deleted_at IS NULL AND (indexed_at IS NULL OR indexed_model != ?)";
    const rows = this.#db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${where} ORDER BY created_at LIMIT ?`)
      .all(...(activeModel === null ? [] : [activeModel]), limit) as Array<Record<string, unknown>>;
    return rows.map(mapSessionRow);
  }

  messageTexts(sessionId: string): Array<{ id: number; idx: number; text: string }> {
    return this.#db
      .prepare("SELECT id, idx, text FROM messages WHERE session_id = ? AND text <> '' ORDER BY idx")
      .all(sessionId) as Array<{ id: number; idx: number; text: string }>;
  }

  stats(activeModel: string | null): StatsSummary {
    const indexedCond = activeModel === null ? "0" : "(indexed_model = ?)";
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(CASE WHEN ${indexedCond} THEN 1 ELSE 0 END), 0) AS indexed,
                MIN(created_at) AS first_at,
                MAX(updated_at) AS last_at
         FROM sessions WHERE deleted_at IS NULL`,
      )
      .get(...(activeModel === null ? [] : [activeModel])) as {
      sessions: number;
      indexed: number;
      first_at: number | null;
      last_at: number | null;
    };
    const messages = this.#db
      .prepare("SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.deleted_at IS NULL")
      .get() as { n: number };
    const countBy = (column: "agent" | "machine"): Record<string, number> => {
      const rows = this.#db
        .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL GROUP BY ${column}`)
        .all() as Array<{ k: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.k, r.n]));
    };
    return {
      sessions: row.sessions,
      messages: messages.n,
      indexed: row.indexed,
      unindexed: row.sessions - row.indexed,
      by_agent: countBy("agent"),
      by_machine: countBy("machine"),
      first_session_at: row.first_at,
      last_session_at: row.last_at,
    };
  }
}

import Database from "better-sqlite3";
import { join } from "node:path";
import {
  type ZcodeMessageRow,
  type ZcodeSessionRow,
  asRecord,
} from "./transform.js";

export interface ZcodeSessionEntry {
  session: ZcodeSessionRow;
  messages: ZcodeMessageRow[];
}

export function defaultZcodeDbPath(): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  return home.length > 0 ? join(home, ".zcode", "cli", "db", "db.sqlite") : join(".zcode", "cli", "db", "db.sqlite");
}

export function openZcodeDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 3000");
  return db;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RawMessageRow {
  id: string;
  time_created: number;
  sequence: number | null;
  data: string | null;
}

interface RawPartRow {
  message_id: string;
  sequence: number | null;
  data: string | null;
}

interface RawSessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
  parent_id: string | null;
}

export function readZcodeSession(db: Database.Database, sessionId: string): ZcodeSessionEntry | null {
  const sessionRow = db
    .prepare(
      "SELECT id, title, directory, time_created, time_updated, parent_id FROM session WHERE id = ?",
    )
    .get(sessionId) as RawSessionRow | undefined;
  if (!sessionRow) return null;

  const messageRows = db
    .prepare(
      "SELECT id, time_created, sequence, data FROM message WHERE session_id = ? ORDER BY time_created, sequence, rowid",
    )
    .all(sessionId) as RawMessageRow[];

  const partRows = db
    .prepare(
      "SELECT message_id, data, sequence FROM part WHERE session_id = ? ORDER BY time_created, sequence, rowid",
    )
    .all(sessionId) as RawPartRow[];
  const partsByMessage = new Map<string, unknown[]>();
  for (const row of partRows) {
    const data = parseJson(row.data);
    if (data === null) continue;
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(data);
    partsByMessage.set(row.message_id, list);
  }

  const messages: ZcodeMessageRow[] = messageRows.map((row) => ({
    id: row.id,
    time_created: typeof row.time_created === "number" ? row.time_created : 0,
    sequence: row.sequence ?? null,
    data: parseJson(row.data),
    parts: partsByMessage.get(row.id) ?? [],
  }));

  return {
    session: {
      id: sessionRow.id,
      title: sessionRow.title,
      directory: sessionRow.directory,
      time_created: sessionRow.time_created,
      time_updated: sessionRow.time_updated,
    },
    messages,
  };
}

export function listTopLevelSessionIds(db: Database.Database): Array<{ id: string; time_updated: number }> {
  const rows = db
    .prepare("SELECT id, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated")
    .all() as Array<{ id: string; time_updated: number }>;
  return rows;
}

export function messageRole(data: unknown): string | null {
  const record = asRecord(data);
  const role = record?.["role"];
  return typeof role === "string" ? role : null;
}

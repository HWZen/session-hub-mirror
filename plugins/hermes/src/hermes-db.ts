import Database from "better-sqlite3";
import type { HermesMessageRow, HermesSessionRow } from "./transform.js";

export interface HermesSessionEntry {
  session: HermesSessionRow;
  messages: HermesMessageRow[];
}

export function defaultProfilesRoot(env: Record<string, string | undefined> = process.env): string {
  const localAppData = env["LOCALAPPDATA"];
  if (localAppData) return `${localAppData.replace(/[\\/]+$/, "")}/hermes/profiles`;
  const home = env["USERPROFILE"] ?? env["HOME"] ?? "";
  return home ? `${home.replace(/[\\/]+$/, "")}/AppData/Local/hermes/profiles` : "AppData/Local/hermes/profiles";
}

export function defaultProfileHomes(profilesRoot: string = defaultProfilesRoot()): string[] {
  return ["default", "dev", "qa", "operations"].map((name) => `${profilesRoot}/${name}`);
}

export function hermesDbPath(profileHome: string): string {
  return `${profileHome.replace(/[\\/]+$/, "")}/state.db`;
}

export function openHermesDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 3000");
  return db;
}

export function readHermesSession(db: Database.Database, sessionId: string): HermesSessionEntry | null {
  const session = db
    .prepare(
      "SELECT id, title, cwd, git_repo_root, started_at, last_activity_at FROM sessions WHERE id = ?",
    )
    .get(sessionId) as HermesSessionRow | undefined;
  if (!session) return null;
  const messages = db
    .prepare(
      "SELECT id, session_id, role, content, tool_call_id, tool_name, tool_calls FROM messages WHERE session_id = ? ORDER BY rowid",
    )
    .all(sessionId) as HermesMessageRow[];
  return { session, messages };
}

export function listUnarchivedSessionIds(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE archived = 0 ORDER BY started_at, rowid")
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

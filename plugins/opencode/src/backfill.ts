import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import {
  type SessionHubConfig,
  type PluginSourceMessage,
  type PluginSourceSession,
  loadConfig,
  transformSession,
  uploadSession,
} from "./plugin.js";

export interface BackfillOptions {
  url: string;
  token: string;
  db: string;
  since?: number;
  dryRun: boolean;
}

export interface BackfillCounters {
  sessions: number;
  uploaded: number;
  failed: number;
  skipped_since: number;
}

export interface BackfillEntry {
  session: PluginSourceSession;
  messages: PluginSourceMessage[];
}

interface RawSessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
}

interface RawMessageRow {
  id: number;
  session_id: string;
  data: string | null;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readSessionsFromDb(
  db: Database.Database,
  since?: number,
): BackfillEntry[] {
  const sessionRows = db.prepare("SELECT id, title, directory, time_created, time_updated FROM session").all() as RawSessionRow[];
  const messageRows = db
    .prepare("SELECT id, session_id, data FROM message")
    .all() as RawMessageRow[];
  const partRows = db
    .prepare("SELECT message_id, data FROM part ORDER BY message_id, id")
    .all() as Array<{ message_id: number; data: string | null }>;
  const partsByMessage = new Map<number, unknown[]>();
  for (const row of partRows) {
    const data = parseJson(row.data);
    if (data === null) continue;
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(data);
    partsByMessage.set(row.message_id, list);
  }
  interface MessageEntry {
    message: PluginSourceMessage;
    created: number;
    sortId: number;
  }
  const messagesBySession = new Map<string, MessageEntry[]>();
  for (const row of messageRows) {
    const data = parseJson(row.data);
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
    if (!record) continue;
    const role = typeof record["role"] === "string" ? record["role"] : null;
    if (!role) continue;
    const time = typeof record["time"] === "object" && record["time"] !== null ? (record["time"] as Record<string, unknown>) : null;
    let created = 0;
    let timeCreated: number | null = null;
    if (time && typeof time["created"] === "number" && Number.isFinite(time["created"])) {
      created = time["created"];
      timeCreated = created;
    }
    const parts = partsByMessage.get(row.id) ?? [];
    const list = messagesBySession.get(row.session_id) ?? [];
    list.push({ message: { role, time_created: timeCreated, parts }, created, sortId: row.id });
    messagesBySession.set(row.session_id, list);
  }
  const result: BackfillEntry[] = [];
  for (const row of sessionRows) {
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (since !== undefined) {
      const lastUpdated = typeof row.time_updated === "number" ? row.time_updated : 0;
      if (lastUpdated < since) continue;
    }
    const messageList = messagesBySession.get(row.id) ?? [];
    messageList.sort((a, b) => a.created - b.created || a.sortId - b.sortId);
    result.push({
      session: {
        id: row.id,
        title: row.title,
        directory: row.directory,
        time_created: typeof row.time_created === "number" ? row.time_created : 0,
        time_updated: typeof row.time_updated === "number" ? row.time_updated : 0,
      },
      messages: messageList.map((m) => m.message),
    });
  }
  return result;
}

export function defaultDbPath(): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  return home.length > 0 ? `${home.replace(/[\\/]+$/, "")}/.local/share/opencode/opencode.db` : "opencode.db";
}

export function parseArgs(argv: string[]): BackfillOptions | null {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--") || arg.length <= 2) continue;
    const bare = arg.slice(2);
    const eq = bare.indexOf("=");
    if (eq !== -1) {
      args[bare.slice(0, eq)] = bare.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[bare] = next;
        i++;
      } else {
        args[bare] = "";
      }
    }
  }
  const url = args["url"];
  const token = args["token"];
  if (!url || !token) return null;
  let since: number | undefined;
  if (args["since"] !== undefined) {
    const n = Number(args["since"]);
    if (!Number.isFinite(n) || n < 0) return null;
    since = n;
  }
  const options: BackfillOptions = {    url,
    token,
    db: args["db"] ?? defaultDbPath(),
    ...(since === undefined ? {} : { since }),
    dryRun: args["dry-run"] !== undefined,
  };
  return options;
}

export interface BackfillHooks {
  upload?: (payload: unknown) => Promise<{ ok: boolean; status: number }>;
}

export async function runBackfill(
  options: BackfillOptions,
  hooks: BackfillHooks = {},
): Promise<BackfillCounters> {
  const counters: BackfillCounters = { sessions: 0, uploaded: 0, failed: 0, skipped_since: 0 };
  const config: SessionHubConfig = { baseUrl: options.url, token: options.token, timeoutMs: 120_000 };
  const db = new Database(options.db, { readonly: true });
  try {
    const entries = readSessionsFromDb(db);
    counters.sessions = entries.length;
    for (const { session, messages } of entries) {
      if (options.since !== undefined) {
        if (session.time_updated < options.since) {
          counters.skipped_since++;
          continue;
        }
      }
      if (options.dryRun) continue;
      const payload = transformSession(session, messages, hostname());
      let outcome: { ok: boolean; status: number };
      try {
        if (hooks.upload) {
          outcome = await hooks.upload(payload);
        } else {
          const result = await uploadSession(config, payload);
          outcome = { ok: result.ok, status: result.status };
        }
      } catch {
        counters.failed++;
        continue;
      }
      if (outcome.ok) {
        counters.uploaded++;
      } else {
        counters.failed++;
      }
    }
  } finally {
    db.close();
  }
  return counters;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    runBackfill(options)
      .then((counters) => {
        console.log(JSON.stringify(counters));
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
  } else {
    console.error(
      `usage: backfill --url <baseUrl> --token <token> [--db <path>] [--since <ms>] [--dry-run]${loadConfig() ? " (or omit --url/--token to use ~/.config/session-hub/config.json)" : ""}`,
    );
    process.exitCode = 1;
  }
}

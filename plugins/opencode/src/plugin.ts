import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const AGENT_ID = "opencode";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEBOUNCE_MS = 3_000;
const CONFIG_DIR = join(homedir(), ".config", "session-hub");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface SessionHubConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export interface PluginSourceSession {
  id: string;
  title?: string | null;
  directory?: string | null;
  time_created: number;
  time_updated: number;
}

export interface PluginSourceMessage {
  role: string;
  time_created?: number | null;
  parts: unknown[];
}

export interface TransformedMessage {
  role: string;
  text?: string;
  ts?: number;
  raw: unknown;
}

export interface TransformedSession {
  agent: string;
  machine: string;
  source_id: string;
  title?: string;
  cwd?: string;
  created_at: number;
  updated_at: number;
  messages: TransformedMessage[];
}

const MAX_TEXT_LENGTH = 1_000_000;
const MAX_MESSAGES = 5000;
const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}

export function transformSession(
  session: PluginSourceSession,
  messages: PluginSourceMessage[],
  machine: string = hostname(),
): TransformedSession {
  let selected = messages.filter(
    (m) => typeof m?.role === "string" && m.role.length >= 1 && m.role.length <= 64,
  );
  if (selected.length > MAX_MESSAGES) {
    selected = selected.slice(-MAX_MESSAGES);
  }
  const transformed: TransformedMessage[] = selected.map((m) => {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const textPieces: string[] = [];
    for (const part of parts) {
      const p = asRecord(part);
      if (!p) continue;
      if (p.type !== "text" || typeof p.text !== "string") continue;
      if (p.synthetic === true) continue;
      textPieces.push(p.text);
    }
    const rawJoined = parts.length === 1 ? (parts[0] ?? null) : parts;
    const message: TransformedMessage = { role: m.role, raw: rawJoined };
    if (textPieces.length > 0) {
      message.text = truncateText(textPieces.join("\n\n"), MAX_TEXT_LENGTH);
    }
    if (typeof m.time_created === "number" && Number.isFinite(m.time_created)) {
      message.ts = m.time_created;
    }
    return message;
  });
  const result: TransformedSession = {
    agent: AGENT_ID,
    machine,
    source_id: session.id,
    created_at: session.time_created,
    updated_at: session.time_updated,
    messages: transformed,
  };
  if (typeof session.title === "string" && session.title.length > 0) {
    result.title = truncateText(session.title, 2000);
  }
  if (typeof session.directory === "string" && session.directory.length > 0) {
    result.cwd = session.directory;
  }
  return result;
}

async function request(config: SessionHubConfig, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL(path, config.baseUrl).toString();
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface UploadResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function uploadSession(config: SessionHubConfig, payload: TransformedSession): Promise<UploadResult> {
  const res = await request(config, "/v1/sessions", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.status === 200 || res.status === 201, status: res.status, body };
}

export interface SessionListItem {
  id: string;
  agent: string;
  machine: string;
  source_id: string;
}

export async function listSessions(
  config: SessionHubConfig,
  filters: { agent: string; machine: string; source_id: string },
): Promise<SessionListItem[]> {
  const qs = new URLSearchParams({
    agent: filters.agent,
    machine: filters.machine,
    source_id: filters.source_id,
    limit: "10",
  });
  const res = await request(config, `/v1/sessions?${qs.toString()}`, { method: "GET" });
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const body = (await res.json()) as { total?: number; items?: SessionListItem[] };
  return Array.isArray(body.items) ? body.items : [];
}

export async function deleteSession(config: SessionHubConfig, id: string): Promise<boolean> {
  const res = await request(config, `/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.ok;
}

export interface DeleteMirrorResult {
  found: number;
  deleted: number;
}

export async function mirrorDelete(
  config: SessionHubConfig,
  machine: string,
  sourceId: string,
): Promise<DeleteMirrorResult> {
  const items = await listSessions(config, { agent: AGENT_ID, machine, source_id: sourceId });
  let deleted = 0;
  for (const item of items) {
    if (await deleteSession(config, item.id)) deleted++;
  }
  return { found: items.length, deleted };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SessionHubConfig | null {
  let baseUrl = env["SESSION_HUB_URL"];
  let token = env["SESSION_HUB_TOKEN"];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (baseUrl === undefined || token === undefined) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      if (baseUrl === undefined && typeof file["baseUrl"] === "string") baseUrl = file["baseUrl"];
      if (token === undefined && typeof file["token"] === "string") token = file["token"];
      if (typeof file["timeoutMs"] === "number" && (file["timeoutMs"] as number) > 0) {
        timeoutMs = file["timeoutMs"] as number;
      }
    } catch {
      // config file unreadable; env may still provide values
    }
  }
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  let normalized: string;
  try {
    normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
  return { baseUrl: normalized, token, timeoutMs };
}

export interface SessionHubClient {
  session: {
    get(input: { path: { id: string }; query?: { directory?: string } }): PromiseLike<{ data: unknown }>;
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): PromiseLike<{ data: unknown }>;
  };
  app: {
    log(input: { body: { service: string; level: string; message: string } }): PromiseLike<unknown>;
  };
}

interface SdkSession {
  id?: string;
  title?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
}

export function extractSessionInfo(value: unknown): PluginSourceSession | null {
  const s = asRecord(value) as SdkSession | null;
  if (!s || typeof s.id !== "string" || s.id.length === 0) return null;
  const time_created = s.time?.created;
  const time_updated = s.time?.updated;
  if (typeof time_created !== "number" || typeof time_updated !== "number") return null;
  return {
    id: s.id,
    title: typeof s.title === "string" ? s.title : null,
    directory: typeof s.directory === "string" ? s.directory : null,
    time_created,
    time_updated,
  };
}

export function extractMessages(value: unknown): PluginSourceMessage[] | null {
  if (!Array.isArray(value)) return null;
  const list: PluginSourceMessage[] = [];
  for (const entry of value) {
    const e = asRecord(entry);
    if (!e) continue;
    const info = asRecord(e["info"]);
    if (!info) continue;
    const role = info["role"];
    if (typeof role !== "string") continue;
    const time = asRecord(info["time"]);
    const timeCreated =
      time && typeof time["created"] === "number" && Number.isFinite(time["created"])
        ? (time["created"] as number)
        : null;
    const parts = Array.isArray(e["parts"]) ? e["parts"] : [];
    list.push({ role, time_created: timeCreated, parts });
  }
  return list;
}

export type SyncEvent = { type: "session.idle"; source_id: string } | { type: "session.deleted"; source_id: string };

export function classifyEvent(event: { type?: unknown; properties?: unknown }): SyncEvent | null {
  if (typeof event?.properties !== "object" || event.properties === null) return null;
  const props = event.properties as Record<string, unknown>;
  if (event.type === "session.idle" && typeof props["sessionID"] === "string") {
    return { type: "session.idle", source_id: props["sessionID"] };
  }
  if (event.type === "session.deleted") {
    const info = asRecord(props["info"]);
    if (info && typeof info["id"] === "string") {
      return { type: "session.deleted", source_id: info["id"] };
    }
  }
  return null;
}

export const sessionHubPlugin: Plugin = async (input: PluginInput) => {
  const { client } = input;
  const api = client as unknown as SessionHubClient;
  const config = loadConfig();
  const log = (level: "info" | "error" | "warn", message: string) => {
    if (api?.app?.log) {
      return Promise.resolve(api.app.log({ body: { service: "session-hub", level, message } })).catch(
        () => undefined,
      );
    }
    return Promise.resolve();
  };
  if (!config) {
    await log(
      "warn",
      "session-hub: not configured (~/.config/session-hub/config.json or SESSION_HUB_URL/SESSION_HUB_TOKEN), plugin disabled",
    );
    return {};
  }
  const machine = hostname();
  await log("info", `session-hub: enabled baseUrl=${config.baseUrl} machine=${machine}`);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const syncSession = (sourceId: string) => {
    void (async () => {
      try {
        const got = await api.session.get({ path: { id: sourceId } });
        const info = extractSessionInfo(got.data);
        if (!info) throw new Error("session info unavailable");
        const msgs = await api.session.messages({ path: { id: sourceId } });
        const messages = extractMessages(msgs.data);
        if (messages === null) throw new Error("messages unavailable");
        const payload = transformSession(info, messages, machine);
        const result = await uploadSession(config, payload);
        await log(
          result.ok ? "info" : "error",
          `session-hub: sync session=${sourceId} status=${result.status} messages=${payload.messages.length}`,
        );
      } catch (err) {
        await log(
          "error",
          `session-hub: sync failed session=${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  return {
    event: async ({ event }) => {
      const classified = classifyEvent(event);
      if (!classified) return;
      if (classified.type === "session.idle") {
        const sourceId = classified.source_id;
        const existing = pending.get(sourceId);
        if (existing !== undefined) clearTimeout(existing);
        pending.set(
          sourceId,
          setTimeout(() => {
            pending.delete(sourceId);
            syncSession(sourceId);
          }, DEBOUNCE_MS),
        );
      } else {
        const sourceId = classified.source_id;
        void mirrorDelete(config, machine, sourceId)
          .then((r) =>
            void log(
              "info",
              `session-hub: delete mirror source_id=${sourceId} found=${r.found} deleted=${r.deleted}`,
            ),
          )
          .catch((err) =>
            void log(
              "error",
              `session-hub: delete mirror failed source_id=${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    },
    dispose: async () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
};

export default sessionHubPlugin;

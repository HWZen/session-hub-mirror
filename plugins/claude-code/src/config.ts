import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUpsertPayload } from "./transform.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const CONFIG_DIR = join(homedir(), ".config", "session-hub");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface SessionHubConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  configPath: string = CONFIG_PATH,
): SessionHubConfig | null {
  let fileConfig: Record<string, unknown> = {};
  try {
    fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    // config file unreadable; env vars may still provide values
  }

  let baseUrl = env["SESSION_HUB_URL"];
  if (baseUrl === undefined && typeof fileConfig["baseUrl"] === "string") baseUrl = fileConfig["baseUrl"];
  let token = env["SESSION_HUB_TOKEN"];
  if (token === undefined && typeof fileConfig["token"] === "string") token = fileConfig["token"];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof fileConfig["timeoutMs"] === "number" && fileConfig["timeoutMs"] > 0) {
    timeoutMs = fileConfig["timeoutMs"];
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

export async function uploadSession(
  config: SessionHubConfig,
  payload: SessionUpsertPayload,
): Promise<UploadResult> {
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

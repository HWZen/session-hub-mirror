import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransformedSession } from "./transform.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SessionHubConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export interface UploadResult {
  ok: boolean;
  status: number;
}

export function defaultSkillConfigPath(env: Record<string, string | undefined> = process.env): string {
  const localAppData = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  return join(
    localAppData,
    "hermes",
    "profiles",
    "default",
    "skills",
    "personal",
    "session-hub",
    "config.json",
  );
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  configPath: string = defaultSkillConfigPath(env),
): SessionHubConfig | null {
  let baseUrl = env["SH_BASE_URL"];
  let token = env["SH_TOKEN"];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (baseUrl === undefined || token === undefined) {
    try {
      const file = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (baseUrl === undefined) {
        const value = file["base_url"] ?? file["baseUrl"];
        if (typeof value === "string") baseUrl = value;
      }
      if (token === undefined && typeof file["token"] === "string") token = file["token"];
      if (typeof file["timeout_ms"] === "number" && file["timeout_ms"] > 0) timeoutMs = file["timeout_ms"];
    } catch {
      return null;
    }
  }
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  let normalized: string;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    normalized = parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
  return { baseUrl: normalized, token, timeoutMs };
}

export async function uploadSession(
  config: SessionHubConfig,
  payload: TransformedSession,
): Promise<UploadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(new URL("/v1/sessions", config.baseUrl), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: response.status === 200 || response.status === 201, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

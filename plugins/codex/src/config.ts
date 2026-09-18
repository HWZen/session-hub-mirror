import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
export const CONFIG_PATH = join(homedir(), ".config", "session-hub", "config.json");

export interface SessionHubConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  configPath: string = CONFIG_PATH,
): SessionHubConfig | null {
  let baseUrl = env["SESSION_HUB_URL"];
  let token = env["SESSION_HUB_TOKEN"];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (baseUrl === undefined || token === undefined) {
    try {
      const file = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (baseUrl === undefined && typeof file["baseUrl"] === "string") baseUrl = file["baseUrl"];
      if (token === undefined && typeof file["token"] === "string") token = file["token"];
      if (typeof file["timeoutMs"] === "number" && file["timeoutMs"] > 0) {
        timeoutMs = file["timeoutMs"];
      }
    } catch {}
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

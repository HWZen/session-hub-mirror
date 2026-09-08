import type { SessionHubConfig } from "./config.js";
import type { SessionUpsertInput } from "@session-hub/shared";

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
  payload: SessionUpsertInput,
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

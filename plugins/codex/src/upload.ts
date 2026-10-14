import type { SessionHubConfig } from "./config.js";
import type { TransformedSession } from "./transform.js";

export interface UploadResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function uploadSession(
  config: SessionHubConfig,
  payload: TransformedSession,
): Promise<UploadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(new URL("/v1/sessions", config.baseUrl), {
      method: "PUT",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {}
    return { ok: response.status === 200 || response.status === 201, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

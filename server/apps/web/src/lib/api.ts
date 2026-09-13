import { loadConnection } from "@/lib/settings";
import type {
  GrepHit,
  GrepResponse,
  HealthStatus,
  ProviderSettingsItem,
  ProviderTestResult,
  ProvidersSettingsResponse,
  ReindexResult,
  SearchHit,
  SearchResponse,
  SessionDetail,
  SessionFilters,
  SessionListItem,
  SessionListResponse,
  StatsSummary,
  UpsertResult,
} from "@session-hub/shared";

export type { GrepHit, GrepResponse, SearchHit, SearchResponse, SessionDetail, SessionListItem, SessionListResponse };
export type HealthResponse = HealthStatus;
export type StatsResponse = StatsSummary;
export type UpsertResponse = UpsertResult;
export type ProviderSettings = ProvidersSettingsResponse;
export type ProviderItem = ProviderSettingsItem;
export type ProviderTestResponse = ProviderTestResult;
export type ReindexResponse = ReindexResult;

export interface ProviderSettingsInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  weight: number;
  enabled: boolean;
  timeoutMs: number;
}

export interface SessionSearchBody {
  query: string;
  top_k?: number;
  filters?: SessionFilters;
}

export interface SessionListParams {
  agent?: string | undefined;
  machine?: string | undefined;
  source_id?: string | undefined;
  title?: string | undefined;
  created_from?: number | undefined;
  created_to?: number | undefined;
  updated_from?: number | undefined;
  updated_to?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface GrepParams {
  q: string;
  case_sensitive?: boolean | undefined;
  agent?: string | undefined;
  machine?: string | undefined;
  source_id?: string | undefined;
  title?: string | undefined;
  created_from?: number | undefined;
  created_to?: number | undefined;
  updated_from?: number | undefined;
  updated_to?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = loadConnection();
  const base = normalizeBaseUrl(loadConnection().baseUrl);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    throw new ApiError(0, `请求 ${base}${path} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body.error) message = body.detail ? `${body.error}: ${body.detail}` : body.error;
    } catch {
      // non-json error body
    }
    throw new ApiError(res.status, message);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new ApiError(
      res.status,
      `服务地址 ${base || "（同源）"} 返回了非 JSON 响应（${contentType || "未知类型"}），请确认地址包含端口且指向 Session Hub 服务，例如 http://127.0.0.1:7428`,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  listSessions(params: SessionListParams = {}): Promise<SessionListResponse> {
    return request(`/v1/sessions${buildQuery(params)}`);
  },
  getSession(id: string): Promise<SessionDetail> {
    return request(`/v1/sessions/${encodeURIComponent(id)}/full`);
  },
  deleteSession(id: string): Promise<{ ok: boolean }> {
    return request(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  search(body: SessionSearchBody): Promise<SearchResponse> {
    return request("/v1/search", { method: "POST", body: JSON.stringify(body) });
  },
  grep(params: GrepParams): Promise<GrepResponse> {
    return request(`/v1/grep${buildQuery(params)}`);
  },
  health(): Promise<HealthResponse> {
    return request("/health");
  },
  stats(): Promise<StatsResponse> {
    return request("/v1/stats");
  },
  getProviderSettings(): Promise<ProviderSettings> {
    return request("/v1/settings/providers");
  },
  putProviderSettings(providers: ProviderSettingsInput[]): Promise<{ ok: boolean; count: number }> {
    return request("/v1/settings/providers", { method: "PUT", body: JSON.stringify({ providers }) });
  },
  testProvider(name: string): Promise<ProviderTestResponse> {
    return request("/v1/settings/providers/test", { method: "POST", body: JSON.stringify({ name }) });
  },
  reindex(): Promise<ReindexResponse> {
    return request("/v1/settings/reindex", { method: "POST" });
  },
};

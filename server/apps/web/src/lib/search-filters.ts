import type { SessionFilters } from "@session-hub/shared";

export interface SearchFilterInput {
  agent?: string;
  machine?: string;
  title?: string;
  source_id?: string;
  created_from?: string;
  created_to?: string;
  updated_from?: string;
  updated_to?: string;
}

export type SearchFilterParams = Partial<Record<keyof SearchFilterInput, string>>;

const NAME_KEYS = ["agent", "machine", "title", "source_id"] as const;
const DATE_KEYS = ["created_from", "created_to", "updated_from", "updated_to"] as const;

export function dateToMs(date: string, edge: "start" | "end"): number | undefined {
  const trimmed = date.trim();
  if (!trimmed) return undefined;
  const suffix = edge === "start" ? "T00:00:00.000" : "T23:59:59.999";
  const ms = new Date(`${trimmed}${suffix}`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function toApiFilters(input: SearchFilterInput): SessionFilters {
  const filters: SessionFilters = {};
  for (const key of NAME_KEYS) {
    const value = input[key]?.trim();
    if (value) filters[key] = value;
  }
  for (const key of DATE_KEYS) {
    const ms = dateToMs(input[key] ?? "", key.endsWith("_from") ? "start" : "end");
    if (ms !== undefined) filters[key] = ms;
  }
  return filters;
}

export function toSearchParams(input: SearchFilterInput): SearchFilterParams {
  const params: SearchFilterParams = {};
  for (const key of NAME_KEYS) {
    const value = input[key]?.trim();
    if (value) params[key] = value;
  }
  for (const key of DATE_KEYS) {
    const value = input[key]?.trim();
    if (value) params[key] = value;
  }
  return params;
}

export function hasAnyFilter(input: SearchFilterInput): boolean {
  return Object.keys(toSearchParams(input)).length > 0;
}

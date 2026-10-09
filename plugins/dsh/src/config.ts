import { z } from "zod";

export const Config = z.object({
  baseUrl: z.string().max(2_048).optional(),
  token: z.string().max(8_192).optional(),
  machine: z.string().max(128).optional(),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).default(15_000),
  workerCwd: z.string().max(4_096).optional(),
  reconcileOnStart: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(4).default(2),
});

export type RawPluginConfig = z.input<typeof Config>;

export interface ExplicitPluginConfig {
  baseUrl: string | undefined;
  token: string | undefined;
  machine: string | undefined;
  timeoutMs: number;
  workerCwd: string | undefined;
  reconcileOnStart: boolean;
  concurrency: number;
}

export interface DshPluginConfig {
  baseUrl: string;
  token: string;
  machine: string;
  timeoutMs: number;
  workerCwd: string | undefined;
  reconcileOnStart: boolean;
  concurrency: number;
}

export type ExplicitConfigResult =
  | { ok: true; config: ExplicitPluginConfig }
  | { ok: false; category: "configuration_invalid" };

export function isAbsoluteWorkerCwd(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(https?):\/\/([^/?#\s]+)(?:\/[^?#]*)?\/?$/i.exec(trimmed);
  if (!match) return null;
  const authority = match[2]!;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0 || !/^[0-9a-f:.]+$/i.test(authority.slice(1, closingBracket))) return null;
    const suffix = authority.slice(closingBracket + 1);
    if (suffix !== "") {
      if (!/^:\d+$/.test(suffix)) return null;
      port = suffix.slice(1);
    }
  } else {
    const hostMatch = /^([a-z0-9.-]+)(?::(\d+))?$/i.exec(authority);
    if (!hostMatch) return null;
    port = hostMatch[2];
  }
  if (port !== undefined && Number(port) > 65_535) return null;
  return trimmed.replace(/\/+$/, "");
}

export function parseExplicitConfig(raw: unknown): ExplicitConfigResult {
  const result = Config.safeParse(raw ?? {});
  if (!result.success) return { ok: false, category: "configuration_invalid" };
  const parsed = result.data;

  const baseUrlValue = parsed.baseUrl?.trim() ?? "";
  const workerCwdValue = parsed.workerCwd?.trim() ?? "";
  const tokenValue = parsed.token?.trim() ?? "";
  const machineValue = parsed.machine?.trim() ?? "";

  let baseUrl: string | undefined;
  if (baseUrlValue.length > 0) {
    const normalized = normalizeBaseUrl(baseUrlValue);
    if (normalized === null) return { ok: false, category: "configuration_invalid" };
    baseUrl = normalized;
  }
  if (workerCwdValue.length > 0 && !isAbsoluteWorkerCwd(workerCwdValue)) {
    return { ok: false, category: "configuration_invalid" };
  }

  return {
    ok: true,
    config: {
      baseUrl,
      token: tokenValue.length > 0 ? tokenValue : undefined,
      machine: machineValue.length > 0 ? machineValue : undefined,
      timeoutMs: parsed.timeoutMs,
      workerCwd: workerCwdValue.length > 0 ? workerCwdValue : undefined,
      reconcileOnStart: parsed.reconcileOnStart,
      concurrency: parsed.concurrency,
    },
  };
}

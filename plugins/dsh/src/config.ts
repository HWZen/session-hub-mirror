import { z } from "zod";

export const Config = z.object({
  baseUrl: z.string().max(2_048).optional().default(""),
  token: z.string().max(8_192).optional().default(""),
  machine: z.string().max(128).optional().default(""),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).default(15_000),
  workerCwd: z.string().max(4_096).optional().default(""),
  reconcileOnStart: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(4).default(2),
});

export type RawPluginConfig = z.input<typeof Config>;

export interface DshPluginConfig {
  baseUrl: string;
  token: string;
  machine: string;
  timeoutMs: number;
  workerCwd: string;
  reconcileOnStart: boolean;
  concurrency: number;
}

export function isAbsoluteWorkerCwd(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function normalizeBaseUrl(value: string): string | null {
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

export function parsePluginConfig(raw: unknown): DshPluginConfig | null {
  const result = Config.safeParse(raw ?? {});
  if (!result.success) return null;
  const parsed = result.data;
  const baseUrl = normalizeBaseUrl(parsed.baseUrl);
  if (!baseUrl || !parsed.token.trim() || !parsed.machine.trim() || !isAbsoluteWorkerCwd(parsed.workerCwd)) {
    return null;
  }
  return {
    baseUrl,
    token: parsed.token.trim(),
    machine: parsed.machine.trim(),
    timeoutMs: parsed.timeoutMs,
    workerCwd: parsed.workerCwd,
    reconcileOnStart: parsed.reconcileOnStart,
    concurrency: parsed.concurrency,
  };
}

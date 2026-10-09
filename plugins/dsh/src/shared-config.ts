import { isAbsoluteWorkerCwd, normalizeBaseUrl, type DshPluginConfig, type ExplicitPluginConfig } from "./config.js";
import type { DshFsService } from "./types.js";

export const SHARED_CONFIG_PATH = "~/.config/session-hub/config.json";
export const SHARED_CONFIG_RELATIVE_PATH = ".config/session-hub/config.json";

export interface SharedConfigValues {
  baseUrl?: string;
  token?: string;
  machine?: string;
}

export interface SharedConfigTextResult {
  text: string | null;
  categories: string[];
}

export type SharedConfigTextSource = () => Promise<SharedConfigTextResult>;

export function resolveSharedConfigPath(home: string): string {
  const trimmed = home.trim().replace(/[\\/]+$/, "");
  return trimmed.length === 0
    ? SHARED_CONFIG_RELATIVE_PATH
    : `${trimmed}/${SHARED_CONFIG_RELATIVE_PATH}`;
}

async function safeProbeHome(probe: () => Promise<string | null>): Promise<string | null> {
  try {
    const value = await probe();
    if (typeof value === "string" && isAbsoluteWorkerCwd(value)) return value;
  } catch {
    // an unusable home directory only costs the ctx.fs route, never activation
  }
  return null;
}

export function createSharedConfigTextSource(options: {
  fs: DshFsService | undefined;
  probeHome: () => Promise<string | null>;
  readViaSidecar: (path: string, expandHome: boolean) => Promise<string | null>;
}): SharedConfigTextSource {
  return async () => {
    const home = await safeProbeHome(options.probeHome);
    const fs = options.fs;
    if (home !== null && fs !== undefined && typeof fs.resolve === "function" && typeof fs.readText === "function") {
      try {
        const target = await fs.resolve(resolveSharedConfigPath(home));
        const text = await fs.readText(target);
        if (typeof text === "string") return { text, categories: [] };
      } catch {
        // the sandboxed filesystem rejected the read; fall through to the sidecar
      }
    }
    try {
      const text = await options.readViaSidecar(
        home === null ? SHARED_CONFIG_PATH : resolveSharedConfigPath(home),
        home === null,
      );
      if (typeof text === "string") return { text, categories: [] };
    } catch {
      // both channels failed; degrade without throwing
    }
    return { text: null, categories: ["shared_config_unreadable"] };
  };
}

export function parseSharedConfigText(text: string): { values: SharedConfigValues; categories: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { values: {}, categories: ["shared_config_invalid_json"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { values: {}, categories: ["shared_config_invalid_json"] };
  }

  const record = parsed as Record<string, unknown>;
  const values: SharedConfigValues = {};
  const categories: string[] = [];

  const baseUrl = record["baseUrl"];
  if (baseUrl !== undefined) {
    const normalized = typeof baseUrl === "string" ? normalizeBaseUrl(baseUrl) : null;
    if (normalized === null) categories.push("shared_config_invalid_field:baseUrl");
    else values.baseUrl = normalized;
  }

  const token = record["token"];
  if (token !== undefined) {
    if (typeof token === "string" && token.trim().length > 0) values.token = token.trim();
    else categories.push("shared_config_invalid_field:token");
  }

  const machine = record["machine"];
  if (machine !== undefined) {
    if (typeof machine === "string" && machine.trim().length > 0) values.machine = machine.trim();
    else categories.push("shared_config_invalid_field:machine");
  }

  return { values, categories };
}

export function createMemoizedProbe(probe: () => Promise<string | null>): () => Promise<string | null> {
  let cached: string | undefined;
  let inflight: Promise<string | null> | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const value = await probe();
        if (typeof value === "string" && value.trim().length > 0) {
          cached = value.trim();
          return cached;
        }
        return null;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}

export async function resolveDerivedWorkerCwd(options: {
  fs: DshFsService | undefined;
  probeHome: () => Promise<string | null>;
}): Promise<string | null> {
  const fs = options.fs;
  if (fs !== undefined && typeof fs.resolve === "function" && typeof fs.processPath === "function") {
    try {
      const target = await fs.resolve(".");
      const path = fs.processPath(target);
      if (typeof path === "string" && isAbsoluteWorkerCwd(path)) return path;
    } catch {
      // fall through to the hostname/home probe
    }
  }
  try {
    const home = await options.probeHome();
    if (typeof home === "string" && isAbsoluteWorkerCwd(home)) return home;
  } catch {
    // no usable default directory; the caller omits cwd instead
  }
  return null;
}

export interface ResolvePluginConfigOptions {
  readSharedConfigText: SharedConfigTextSource;
  probeHostname: () => Promise<string | null>;
  defaultWorkerCwd: string | undefined;
}

export type PluginConfigResolution =
  | { ok: true; config: DshPluginConfig; categories: string[] }
  | { ok: false; category: "configuration_required"; categories: string[] };

export async function resolvePluginConfig(
  explicit: ExplicitPluginConfig,
  options: ResolvePluginConfigOptions,
): Promise<PluginConfigResolution> {
  const categories: string[] = [];
  let shared: SharedConfigValues = {};

  if (explicit.baseUrl === undefined || explicit.token === undefined || explicit.machine === undefined) {
    try {
      const read = await options.readSharedConfigText();
      categories.push(...read.categories);
      if (read.text !== null) {
        const parsed = parseSharedConfigText(read.text);
        categories.push(...parsed.categories);
        shared = parsed.values;
      }
    } catch {
      categories.push("shared_config_unreadable");
    }
  }

  const baseUrl = explicit.baseUrl ?? shared.baseUrl;
  const token = explicit.token ?? shared.token;
  if (baseUrl === undefined || token === undefined) {
    return { ok: false, category: "configuration_required", categories };
  }

  let machine = explicit.machine ?? shared.machine;
  if (machine === undefined) {
    try {
      const probed = await options.probeHostname();
      if (typeof probed === "string" && probed.trim().length > 0) machine = probed.trim();
    } catch {
      // an unavailable hostname probe only leaves machine unresolved
    }
  }
  if (machine === undefined) {
    return { ok: false, category: "configuration_required", categories };
  }

  return {
    ok: true,
    categories,
    config: {
      baseUrl,
      token,
      machine,
      timeoutMs: explicit.timeoutMs,
      workerCwd: explicit.workerCwd ?? options.defaultWorkerCwd,
      reconcileOnStart: explicit.reconcileOnStart,
      concurrency: explicit.concurrency,
    },
  };
}

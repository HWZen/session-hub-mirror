import { readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type SessionHubConfig } from "./config.js";
import { defaultCodexHome, readRolloutFile, readTitleIndex, type ParsedRollout } from "./parse.js";
import { transformRollout, type TransformedSession } from "./transform.js";
import { uploadSession } from "./upload.js";

export interface BackfillOptions {
  codexHome: string;
  dryRun: boolean;
  url?: string;
  token?: string;
  since?: number;
}

export interface BackfillCounters {
  files: number;
  sessions: number;
  uploaded: number;
  failed: number;
  skipped_since: number;
  skipped_subagents: number;
  invalid_files: number;
}

export interface BackfillHooks {
  upload?: (payload: TransformedSession) => Promise<{ ok: boolean; status: number }>;
}

export function parseArgs(argv: string[]): Record<string, string> | null {
  const args: Record<string, string> = {};
  const allowed = new Set(["codex-home", "since", "dry-run", "url", "token"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg?.startsWith("--") || arg.length <= 2) return null;
    const bare = arg.slice(2);
    const separator = bare.indexOf("=");
    const key = separator === -1 ? bare : bare.slice(0, separator);
    if (!allowed.has(key)) return null;
    if (key === "dry-run") {
      args[key] = "true";
      continue;
    }
    if (separator !== -1) {
      args[key] = bare.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) return null;
    args[key] = next;
    index++;
  }
  return args;
}

function parseSince(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
  const date = Date.parse(value);
  return Number.isFinite(date) && date >= 0 ? date : null;
}

export function resolveOptions(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  configPath?: string,
): BackfillOptions | null {
  const args = parseArgs(argv);
  if (!args) return null;
  const since = parseSince(args["since"]);
  if (since === null) return null;
  const dryRun = args["dry-run"] === "true";
  let url = args["url"] ?? env["SESSION_HUB_URL"];
  let token = args["token"] ?? env["SESSION_HUB_TOKEN"];
  if ((!url || !token) && !dryRun) {
    const config = loadConfig(env, configPath);
    if (config) {
      url ??= config.baseUrl;
      token ??= config.token;
    }
  }
  if (!dryRun && (!url || !token)) return null;
  return {
    codexHome: args["codex-home"] ?? defaultCodexHome(env),
    dryRun,
    ...(url === undefined ? {} : { url }),
    ...(token === undefined ? {} : { token }),
    ...(since === undefined ? {} : { since }),
  };
}

export function listRolloutFiles(sessionsRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(path);
    }
  };
  visit(sessionsRoot);
  return files.sort();
}

export async function runBackfill(
  options: BackfillOptions,
  hooks: BackfillHooks = {},
): Promise<BackfillCounters> {
  const counters: BackfillCounters = {
    files: 0,
    sessions: 0,
    uploaded: 0,
    failed: 0,
    skipped_since: 0,
    skipped_subagents: 0,
    invalid_files: 0,
  };
  const files = listRolloutFiles(join(options.codexHome, "sessions"));
  counters.files = files.length;
  const latest = new Map<string, ParsedRollout>();
  for (const file of files) {
    let rollout: ParsedRollout | null;
    try {
      rollout = readRolloutFile(file);
    } catch {
      rollout = null;
    }
    if (!rollout) {
      counters.invalid_files++;
      continue;
    }
    if (rollout.isSubagent) {
      counters.skipped_subagents++;
      continue;
    }
    const previous = latest.get(rollout.sourceId);
    if (!previous || rollout.updatedAt >= previous.updatedAt) latest.set(rollout.sourceId, rollout);
  }
  counters.sessions = latest.size;
  const titles = readTitleIndex(join(options.codexHome, "session_index.jsonl"));
  const config: SessionHubConfig | null = options.url && options.token
    ? { baseUrl: options.url, token: options.token, timeoutMs: 120_000 }
    : null;
  for (const rollout of [...latest.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (options.since !== undefined && rollout.updatedAt < options.since) {
      counters.skipped_since++;
      continue;
    }
    const title = titles.get(rollout.sourceId);
    const payload = transformRollout(rollout, {
      machine: hostname(),
      ...(title === undefined ? {} : {
        title: title.title,
        ...(title.updatedAt === undefined ? {} : { titleUpdatedAt: title.updatedAt }),
      }),
    });
    if (options.dryRun) continue;
    try {
      const result = hooks.upload
        ? await hooks.upload(payload)
        : await uploadSession(config as SessionHubConfig, payload);
      if (result.ok) counters.uploaded++;
      else counters.failed++;
    } catch {
      counters.failed++;
    }
  }
  return counters;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const options = resolveOptions(process.argv.slice(2));
  if (!options) {
    console.error("usage: backfill [--codex-home <path>] [--since <ms|date>] [--dry-run] [--url <baseUrl> --token <token>]");
    process.exitCode = 1;
  } else {
    runBackfill(options)
      .then((counters) => console.log(JSON.stringify(counters)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { loadConfig, uploadSession, type SessionHubConfig } from "./config.js";
import { transformSession } from "./transform.js";
import { groupTranscript, readTranscript } from "./transcript.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface BackfillOptions {
  since?: number;
  dryRun: boolean;
}

export interface BackfillDeps {
  config?: SessionHubConfig | null;
  upload?: typeof uploadSession;
  projectsDir?: string;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  failed: number;
}

function findSessionFiles(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const fullPath = join(dir, name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (name !== "subagents") findSessionFiles(fullPath, files);
    } else if (stats.isFile() && name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function backfillSessions(
  options: BackfillOptions,
  deps: BackfillDeps = {},
): Promise<BackfillResult> {
  const config = deps.config !== undefined ? deps.config : loadConfig();
  const upload = deps.upload ?? uploadSession;
  const projectsDir = deps.projectsDir ?? CLAUDE_PROJECTS_DIR;

  if (!config) {
    console.error(
      "Session Hub not configured. Set SESSION_HUB_URL and SESSION_HUB_TOKEN or ~/.config/session-hub/config.json",
    );
    return { processed: 0, skipped: 0, failed: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  const allFiles = findSessionFiles(projectsDir);
  console.log(`found ${allFiles.length} session files`);

  for (const file of allFiles) {
    if (file.includes(`${sep}subagents${sep}`)) {
      skipped++;
      continue;
    }
    try {
      const entries = readTranscript(file);
      if (entries.length === 0) {
        skipped++;
        continue;
      }
      if (options.since !== undefined) {
        const firstTs = entries[0]?.timestamp !== undefined ? Date.parse(entries[0].timestamp) : Number.NaN;
        if (!Number.isFinite(firstTs) || firstTs < options.since) {
          skipped++;
          continue;
        }
      }

      const transcript = groupTranscript(entries);
      if (transcript.messages.length === 0) {
        skipped++;
        continue;
      }

      const session = transformSession(transcript);

      if (options.dryRun) {
        console.log(`[dry-run] would upsert session ${session.source_id} (${session.messages.length} messages)`);
        processed++;
      } else {
        const result = await upload(config, session);
        if (result.ok) {
          console.log(`upserted session ${session.source_id} (${session.messages.length} messages)`);
          processed++;
        } else {
          console.error(`upload failed for session ${session.source_id}: status ${result.status}`);
          failed++;
        }
      }
    } catch (err) {
      console.error(`failed on file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { processed, skipped, failed };
}

function parseArgs(args: string[]): BackfillOptions {
  const options: BackfillOptions = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--since" && i + 1 < args.length) {
      options.since = Number.parseInt(args[i + 1] as string, 10);
      i++;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await backfillSessions(options);
  console.log(`backfill complete: processed ${result.processed}, skipped ${result.skipped}, failed ${result.failed}`);
  process.exit(result.failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("backfill.js");

if (isMain) {
  await main();
}

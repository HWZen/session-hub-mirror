import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { loadConfig, uploadSession } from "./config.js";
import { transformSession } from "./transform.js";
import { readTranscript, groupTranscript } from "./transcript.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface BackfillOptions {
  since?: number;
  dryRun: boolean;
}

export async function backfillSessions(options: BackfillOptions): Promise<{
  processed: number;
  skipped: number;
  failed: number;
}> {
  const config = loadConfig();
  if (!config) {
    console.error("Session Hub not configured. Set SESSION_HUB_URL and SESSION_HUB_TOKEN or configure ~/.config/session-hub/config.json");
    return { processed: 0, skipped: 0, failed: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  // Recursively find all session JSONL files
  function findSessionFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          // Skip subagents directory
          if (entry !== "subagents") {
            files.push(...findSessionFiles(fullPath));
          }
        } else if (stats.isFile() && entry.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore directory access errors
    }
    return files;
  }

  const allFiles = findSessionFiles(CLAUDE_PROJECTS_DIR);
  console.log(`Found ${allFiles.length} session files`);

  for (const file of allFiles) {
    // Skip files in subagents directories
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

      // Check if session is within the since timeframe
      if (options.since) {
        const firstEntryTime = new Date(entries[0].timestamp).getTime();
        if (firstEntryTime < options.since) {
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
        console.log(`[DRY RUN] Would upsert session ${session.source_id} (${session.title}) with ${session.messages.length} messages`);
        processed++;
      } else {
        const result = await uploadSession(config, session);
        if (result.ok) {
          console.log(`Processed session ${session.source_id}`);
          processed++;
        } else {
          console.error(`Failed to process session ${session.source_id}: status ${result.status}`);
          failed++;
        }
      }
    } catch (err) {
      console.error(`Error processing file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { processed, skipped, failed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options: BackfillOptions = {
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--since" && i + 1 < args.length) {
      options.since = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  const result = await backfillSessions(options);
  console.log(`Backfill complete: processed ${result.processed}, skipped ${result.skipped}, failed ${result.failed}`);
  process.exit(result.failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("backfill.js");

if (isMain) {
  main();
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";
import { loadConfig } from "./config.js";
import { runHook, type RunHookDeps } from "./hook.js";
import { uploadSession } from "./upload.js";

export interface BackfillStats {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  failures: string[];
}

export interface BackfillDeps {
  config: NonNullable<ReturnType<typeof loadConfig>>;
  machine: string;
  projectsDir: string;
  listTranscripts: (dir: string) => string[];
  readTranscript: (path: string) => string;
  upload: RunHookDeps["upload"];
  onProgress?: (done: number, total: number, stats: BackfillStats) => void;
}

export function listWorkbuddyTranscripts(projectsDir: string): string[] {
  const files: string[] = [];
  for (const dir of readdirSync(projectsDir)) {
    const dirPath = join(projectsDir, dir);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of readdirSync(dirPath)) {
      if (f.toLowerCase().endsWith(".jsonl")) files.push(join(dirPath, f));
    }
  }
  files.sort();
  return files;
}

export async function runBackfill(deps: BackfillDeps): Promise<BackfillStats> {
  const stats: BackfillStats = { total: 0, uploaded: 0, skipped: 0, failed: 0, failures: [] };
  let files: string[] = [];
  try {
    files = deps.listTranscripts(deps.projectsDir);
  } catch {
    files = [];
  }
  stats.total = files.length;
  let done = 0;
  for (const path of files) {
    const sessionId = basename(path).replace(/\.jsonl$/i, "");
    let empty = false;
    try {
      empty = statSync(path).size === 0;
    } catch {
      empty = true;
    }
    if (empty) {
      stats.skipped++;
      done++;
      deps.onProgress?.(done, files.length, stats);
      continue;
    }
    const stdin = JSON.stringify({
      session_id: sessionId,
      transcript_path: path,
      hook_event_name: "Backfill",
    });
    const outcome = await runHook(stdin, {
      config: deps.config,
      machine: deps.machine,
      readTranscript: deps.readTranscript,
      upload: deps.upload,
    });
    if (outcome.uploaded) {
      stats.uploaded++;
    } else if (outcome.stderr.includes("payload schema mismatch")) {
      stats.skipped++;
    } else {
      stats.failed++;
      stats.failures.push(outcome.stderr || `session=${sessionId} unknown failure`);
    }
    done++;
    deps.onProgress?.(done, files.length, stats);
  }
  return stats;
}

function listTranscriptsDefault(dir: string): string[] {
  try {
    return listWorkbuddyTranscripts(dir);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error("session-hub not configured, abort");
    process.exit(1);
  }
  const projectsDir = join(homedir(), ".workbuddy", "projects");
  const stats = await runBackfill({
    config,
    machine: hostname(),
    projectsDir,
    listTranscripts: listTranscriptsDefault,
    readTranscript: (p) => readFileSync(p, "utf8"),
    upload: uploadSession,
    onProgress: (done, total, s) => {
      if (done % 20 === 0 || done === total) {
        console.log(`progress ${done}/${total} uploaded=${s.uploaded} skipped=${s.skipped} failed=${s.failed}`);
      }
    },
  });
  console.log(
    `backfill done: total=${stats.total} uploaded=${stats.uploaded} skipped=${stats.skipped} failed=${stats.failed}`,
  );
  for (const f of stats.failures) console.log(`failed: ${f}`);
  process.exitCode = stats.failed > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("workbuddy/backfill.ts")) {
  void main();
}

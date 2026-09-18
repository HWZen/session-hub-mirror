import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

for (const file of ["hook.js", "worker.js", "backfill.js"]) {
  if (!existsSync(join(root, "dist", file))) {
    console.error(`missing build output: dist/${file}`);
    process.exit(1);
  }
}

console.log(`
Codex plugin build completed at:
  ${root}

Install it from your local marketplace, then open /hooks in a new Codex task and review and trust the Stop hook.

Configuration:
  SESSION_HUB_URL / SESSION_HUB_TOKEN, or ~/.config/session-hub/config.json

Historical backfill:
  npm run backfill -w @session-hub/codex-plugin -- --dry-run
  npm run backfill -w @session-hub/codex-plugin -- --url <baseUrl> --token <token>

Worker log (metadata only): ~/.config/session-hub/logs/codex-worker.log
`);

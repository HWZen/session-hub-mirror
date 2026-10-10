import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/hook.ts"), join(root, "src/worker.ts"), join(root, "src/backfill.ts")],
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  splitting: false,
  sourcemap: false,
  logLevel: "info",
});

console.log(`claude-code plugin built to dist/ (hook entry: ${join(dist, "hook.js")})`);

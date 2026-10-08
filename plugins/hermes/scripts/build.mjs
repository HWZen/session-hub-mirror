import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    hook: join(root, "src/hook.ts"),
    worker: join(root, "src/worker.ts"),
    backfill: join(root, "src/backfill.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["better-sqlite3"],
  splitting: false,
  sourcemap: false,
  logLevel: "info",
});

console.log(`hermes plugin built to ${dist}`);

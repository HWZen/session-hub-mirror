import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/hook.ts"), join(root, "src/worker.ts")],
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

const fallbackHooks = {
  UserPromptSubmit: [
    { hooks: [{ type: "process", command: process.execPath, args: [join(dist, "hook.js")], timeoutMs: 10000 }] },
  ],
  Stop: [
    { hooks: [{ type: "process", command: process.execPath, args: [join(dist, "hook.js")], timeoutMs: 10000 }] },
  ],
};
writeFileSync(join(dist, "hooks-absolute.json"), JSON.stringify(fallbackHooks, null, 2) + "\n");
console.log(`zcode plugin built to dist/ (hook entry: ${join(dist, "hook.js")})`);

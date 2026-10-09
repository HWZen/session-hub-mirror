import { build } from "esbuild";
import { resolve } from "node:path";

const isProduction = process.argv.includes("--production");

async function buildAll() {
  // Build hook.js
  await build({
    entryPoints: [resolve("src/hook.ts")],
    bundle: true,
    platform: "node",
    target: "es2022",
    outfile: resolve("dist/hook.js"),
    format: "esm",
    sourcemap: isProduction ? false : "inline",
    minify: isProduction,
  });

  // Build worker.js
  await build({
    entryPoints: [resolve("src/worker.ts")],
    bundle: true,
    platform: "node",
    target: "es2022",
    outfile: resolve("dist/worker.js"),
    format: "esm",
    sourcemap: isProduction ? false : "inline",
    minify: isProduction,
  });

  // Build backfill.js
  await build({
    entryPoints: [resolve("src/backfill.ts")],
    bundle: true,
    platform: "node",
    target: "es2022",
    outfile: resolve("dist/backfill.js"),
    format: "esm",
    sourcemap: isProduction ? false : "inline",
    minify: isProduction,
  });

  console.log("Build complete");
}

buildAll().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

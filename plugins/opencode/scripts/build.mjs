import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = resolve(scriptDirectory, "..");
const entry = join(pluginDirectory, "src", "entry.ts");

export function getDefaultOutputPath() {
  return join(pluginDirectory, "dist", "session-hub.js");
}

function parseOutputPath(args) {
  if (args.length === 0) return getDefaultOutputPath();
  if (args.length === 2 && args[0] === "--outfile" && args[1]) return args[1];
  if (args.length === 2 && args[0] === "--outfile-metafile" && args[1]) return args[1];
  if (args.length === 1 && args[0]?.startsWith("--outfile=") && args[0].length > 10) {
    return args[0].slice(10);
  }
  throw new Error("用法: node scripts/build.mjs [--outfile <path>]");
}

export async function buildBundle(options = {}) {
  const outfile = resolve(options.outfile ?? getDefaultOutputPath());
  await mkdir(dirname(outfile), { recursive: true });
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["node:*"],
    outfile,
    sourcemap: false,
    minify: false,
    legalComments: "none",
    ...(options.metafile ? { metafile: true } : {}),
  });
  if (options.metafile) await writeFile(`${outfile}.meta.json`, JSON.stringify(result.metafile));
  return outfile;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const metafile = args.includes("--metafile") || args.includes("--outfile-metafile");
    const outfile = await buildBundle({ outfile: parseOutputPath(args.filter((value) => value !== "--metafile")), metafile });
    console.log(`session-hub bundle built: ${outfile}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

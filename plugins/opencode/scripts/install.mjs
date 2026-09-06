import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../src/entry.ts", import.meta.url));
const targetDir = join(homedir(), ".config", "opencode", "plugins");
const target = join(targetDir, "session-hub.js");

mkdirSync(targetDir, { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["node:*"],
  outfile: target,
  sourcemap: false,
  minify: false,
  legalComments: "none",
});
console.log(`session-hub plugin installed: ${target}`);

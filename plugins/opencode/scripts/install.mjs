import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildBundle } from "./build.mjs";

function installTarget(args) {
  if (args.length === 0) return join(homedir(), ".config", "opencode", "plugins", "session-hub.js");
  if (args.length === 2 && args[0] === "--target" && args[1]) return resolve(args[1]);
  if (args.length === 1 && args[0]?.startsWith("--target=") && args[0].length > 9) {
    return resolve(args[0].slice(9));
  }
  throw new Error("用法: node scripts/install.mjs [--target <path>]");
}

const target = await buildBundle({ outfile: installTarget(process.argv.slice(2)) });
console.log(`session-hub plugin installed: ${target}`);

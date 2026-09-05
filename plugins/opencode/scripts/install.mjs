import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/plugin.ts", import.meta.url));
const targetDir = join(homedir(), ".config", "opencode", "plugins");
const target = join(targetDir, "session-hub.js");
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`session-hub plugin installed: ${target}`);

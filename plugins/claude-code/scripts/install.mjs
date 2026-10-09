import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Generate .claude-plugin/plugin.json
const pluginJson = {
  name: "@session-hub/claude-code-plugin",
  version: "0.1.0",
  displayName: "Session Hub Claude Code Collector",
  description: "Collect Claude Code sessions and upload to Session Hub",
  author: "Session Hub",
  icon: "https://example.com/icon.png",
  main: "dist/hook.js",
  hooks: "hooks/hooks.json"
};

// Generate hooks/hooks.json
const hooksJson = {
  hooks: {
    "UserPromptSubmit": [
      {
        "matcher": {"command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\""},
        "hooks": [{"type": "stdin"}]
      }
    ],
    "Stop": [
      {
        "matcher": {"command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\""},
        "hooks": [{"type": "stdin"}]
      }
    ],
    "SessionEnd": [
      {
        "matcher": {"command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hook.js\""},
        "hooks": [{"type": "stdin"}]
      }
    ]
  }
};

// Generate .claude-plugin/marketplace.json entry? Wait no, the main marketplace is plugins/.claude-plugin/marketplace.json

console.log("Plugin files generated:");
console.log("- .claude-plugin/plugin.json");
console.log("- hooks/hooks.json");
console.log("\nTo install this plugin:");
console.log("1. In Claude Code, run: /plugin marketplace add D:/Github/session-hub/plugins");
console.log("2. Then run: /plugin install session-hub@session-hub");
console.log("3. **Important: Restart Claude Code for changes to take effect!**");
console.log("\nTo test manually:");
console.log("claude --plugin-dir D:/Github/session-hub/plugins/claude-code -p \"Test Session\"");

// Write files
const pluginDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(pluginDir, "..");

writeFileSync(join(rootDir, ".claude-plugin", "plugin.json"), JSON.stringify(pluginJson, null, 2));
writeFileSync(join(rootDir, "hooks", "hooks.json"), JSON.stringify(hooksJson, null, 2));

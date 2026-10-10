import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const build = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

for (const name of ["hook.js", "worker.js", "backfill.js"]) {
  const file = join(root, "dist", name);
  if (!existsSync(file)) {
    console.error(`missing build output: ${file}`);
    process.exit(1);
  }
  const code = readFileSync(file, "utf8");
  if (/\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean)\b/.test(code.replace(/"[^"]*"/g, '""'))) {
    console.error(`warning: ${file} may contain TS syntax — Node would fail to load it`);
  }
}

console.log(`
claude-code 插件构建完成。安装步骤：

1. Claude Code 内执行: /plugin marketplace add ${dirname(root)}
   （marketplace 根即 plugins/ 目录，读取 .claude-plugin/marketplace.json）

2. 启用插件: /plugin install session-hub-claude-code@session-hub
   开发期也可直接试跑: claude --plugin-dir ${root} -p "..."

3. 安装/改动后必须重启 Claude Code（hooks 在会话启动时加载）。

4. 配置服务端地址（与 zcode/dsh 插件共用）：
   - 环境变量 SESSION_HUB_URL / SESSION_HUB_TOKEN，或
   - ~/.config/session-hub/config.json（baseUrl/token/timeoutMs）
   未配置时插件静默不启用（hook 直接退出 0）。

5. 历史回填: node ${join(root, "dist", "backfill.js")} [--since <ms>] [--dry-run]

日志只记元数据，不打印会话正文。
`);

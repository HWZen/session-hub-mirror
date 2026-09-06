import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const build = spawnSync(process.execPath, [join(root, "build.mjs")], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const hookJs = join(root, "dist", "hook.js");
const workerJs = join(root, "dist", "worker.js");
for (const file of [hookJs, workerJs]) {
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
zcode 插件构建完成。安装步骤：

1. ZCode → Settings → Plugin Management → Discover → "+" 添加本地目录 marketplace：
   ${dirname(root)}
   （marketplace 根即 plugins/ 目录，从中启用 session-hub 插件）

2. 插件 hook 需要能找到 node 与 dist/hook.js：
   - hooks/hooks.json 使用相对路径 "dist/hook.js"
   - 若新会话中 hook 未生效，把 manifest（.zcode-plugin/plugin.json）的 hooks 指向
     dist/hooks-absolute.json（构建时生成的本机绝对路径版本）

3. 配置服务端地址（与 opencode 插件共用）：
   - 环境变量 SESSION_HUB_URL / SESSION_HUB_TOKEN，或
   - ~/.config/session-hub/config.json（baseUrl/token/timeoutMs）
   未配置时插件静默不启用。

4. 历史回填：npm run backfill -- --url <baseUrl> --token <token> [--since <ms>] [--dry-run]

运行日志（仅元数据）：~/.config/session-hub/logs/zcode-worker.log
`);

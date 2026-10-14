import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDirectory = fileURLToPath(new URL("..", import.meta.url));
const buildScript = join(pluginDirectory, "scripts", "build.mjs");

describe("OpenCode plugin build-only script", () => {
  it("writes the default bundle inside the workspace, independent of user home", () => {
    const isolatedHome = mkdtempSync(join(pluginDirectory, ".build-test-home-"));
    try {
      const result = spawnSync(process.execPath, [buildScript], {
        cwd: pluginDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const bundle = join(pluginDirectory, "dist", "session-hub.js");
      expect(existsSync(bundle)).toBe(true);
      expect(readFileSync(bundle, "utf8")).toContain("session-hub");
      expect(existsSync(join(isolatedHome, ".config", "opencode", "plugins", "session-hub.js"))).toBe(false);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("imports an isolated bundle in native Node with only node: builtins external", () => {
    const target = join(pluginDirectory, "dist", "session-hub.import-test.mjs");
    const metafile = `${target}.meta.json`;
    try {
      const build = spawnSync(process.execPath, [buildScript, "--outfile", target, "--metafile"], {
        cwd: pluginDirectory,
        encoding: "utf8",
      });
      expect(build.status, build.stderr || build.stdout).toBe(0);
      const meta = JSON.parse(readFileSync(metafile, "utf8")) as {
        outputs: Record<string, { imports?: { path: string; external?: boolean }[] }>;
      };
      const external = new Set<string>();
      for (const output of Object.values(meta.outputs)) {
        for (const record of output.imports ?? []) {
          if (record.external) external.add(record.path);
        }
      }
      expect([...external].sort()).toEqual(["node:fs", "node:os", "node:path", "node:url"]);
      const code = `const m = await import(${JSON.stringify(pathToFileURL(target).href)}); console.log(JSON.stringify({exports:Object.keys(m),id:m.default.id,setup:typeof m.default.setup,server:typeof m.default.server}));`;
      const isolatedHome = mkdtempSync(join(pluginDirectory, ".import-test-home-"));
      try {
        const imported = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
          cwd: pluginDirectory,
          encoding: "utf8",
          env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
        });
        expect(imported.status, imported.stderr || imported.stdout).toBe(0);
        expect(JSON.parse(imported.stdout)).toEqual({
          exports: ["default"],
          id: "session-hub",
          setup: "function",
          server: "function",
        });
      } finally {
        rmSync(isolatedHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(target, { force: true });
      rmSync(metafile, { force: true });
    }
  });

  it("installs the bundle to an explicit target", () => {
    const isolatedHome = mkdtempSync(join(pluginDirectory, ".install-test-home-"));
    const target = join(isolatedHome, "candidate", "session-hub.js");
    try {
      const result = spawnSync(process.execPath, [join(pluginDirectory, "scripts", "install.mjs"), "--target", target], {
        cwd: pluginDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(isolatedHome, ".config", "opencode", "plugins", "session-hub.js"))).toBe(false);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

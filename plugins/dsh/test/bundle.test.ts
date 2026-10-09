import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  files: string[];
  dsh: { bundle: { patch: string } };
};
const patch = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");

describe("DSH Cordis bundle", () => {
  it("exports the built host entry and declares its package patch", () => {
    expect(manifest.name).toBe("@session-hub/dsh-plugin");
    expect(manifest.version).toBe("0.1.1");
    expect(manifest.exports["."]).toBe("./dist/index.js");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(manifest.files).toEqual(expect.arrayContaining(["dist/index.js", "cordis.patch.yml", "locale/*.json"]));
    expect(patch).toContain("name: '@session-hub/dsh-plugin'");
    expect(patch).toContain("disabled: true");
    expect(patch).not.toMatch(/token|authorization|secret/i);
  });

  it("keeps the bundle patch free of deployment values so activation relies on the shared config", () => {
    expect(patch).not.toMatch(/baseUrl/i);
    expect(patch).not.toMatch(/machine/i);
    expect(patch).not.toMatch(/https?:\/\//i);
  });

  it("keeps both locale files in the bundle package", () => {
    const zh = JSON.parse(readFileSync(join(packageRoot, "locale", "zh.json"), "utf8")) as { meta: { title: string } };
    const en = JSON.parse(readFileSync(join(packageRoot, "locale", "en.json"), "utf8")) as { meta: { title: string } };
    expect(zh.meta.title).toContain("DSH");
    expect(en.meta.title).toContain("DSH");
  });
});

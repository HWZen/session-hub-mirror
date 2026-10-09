import { describe, expect, it, vi } from "vitest";
import type { ExplicitPluginConfig } from "../src/config.js";
import {
  SHARED_CONFIG_PATH,
  createMemoizedProbe,
  createSharedConfigTextSource,
  parseSharedConfigText,
  resolveDerivedWorkerCwd,
  resolvePluginConfig,
  resolveSharedConfigPath,
} from "../src/shared-config.js";
import type { DshFsService, DshFsTarget } from "../src/types.js";

const fsTarget: DshFsTarget = { targetKey: "target", displayPath: "C:\\Users\\user\\.config\\session-hub\\config.json" };

function fsService(overrides: Partial<DshFsService> = {}): DshFsService {
  return {
    resolve: async () => fsTarget,
    processPath: () => "C:\\Users\\user",
    readText: async () => "{}",
    ...overrides,
  };
}

function explicit(overrides: Partial<ExplicitPluginConfig> = {}): ExplicitPluginConfig {
  return {
    baseUrl: undefined,
    token: undefined,
    machine: undefined,
    timeoutMs: 15_000,
    workerCwd: undefined,
    reconcileOnStart: true,
    concurrency: 2,
    ...overrides,
  };
}

function sharedText(text: string | null, categories: string[] = []) {
  const calls = { count: 0 };
  return {
    calls,
    read: async () => {
      calls.count += 1;
      return { text, categories };
    },
  };
}

const noProbe = async (): Promise<string | null> => null;

describe("parseSharedConfigText", () => {
  it("reads baseUrl, token, and machine and normalizes the base URL", () => {
    expect(parseSharedConfigText(JSON.stringify({
      baseUrl: "https://sshub.example.test:5202/",
      token: " shared-token ",
      machine: " WORKSTATION-B ",
      timeoutMs: 15_000,
    }))).toEqual({
      values: {
        baseUrl: "https://sshub.example.test:5202",
        token: "shared-token",
        machine: "WORKSTATION-B",
      },
      categories: [],
    });
  });

  it("degrades malformed JSON and non-object payloads without throwing", () => {
    expect(parseSharedConfigText("{ not json")).toEqual({
      values: {},
      categories: ["shared_config_invalid_json"],
    });
    expect(parseSharedConfigText("[1,2,3]")).toEqual({
      values: {},
      categories: ["shared_config_invalid_json"],
    });
  });

  it("degrades wrong field types and unusable base URLs per field", () => {
    expect(parseSharedConfigText(JSON.stringify({
      baseUrl: 42,
      token: "",
      machine: { name: "WORKSTATION-B" },
    }))).toEqual({
      values: {},
      categories: [
        "shared_config_invalid_field:baseUrl",
        "shared_config_invalid_field:token",
        "shared_config_invalid_field:machine",
      ],
    });
    expect(parseSharedConfigText(JSON.stringify({ baseUrl: "http://user:pass@hub.test" }))).toEqual({
      values: {},
      categories: ["shared_config_invalid_field:baseUrl"],
    });
  });

  it("ignores unknown keys and accepts a file without any of the three fields", () => {
    expect(parseSharedConfigText(JSON.stringify({ timeoutMs: 15_000 }))).toEqual({ values: {}, categories: [] });
  });
});

describe("createMemoizedProbe", () => {
  it("caches the first successful value and retries after failures", async () => {
    const values: Array<string | null> = [null, "", "WORKSTATION-B"];
    let calls = 0;
    const probe = createMemoizedProbe(async () => {
      calls += 1;
      const next = values.shift();
      return next === undefined ? null : next;
    });

    expect(await probe()).toBeNull();
    expect(await probe()).toBeNull();
    expect(await probe()).toBe("WORKSTATION-B");
    expect(await probe()).toBe("WORKSTATION-B");
    expect(calls).toBe(3);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    let calls = 0;
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const probe = createMemoizedProbe(async () => {
      calls += 1;
      return gate;
    });

    const first = probe();
    const second = probe();
    release("WORKSTATION-B");

    expect(await first).toBe("WORKSTATION-B");
    expect(await second).toBe("WORKSTATION-B");
    expect(calls).toBe(1);
  });
});

describe("resolveSharedConfigPath", () => {
  it("joins the shared config path onto a probed home directory", () => {
    expect(resolveSharedConfigPath("C:\\Users\\user")).toBe("C:\\Users\\user/.config/session-hub/config.json");
    expect(resolveSharedConfigPath("C:\\Users\\user\\\\")).toBe("C:\\Users\\user/.config/session-hub/config.json");
    expect(resolveSharedConfigPath("/home/user")).toBe("/home/user/.config/session-hub/config.json");
  });
});

describe("createSharedConfigTextSource", () => {
  it("reads the shared config through ctx.fs using an absolute path built from the probed home", async () => {
    const resolved: string[] = [];
    const readText = vi.fn(async () => '{"baseUrl":"http://hub.test"}');
    const fs = fsService({
      resolve: async (path: string) => { resolved.push(path); return fsTarget; },
      readText,
    });
    const probeHome = vi.fn(async () => "C:\\Users\\user");
    const readViaSidecar = vi.fn(async () => "sidecar-text");
    const read = createSharedConfigTextSource({ fs, probeHome, readViaSidecar });

    expect(await read()).toEqual({ text: '{"baseUrl":"http://hub.test"}', categories: [] });
    expect(resolved).toEqual(["C:\\Users\\user/.config/session-hub/config.json"]);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readViaSidecar).not.toHaveBeenCalled();
  });

  it("never resolves the bare tilde path because the host filesystem does not expand it", async () => {
    const resolved: string[] = [];
    const fs = fsService({ resolve: async (path: string) => { resolved.push(path); return fsTarget; } });
    const read = createSharedConfigTextSource({
      fs,
      probeHome: async () => "C:\\Users\\user",
      readViaSidecar: async () => null,
    });

    await read();
    expect(resolved).not.toContain(SHARED_CONFIG_PATH);
    expect(resolved.every((path) => path.startsWith("C:\\Users\\user"))).toBe(true);
  });

  it("falls back to the one-shot sidecar with the absolute path when the sandboxed filesystem read fails", async () => {
    const fs = fsService({ resolve: async () => { throw new Error("FS_NOT_FOUND"); } });
    const readViaSidecar = vi.fn(async () => "sidecar-json");
    const read = createSharedConfigTextSource({ fs, probeHome: async () => "C:\\Users\\user", readViaSidecar });

    expect(await read()).toEqual({ text: "sidecar-json", categories: [] });
    expect(readViaSidecar).toHaveBeenCalledWith("C:\\Users\\user/.config/session-hub/config.json", false);
  });

  it("hands the portable tilde path to the sidecar when no home directory can be probed", async () => {
    const resolve = vi.fn(async () => fsTarget);
    const fs = fsService({ resolve });
    const readViaSidecar = vi.fn(async () => "sidecar-json");
    const read = createSharedConfigTextSource({ fs, probeHome: async () => null, readViaSidecar });

    expect(await read()).toEqual({ text: "sidecar-json", categories: [] });
    expect(resolve).not.toHaveBeenCalled();
    expect(readViaSidecar).toHaveBeenCalledWith(SHARED_CONFIG_PATH, true);
  });

  it("reports shared_config_unreadable when both channels fail", async () => {
    const fs = fsService({ readText: async () => { throw new Error("FS_DENIED"); } });
    const read = createSharedConfigTextSource({
      fs,
      probeHome: async () => "C:\\Users\\user",
      readViaSidecar: async () => null,
    });

    expect(await read()).toEqual({ text: null, categories: ["shared_config_unreadable"] });
  });

  it("treats a missing fs service as a sidecar-only deployment", async () => {
    const readViaSidecar = vi.fn(async () => "{}");
    const read = createSharedConfigTextSource({
      fs: undefined,
      probeHome: async () => "C:\\Users\\user",
      readViaSidecar,
    });

    expect(await read()).toEqual({ text: "{}", categories: [] });
    expect(readViaSidecar).toHaveBeenCalledWith("C:\\Users\\user/.config/session-hub/config.json", false);
  });
});

describe("resolveDerivedWorkerCwd", () => {
  it("uses the process path of the effective filesystem directory", async () => {
    const probeHome = vi.fn(async () => "C:\\Users\\user");
    expect(await resolveDerivedWorkerCwd({ fs: fsService(), probeHome })).toBe("C:\\Users\\user");
    expect(probeHome).not.toHaveBeenCalled();
  });

  it("falls back to the home directory when the filesystem route fails", async () => {
    const fs = fsService({ resolve: async () => { throw new Error("FS_UNAVAILABLE"); } });
    expect(await resolveDerivedWorkerCwd({ fs, probeHome: async () => "C:\\Users\\user" })).toBe("C:\\Users\\user");
  });

  it("returns null when neither route yields an absolute directory", async () => {
    const fs = fsService({ processPath: () => "relative" });
    expect(await resolveDerivedWorkerCwd({ fs, probeHome: async () => null })).toBeNull();
    expect(await resolveDerivedWorkerCwd({ fs: undefined, probeHome: async () => "~" })).toBeNull();
  });
});

describe("resolvePluginConfig", () => {
  const shared = JSON.stringify({
    baseUrl: "https://shared.example.test:5202",
    token: "shared-token",
    machine: "shared-machine",
  });

  it("prefers explicit Config values and skips the shared config entirely when nothing is missing", async () => {
    const source = sharedText(shared);
    const probeHostname = vi.fn(noProbe);
    const result = await resolvePluginConfig(explicit({
      baseUrl: "http://127.0.0.1:7428",
      token: "explicit-token",
      machine: "explicit-machine",
      workerCwd: "D:\\work",
    }), { readSharedConfigText: source.read, probeHostname, defaultWorkerCwd: "C:\\Users\\user" });

    expect(result).toEqual({
      ok: true,
      categories: [],
      config: {
        baseUrl: "http://127.0.0.1:7428",
        token: "explicit-token",
        machine: "explicit-machine",
        timeoutMs: 15_000,
        workerCwd: "D:\\work",
        reconcileOnStart: true,
        concurrency: 2,
      },
    });
    expect(source.calls.count).toBe(0);
    expect(probeHostname).not.toHaveBeenCalled();
  });

  it("resolves each missing field from the shared config independently", async () => {
    const source = sharedText(shared);
    const result = await resolvePluginConfig(
      explicit({ baseUrl: "http://127.0.0.1:7428", workerCwd: undefined }),
      { readSharedConfigText: source.read, probeHostname: noProbe, defaultWorkerCwd: "C:\\Users\\user" },
    );

    expect(result).toEqual({
      ok: true,
      categories: [],
      config: {
        baseUrl: "http://127.0.0.1:7428",
        token: "shared-token",
        machine: "shared-machine",
        timeoutMs: 15_000,
        workerCwd: "C:\\Users\\user",
        reconcileOnStart: true,
        concurrency: 2,
      },
    });
  });

  it("resolves machine from the hostname probe and caches it across resolutions", async () => {
    const source = sharedText(null, ["shared_config_unreadable"]);
    const probeHostname = createMemoizedProbe(async () => "WORKSTATION-B");
    const options = { readSharedConfigText: source.read, probeHostname, defaultWorkerCwd: undefined };

    const first = await resolvePluginConfig(explicit({ baseUrl: "http://hub.test", token: "t" }), options);
    const second = await resolvePluginConfig(explicit({ baseUrl: "http://hub.test", token: "t" }), options);

    expect(first).toMatchObject({ ok: true, config: { machine: "WORKSTATION-B" } });
    expect(second).toMatchObject({ ok: true, config: { machine: "WORKSTATION-B" } });
    expect(source.calls.count).toBe(2);
  });

  it("fails open with configuration_required when a required field cannot be resolved", async () => {
    const missing = await resolvePluginConfig(explicit({ baseUrl: "http://hub.test" }), {
      readSharedConfigText: sharedText(null, ["shared_config_unreadable"]).read,
      probeHostname: noProbe,
      defaultWorkerCwd: undefined,
    });
    expect(missing).toEqual({
      ok: false,
      category: "configuration_required",
      categories: ["shared_config_unreadable"],
    });

    const unparsable = await resolvePluginConfig(explicit(), {
      readSharedConfigText: sharedText("{ broken").read,
      probeHostname: noProbe,
      defaultWorkerCwd: undefined,
    });
    expect(unparsable).toEqual({
      ok: false,
      category: "configuration_required",
      categories: ["shared_config_invalid_json"],
    });

    const wrongTypes = await resolvePluginConfig(explicit(), {
      readSharedConfigText: sharedText(JSON.stringify({ baseUrl: 1, token: [], machine: null })).read,
      probeHostname: noProbe,
      defaultWorkerCwd: undefined,
    });
    expect(wrongTypes).toEqual({
      ok: false,
      category: "configuration_required",
      categories: [
        "shared_config_invalid_field:baseUrl",
        "shared_config_invalid_field:token",
        "shared_config_invalid_field:machine",
      ],
    });
  });

  it("keeps reader and probe failures fail-open instead of throwing", async () => {
    const result = await resolvePluginConfig(explicit(), {
      readSharedConfigText: async () => { throw new Error("reader exploded"); },
      probeHostname: async () => { throw new Error("probe exploded"); },
      defaultWorkerCwd: undefined,
    });
    expect(result).toEqual({
      ok: false,
      category: "configuration_required",
      categories: ["shared_config_unreadable"],
    });

    const probeOnly = await resolvePluginConfig(explicit({ baseUrl: "http://hub.test", token: "t" }), {
      readSharedConfigText: sharedText(null, ["shared_config_unreadable"]).read,
      probeHostname: async () => { throw new Error("probe exploded"); },
      defaultWorkerCwd: undefined,
    });
    expect(probeOnly).toEqual({
      ok: false,
      category: "configuration_required",
      categories: ["shared_config_unreadable"],
    });
  });

  it("never lets a shared token leak into the returned diagnostics", async () => {
    const result = await resolvePluginConfig(explicit(), {
      readSharedConfigText: sharedText(JSON.stringify({ baseUrl: "ftp://hub.test", token: "shared-secret" })).read,
      probeHostname: async () => "WORKSTATION-B",
      defaultWorkerCwd: undefined,
    });
    expect(JSON.stringify(result)).not.toContain("shared-secret");
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, uploadSession } from "../src/config.js";
import type { TransformedSession } from "../src/transform.js";

const temporaryDirectories: string[] = [];

function configFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "session-hub-hermes-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("prefers environment values over the existing skill config", () => {
    const path = configFile({ base_url: "https://file.example.test", token: "file-token" });
    expect(loadConfig({ SH_BASE_URL: "https://env.example.test/", SH_TOKEN: "env-token" }, path)).toEqual({
      baseUrl: "https://env.example.test",
      token: "env-token",
      timeoutMs: 15_000,
    });
  });

  it("fills a missing environment value from the skill config", () => {
    const path = configFile({ base_url: "https://file.example.test/", token: "file-token" });
    expect(loadConfig({ SH_BASE_URL: "https://env.example.test" }, path)).toEqual({
      baseUrl: "https://env.example.test",
      token: "file-token",
      timeoutMs: 15_000,
    });
  });

  it("returns null for incomplete or invalid configuration", () => {
    expect(loadConfig({}, join(tmpdir(), "missing-session-hub-config.json"))).toBeNull();
    expect(loadConfig({ SH_BASE_URL: "https://hub.example.test" }, join(tmpdir(), "missing-session-hub-config.json"))).toBeNull();
    expect(loadConfig({ SH_BASE_URL: "file:///bad", SH_TOKEN: "token" })).toBeNull();
  });
});

describe("uploadSession", () => {
  it("sends a bearer-authenticated PUT to the sessions endpoint", async () => {
    let observed: { method: string | undefined; authorization: string | undefined; body: string } | null = null;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observed = {
          method: request.method,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(201, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const payload: TransformedSession = {
        agent: "hermes",
        machine: "test-machine",
        source_id: "s1",
        created_at: 1,
        updated_at: 2,
        messages: [],
      };
      const result = await uploadSession(
        { baseUrl: `http://127.0.0.1:${address.port}`, token: "test-token", timeoutMs: 2_000 },
        payload,
      );
      expect(result).toEqual({ ok: true, status: 201 });
      expect(observed).toEqual({
        method: "PUT",
        authorization: "Bearer test-token",
        body: JSON.stringify(payload),
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

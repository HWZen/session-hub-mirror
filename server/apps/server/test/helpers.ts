import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDb, type SqliteDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { SessionRepository } from "../src/db/sessions.js";
import { SessionIndexer } from "../src/indexing.js";
import { EmbeddingRegistry, type EmbedProvider } from "../src/embedding/registry.js";
import { createFileSettingsStore } from "../src/settings-store.js";
import type { SettingsRouteDeps } from "../src/routes/settings.js";
import { createApp } from "../src/app.js";

export const TEST_TOKEN = "test-token-12345678";

export function makeDb(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "session-hub-test-"));
  const db = createDb(path.join(dir, "test.db"));
  migrate(db);
  return db;
}

export function hashVector(text: string, dims = 1024): Float32Array {
  const vector = new Float32Array(dims);
  let digest = createHash("sha256").update(text).digest();
  for (let i = 0; i < dims; i++) {
    if (i > 0 && i % digest.length === 0) digest = createHash("sha256").update(digest).digest();
    vector[i] = (digest[i % digest.length]! - 127.5) / 127.5;
  }
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dims; i++) vector[i] = vector[i]! / norm;
  return vector;
}

export class FakeEmbedProvider implements EmbedProvider {
  readonly kind = "fake" as const;
  cooldownUntil = 0;
  lastError: string | null = null;
  #calls = 0;

  constructor(readonly name = "fake") {}

  get priority(): number {
    return 1000;
  }

  get ready(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  get calls(): number {
    return this.#calls;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.#calls++;
    return texts.map((t) => hashVector(t));
  }

  reportSuccess(): void {}

  reportFailure(): void {}
}

export class FailingEmbedProvider implements EmbedProvider {
  readonly kind = "fake" as const;
  cooldownUntil = 0;
  lastError: string | null = null;
  #calls = 0;

  constructor(readonly name = "failing") {}

  get priority(): number {
    return 2000;
  }

  get ready(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  get calls(): number {
    return this.#calls;
  }

  async embed(): Promise<Float32Array[]> {
    this.#calls++;
    throw new Error("boom");
  }

  reportSuccess(): void {}

  reportFailure(message: string): void {
    this.cooldownUntil = Date.now() + 30_000;
    this.lastError = message;
  }
}

export class BadDimEmbedProvider implements EmbedProvider {
  readonly kind = "fake" as const;
  cooldownUntil = 0;
  lastError: string | null = null;

  constructor(readonly name = "bad-dim") {}

  get priority(): number {
    return 1500;
  }

  get ready(): boolean {
    return true;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(512));
  }

  reportSuccess(): void {}

  reportFailure(message: string): void {
    this.cooldownUntil = Date.now() + 30_000;
    this.lastError = message;
  }
}

export function buildApp(
  token: string = TEST_TOKEN,
  providers?: EmbedProvider[],
  webDist?: string,
  settings?: (parts: {
    registry: EmbeddingRegistry;
    repo: SessionRepository;
    indexer: SessionIndexer;
  }) => SettingsRouteDeps,
) {
  const db = makeDb();
  const repo = new SessionRepository(db);
  const registry = new EmbeddingRegistry(providers ?? [new FakeEmbedProvider("fake")]);
  const indexer = new SessionIndexer(db, repo, registry);
  const app = createApp({
    db,
    repo,
    indexer,
    registry,
    token,
    webDist,
    settings: settings?.({ registry, repo, indexer }),
  });
  return { app, db, repo, registry, indexer };
}

export function makeSettingsDeps(
  parts: { registry: EmbeddingRegistry; repo: SessionRepository; indexer: SessionIndexer },
  overrides: Partial<SettingsRouteDeps> = {},
): SettingsRouteDeps {
  const dir = mkdtempSync(path.join(tmpdir(), "session-hub-settings-"));
  const store = createFileSettingsStore(
    path.join(dir, "providers.local.json"),
    path.join(dir, "providers.fallback.json"),
  );
  return { store, registry: parts.registry, repo: parts.repo, indexer: parts.indexer, env: {}, localFallbackName: "local-cpu-bge-m3", ...overrides };
}

export function putSession(
  app: ReturnType<typeof buildApp>["app"],
  body: unknown,
  token: string = TEST_TOKEN,
): Promise<Response> {
  return app.request("/v1/sessions", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function postSearch(
  app: ReturnType<typeof buildApp>["app"],
  body: unknown,
  token: string = TEST_TOKEN,
): Promise<Response> {
  return app.request("/v1/search", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function sessionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "opencode",
    machine: "WORKSTATION-A",
    source_id: "s1",
    title: "first session",
    cwd: "D:/work",
    created_at: 1700000000000,
    updated_at: 1700000100000,
    messages: [
      { role: "user", text: "hello world", ts: 1700000000100 },
      { role: "assistant", text: "hi, here is the plan", ts: 1700000000200, raw: { tool: "bash", output: "ok" } },
    ],
    ...overrides,
  };
}

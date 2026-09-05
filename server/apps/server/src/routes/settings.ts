import { Hono } from "hono";
import { z } from "zod";
import { providerSettingsBodySchema } from "@session-hub/shared";
import { createRemoteProviders, type EmbeddingRegistry } from "../embedding/registry.js";
import type { SessionRepository } from "../db/sessions.js";
import type { SessionIndexer } from "../indexing.js";
import type { SettingsStore } from "../settings-store.js";

const REINDEX_BATCH = 200;

export interface SettingsRouteDeps {
  store: SettingsStore;
  registry: EmbeddingRegistry;
  repo: SessionRepository;
  indexer: SessionIndexer;
  env: NodeJS.ProcessEnv;
}

function maskKey(key: string): string {
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

export function settingsRoutes(deps: SettingsRouteDeps): Hono {
  const app = new Hono();

  app.get("/providers", (c) => {
    const { providers } = deps.store.load();
    const items = providers.map((p) => {
      const inline = typeof p.apiKey === "string" && p.apiKey !== "";
      const envKey = !inline && p.apiKeyEnv ? deps.env[p.apiKeyEnv] : undefined;
      return {
        name: p.name,
        baseUrl: p.baseUrl,
        apiKeyEnv: p.apiKeyEnv ?? null,
        weight: p.weight,
        enabled: p.enabled,
        timeoutMs: p.timeoutMs,
        keySource: inline ? ("inline" as const) : envKey ? ("env" as const) : ("none" as const),
        keyMasked: inline ? maskKey(p.apiKey as string) : null,
      };
    });
    return c.json({
      file: deps.store.activeFile(),
      providers: items,
    });
  });

  app.put("/providers", async (c) => {
    const read = await readJson(c);
    if (!read.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = providerSettingsBodySchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    const previous = new Map(deps.store.load().providers.map((p) => [p.name, p]));
    const merged = parsed.data.providers.map((p) => {
      const hasInlineKey = typeof p.apiKey === "string" && p.apiKey !== "";
      if (hasInlineKey) return p;
      const old = previous.get(p.name);
      return { ...p, apiKey: old?.apiKey };
    });
    deps.store.save(merged);
    deps.registry.replaceRemoteProviders(createRemoteProviders(merged, deps.env));
    return c.json({ ok: true, count: merged.length });
  });

  app.post("/providers/test", async (c) => {
    const read = await readJson(c);
    if (!read.ok) return c.json({ error: "invalid JSON body" }, 400);
    const parsed = z.object({ name: z.string().min(1) }).safeParse(read.body);
    if (!parsed.success) {
      return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
    }
    if (!deps.registry.hasProvider(parsed.data.name)) {
      return c.json({ error: "provider not found" }, 404);
    }
    return c.json(await deps.registry.testProvider(parsed.data.name));
  });

  app.post("/reindex", async (c) => {
    const sessions = deps.repo.listUnindexed(REINDEX_BATCH);
    let indexed = 0;
    for (const session of sessions) {
      if (await deps.indexer.indexSession(session.id)) indexed++;
    }
    const remaining = deps.repo.listUnindexed(1).length;
    return c.json({ total: sessions.length, indexed, failed: sessions.length - indexed, remaining });
  });

  return app;
}

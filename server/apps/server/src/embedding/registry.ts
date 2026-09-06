import type { EmbeddingProviderConfig, ProviderTestResult } from "@session-hub/shared";

const REMOTE_COOLDOWN_MS = 30_000;

export interface EmbedOutput {
  vectors: Float32Array[];
  provider: string;
  model: string;
}

export interface EmbedProvider {
  readonly name: string;
  readonly model: string;
  readonly kind: "remote" | "fake";
  readonly priority: number;
  readonly ready: boolean;
  readonly lastError: string | null;
  embed(texts: string[]): Promise<Float32Array[]>;
  reportSuccess(): void;
  reportFailure(message: string): void;
}

function embedUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export function parseOpenAIEmbeddings(body: unknown, expected: number): Float32Array[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`malformed embeddings response: expected ${expected} vectors`);
  }
  const slots = new Array<Float32Array | null>(expected).fill(null);
  let sawIndex = false;
  data.forEach((item, order) => {
    const rec = item as { index?: unknown; embedding?: unknown };
    const embedding = rec.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("malformed embeddings response: vector is not an array");
    }
    const vector = Float32Array.from(embedding as ArrayLike<number>);
    let index = order;
    if (typeof rec.index === "number" && Number.isInteger(rec.index)) {
      sawIndex = true;
      index = rec.index;
    }
    if (index < 0 || index >= expected) {
      throw new Error("malformed embeddings response: index out of range");
    }
    slots[index] = vector;
  });
  if (slots.some((v) => v === null)) {
    throw new Error("malformed embeddings response: missing vectors");
  }
  return slots.map((v) => v as Float32Array);
}

export class RemoteEmbedProvider implements EmbedProvider {
  readonly kind = "remote" as const;
  cooldownUntil = 0;
  lastError: string | null = null;

  constructor(
    readonly config: EmbeddingProviderConfig,
    private readonly apiKey: string | null,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get model(): string {
    return this.config.model;
  }

  get priority(): number {
    return this.config.weight;
  }

  get ready(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  reportSuccess(): void {
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  reportFailure(message: string): void {
    this.cooldownUntil = Date.now() + REMOTE_COOLDOWN_MS;
    this.lastError = message;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response: Response;
    try {
      response = await fetch(embedUrl(this.config.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new Error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    return parseOpenAIEmbeddings(body, texts.length);
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface RegistryStatusProvider {
  name: string;
  kind: "remote" | "fake";
  model: string;
  ready: boolean;
  lastError: string | null;
}

export interface RegistryStatus {
  current: string | null;
  model: string;
  providers: RegistryStatusProvider[];
}

export class EmbeddingRegistry {
  #current: string | null = null;
  #dims = new Map<string, number>();
  #remote: EmbedProvider[];
  #batchSize: number;

  constructor(remote: EmbedProvider[], batchSize = 32) {
    this.#remote = [...remote];
    this.#batchSize = Math.max(1, Math.floor(batchSize));
  }

  get providers(): EmbedProvider[] {
    return [...this.#remote];
  }

  replaceRemoteProviders(remote: EmbedProvider[]): void {
    this.#remote = [...remote];
  }

  hasProvider(name: string): boolean {
    return this.providers.some((p) => p.name === name);
  }

  activeModel(): string | null {
    const sorted = [...this.#remote].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    return sorted[0]?.model ?? null;
  }

  #establishedDim(model: string): number | undefined {
    return this.#dims.get(model);
  }

  #validateVectors(model: string, vectors: Float32Array[], expected: number): void {
    if (vectors.length !== expected) {
      throw new Error(`provider returned ${vectors.length} vectors, expected ${expected}`);
    }
    const dim = vectors[0]!.length;
    const established = this.#dims.get(model);
    if (established !== undefined && dim !== established) {
      throw new Error(`provider returned ${dim}-dim vector, model space established at ${established}-dim`);
    }
    for (const vector of vectors) {
      if (vector.length !== dim) {
        throw new Error(`provider returned inconsistent vector dims: ${vector.length} vs ${dim}`);
      }
    }
  }

  async testProvider(name: string): Promise<ProviderTestResult> {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider) {
      return { ok: false, latencyMs: null, dim: null, model: null, error: "provider not found" };
    }
    const start = Date.now();
    try {
      const vectors = await provider.embed(["session-hub embedding probe"]);
      this.#validateVectors(provider.model, vectors, 1);
      this.#dims.set(provider.model, vectors[0]!.length);
      provider.reportSuccess();
      return {
        ok: true,
        latencyMs: Date.now() - start,
        dim: vectors[0]!.length,
        model: provider.model,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        dim: null,
        model: provider.model,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async #embedBatched(provider: EmbedProvider, texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      const batch = texts.slice(start, start + this.#batchSize);
      vectors.push(...(await provider.embed(batch)));
    }
    return vectors;
  }

  async embed(texts: string[]): Promise<EmbedOutput> {
    const active = this.activeModel();
    if (texts.length === 0) {
      return { vectors: [], provider: this.#current ?? "none", model: active ?? "" };
    }
    if (active === null) {
      throw new EmbeddingUnavailableError("no embedding provider configured");
    }
    const failures: string[] = [];
    for (const provider of this.providers) {
      if (provider.model !== active) {
        failures.push(`${provider.name}: model mismatch (active ${active})`);
        continue;
      }
      if (!provider.ready) {
        failures.push(`${provider.name}: cooling down`);
        continue;
      }
      try {
        const vectors = await this.#embedBatched(provider, texts);
        this.#validateVectors(active, vectors, texts.length);
        if (this.#establishedDim(active) === undefined) {
          this.#dims.set(active, vectors[0]!.length);
        }
        provider.reportSuccess();
        this.#current = provider.name;
        return { vectors, provider: provider.name, model: active };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        provider.reportFailure(message);
        failures.push(`${provider.name}: ${message}`);
      }
    }
    throw new EmbeddingUnavailableError(`all embedding providers failed: ${failures.join("; ")}`);
  }

  status(): RegistryStatus {
    return {
      current: this.#current,
      model: this.activeModel() ?? "",
      providers: this.providers.map((p) => ({
        name: p.name,
        kind: p.kind,
        model: p.model,
        ready: p.ready,
        lastError: p.lastError,
      })),
    };
  }
}

export function createRemoteProviders(
  configs: ReadonlyArray<EmbeddingProviderConfig>,
  env: NodeJS.ProcessEnv,
): RemoteEmbedProvider[] {
  const enabled = configs.filter((c) => c.enabled);
  enabled.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  return enabled.map((config) => {
    let apiKey: string | null = config.apiKey ?? null;
    if (!apiKey && config.apiKeyEnv) {
      apiKey = env[config.apiKeyEnv] ?? null;
    }
    return new RemoteEmbedProvider(config, apiKey);
  });
}

export function createRegistry(
  configs: ReadonlyArray<EmbeddingProviderConfig>,
  env: NodeJS.ProcessEnv,
): EmbeddingRegistry {
  return new EmbeddingRegistry(createRemoteProviders(configs, env));
}

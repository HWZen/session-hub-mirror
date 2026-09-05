import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbeddingProviderConfig,
  type ProviderTestResult,
} from "@session-hub/shared";

const REMOTE_COOLDOWN_MS = 30_000;
const LOCAL_COOLDOWN_MS = 5 * 60_000;
const LOCAL_BATCH_SIZE = 8;
const LOCAL_MAX_CHARS = 12000;
const LOCAL_MODEL_REPO = "Xenova/bge-m3";

export interface EmbedOutput {
  vectors: Float32Array[];
  provider: string;
}

export interface EmbedProvider {
  readonly name: string;
  readonly kind: "remote" | "local" | "fake";
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
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
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

type FeatureExtractionPipeline = import("@huggingface/transformers").FeatureExtractionPipeline;

export class LocalEmbedProvider implements EmbedProvider {
  readonly kind = "local" as const;
  cooldownUntil = 0;
  lastError: string | null = null;
  #extractor: FeatureExtractionPipeline | null = null;
  #loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    readonly name: string,
    private readonly cacheDir: string,
    private readonly hub: { endpoint: string; pathTemplate: string },
  ) {}

  get priority(): number {
    return Number.NEGATIVE_INFINITY;
  }

  get ready(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  reportSuccess(): void {
    this.cooldownUntil = 0;
    this.lastError = null;
  }

  reportFailure(message: string): void {
    this.cooldownUntil = Date.now() + LOCAL_COOLDOWN_MS;
    this.lastError = message;
  }

  #getExtractor(): Promise<FeatureExtractionPipeline> {
    if (this.#extractor) return Promise.resolve(this.#extractor);
    if (!this.#loading) {
      this.#loading = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = this.cacheDir;
        env.remoteHost = this.hub.endpoint;
        env.remotePathTemplate = this.hub.pathTemplate;
        const extractor = await pipeline("feature-extraction", LOCAL_MODEL_REPO, {
          dtype: "fp32",
          device: "cpu",
        });
        this.#extractor = extractor;
        return extractor;
      })();
      this.#loading.catch(() => {
        this.#loading = null;
      });
    }
    return this.#loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.#getExtractor();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += LOCAL_BATCH_SIZE) {
      const batch = texts.slice(i, i + LOCAL_BATCH_SIZE).map((t) => t.slice(0, LOCAL_MAX_CHARS));
      const tensor = await extractor(batch, { pooling: "cls", normalize: true });
      const dims = tensor.dims;
      const dim = dims[dims.length - 1];
      if (typeof dim !== "number") throw new Error("unexpected tensor dims");
      const data = tensor.data as Float32Array;
      for (let j = 0; j < batch.length; j++) {
        out.push(data.slice(j * dim, (j + 1) * dim));
      }
    }
    return out;
  }
}

function validateVectors(vectors: Float32Array[], expected: number): void {
  if (vectors.length !== expected) {
    throw new Error(`provider returned ${vectors.length} vectors, expected ${expected}`);
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`provider returned ${vector.length}-dim vector, expected ${EMBEDDING_DIMENSIONS}`);
    }
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface RegistryStatus {
  current: string | null;
  model: string;
  providers: Array<{ name: string; kind: "remote" | "local" | "fake"; ready: boolean; lastError: string | null }>;
}

export class EmbeddingRegistry {
  #current: string | null = null;
  #remote: EmbedProvider[];

  constructor(remote: EmbedProvider[], private readonly local: EmbedProvider | null = null) {
    this.#remote = [...remote];
  }

  get providers(): EmbedProvider[] {
    return this.local ? [...this.#remote, this.local] : [...this.#remote];
  }

  replaceRemoteProviders(remote: EmbedProvider[]): void {
    this.#remote = [...remote];
  }

  hasProvider(name: string): boolean {
    return this.providers.some((p) => p.name === name);
  }

  async testProvider(name: string): Promise<ProviderTestResult> {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider) {
      return { ok: false, latencyMs: null, dim: null, error: "provider not found" };
    }
    const start = Date.now();
    try {
      const vectors = await provider.embed(["session-hub embedding probe"]);
      validateVectors(vectors, 1);
      provider.reportSuccess();
      return { ok: true, latencyMs: Date.now() - start, dim: vectors[0]!.length, error: null };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        dim: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async embed(texts: string[]): Promise<EmbedOutput> {
    if (texts.length === 0) {
      return { vectors: [], provider: this.#current ?? "none" };
    }
    const failures: string[] = [];
    for (const provider of this.providers) {
      if (!provider.ready) {
        failures.push(`${provider.name}: cooling down`);
        continue;
      }
      try {
        const vectors = await provider.embed(texts);
        validateVectors(vectors, texts.length);
        provider.reportSuccess();
        this.#current = provider.name;
        return { vectors, provider: provider.name };
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
      model: EMBEDDING_MODEL,
      providers: this.providers.map((p) => ({
        name: p.name,
        kind: p.kind,
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

export function createLocalEmbedProvider(
  localCacheDir: string,
  hub: { endpoint: string; pathTemplate: string },
): LocalEmbedProvider {
  return new LocalEmbedProvider("local-cpu-bge-m3", localCacheDir, hub);
}

export function createRegistry(
  configs: ReadonlyArray<EmbeddingProviderConfig>,
  env: NodeJS.ProcessEnv,
  localCacheDir: string,
  hub: { endpoint: string; pathTemplate: string },
): EmbeddingRegistry {
  return new EmbeddingRegistry(createRemoteProviders(configs, env), createLocalEmbedProvider(localCacheDir, hub));
}

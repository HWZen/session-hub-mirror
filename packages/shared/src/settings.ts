import { z } from "zod";
import { embeddingProviderConfigSchema } from "./embedding.js";

export const providerSettingsBodySchema = z.object({
  providers: z
    .array(embeddingProviderConfigSchema)
    .max(16)
    .refine((list) => new Set(list.map((p) => p.name)).size === list.length, {
      message: "provider names must be unique",
    }),
});

export type ProviderSettingsBody = z.infer<typeof providerSettingsBodySchema>;

export type ProviderKeySource = "inline" | "env" | "none";

export interface ProviderSettingsItem {
  name: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  weight: number;
  enabled: boolean;
  timeoutMs: number;
  keySource: ProviderKeySource;
  keyMasked: string | null;
}

export interface ProvidersSettingsResponse {
  file: string;
  providers: ProviderSettingsItem[];
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number | null;
  dim: number | null;
  error: string | null;
}

export interface ReindexResult {
  total: number;
  indexed: number;
  failed: number;
  remaining: number;
}

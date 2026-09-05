import { z } from "zod";

export const EMBEDDING_MODEL = "bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

export const embeddingProviderConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  weight: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
});

export const embeddingProvidersFileSchema = z.object({
  providers: z.array(embeddingProviderConfigSchema).max(16).default([]),
});

export type EmbeddingProviderConfig = z.infer<typeof embeddingProviderConfigSchema>;
export type ProvidersFile = z.infer<typeof embeddingProvidersFileSchema>;

import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { embeddingProvidersFileSchema, type ProvidersFile } from "@session-hub/shared";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(7428),
  HOST: z.string().min(1).default("127.0.0.1"),
  SH_DB_PATH: z.string().min(1),
  SH_AUTH_TOKEN: z.string().min(8),
  SH_PROVIDERS_FILE: z.string().min(1).default("./config/providers.json"),
  SH_PROVIDERS_LOCAL_FILE: z.string().min(1).default("./config/providers.local.json"),
  SH_WEB_DIST: z.string().default(""),
});

export type ServerEnv = z.infer<typeof envSchema>;

export const SERVER_ROOT = path.resolve(import.meta.dirname, "../../..");

export function resolveServerPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p);
}

function readServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8")) as {
      version?: string;
    };
    if (pkg.version) return pkg.version;
  } catch {
    // package.json unreadable
  }
  return "0.0.0";
}

export const SERVER_VERSION = readServerVersion();

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
    source = process.env;
  } catch {
    // no .env file
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid server environment: ${issues}`);
  }
  return parsed.data;
}

export function loadProvidersFile(path: string): ProvidersFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { providers: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`providers file is not valid JSON: ${path}`);
  }
  const parsed = embeddingProvidersFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`providers file invalid (${path}): ${issues}`);
  }
  return parsed.data;
}

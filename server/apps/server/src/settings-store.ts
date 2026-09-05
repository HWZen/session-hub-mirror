import { existsSync } from "node:fs";
import { renameSync, writeFileSync } from "node:fs";
import type { EmbeddingProviderConfig, ProvidersFile } from "@session-hub/shared";
import { loadProvidersFile } from "./config.js";

export interface SettingsStore {
  readonly localPath: string;
  readonly fallbackPath: string;
  activeFile(): string;
  load(): ProvidersFile;
  save(providers: EmbeddingProviderConfig[]): void;
}

export function createFileSettingsStore(localPath: string, fallbackPath: string): SettingsStore {
  return {
    localPath,
    fallbackPath,
    activeFile() {
      return existsSync(localPath) ? localPath : fallbackPath;
    },
    load() {
      return loadProvidersFile(this.activeFile());
    },
    save(providers: EmbeddingProviderConfig[]): void {
      const tmp = `${localPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
      renameSync(tmp, localPath);
    },
  };
}

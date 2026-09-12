import type { SessionRecord } from "@session-hub/shared";

export function buildSessionMetaHeader(meta: SessionRecord): string {
  return meta.title?.trim() ?? "";
}

import type { SessionRecord } from "@session-hub/shared";

function trimmed(value: string | null): string | null {
  const result = value?.trim() ?? "";
  return result === "" ? null : result;
}

export function buildSessionMetaHeader(meta: SessionRecord): string {
  const parts: string[] = [];
  const title = trimmed(meta.title);
  if (title !== null) parts.push(`标题=${title}`);
  parts.push(`Agent=${meta.agent}`, `机器=${meta.machine}`, `源会话ID=${meta.source_id}`);
  const cwd = trimmed(meta.cwd);
  if (cwd !== null) parts.push(`工作目录=${cwd}`);
  return `会话元数据：${parts.join("；")}`;
}

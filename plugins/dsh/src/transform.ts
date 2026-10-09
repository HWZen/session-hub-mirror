import type { DshHubMessage, DshHubSession, DshSessionEvent, DshSessionSnapshot } from "./types.js";

export const MAX_MESSAGES = 5_000;
export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_TITLE_LENGTH = 2_000;
export const MAX_CWD_LENGTH = 2_000;

export type TransformErrorCode =
  | "invalid_snapshot"
  | "invalid_event"
  | "non_contiguous_sequence"
  | "invalid_timestamp"
  | "too_many_messages"
  | "text_too_long"
  | "cwd_too_long"
  | "invalid_machine";

export class TransformError extends Error {
  readonly code: TransformErrorCode;
  readonly retryable = false;

  constructor(code: TransformErrorCode) {
    super(code);
    this.name = "TransformError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;
type RawPart = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function rawEvent(event: DshSessionEvent): RawPart {
  return { type: "dsh-event", event };
}

function reasoningPart(text: string): RawPart {
  return { type: "reasoning", text };
}

function headerPart(header: DshSessionSnapshot["header"]): RawPart {
  return { type: "dsh-header", header };
}

function visibleText(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  const content = record["content"];
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : [content];
  const pieces: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      pieces.push(block);
      continue;
    }
    const blockRecord = asRecord(block);
    if (blockRecord?.["type"] === "text" && typeof blockRecord["text"] === "string") {
      pieces.push(blockRecord["text"]);
    }
  }
  if (pieces.length === 0) return undefined;
  return pieces.join("\n\n");
}

interface ReasoningBlockState {
  rawDeltas: string[];
  packedTexts: string[];
  completeText?: string;
}

function collectReasoning(stream: unknown): string[] {
  if (!Array.isArray(stream)) return [];
  const blocks = new Map<number, ReasoningBlockState>();
  const ensureBlock = (index: number): ReasoningBlockState => {
    const current = blocks.get(index);
    if (current) return current;
    const created: ReasoningBlockState = { rawDeltas: [], packedTexts: [] };
    blocks.set(index, created);
    return created;
  };

  for (const entry of stream) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record["type"] === "reasoning-chunks") {
      const index = record["index"];
      const texts = record["texts"];
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(texts)) continue;
      const validTexts: string[] = [];
      let valid = true;
      for (const text of texts) {
        if (typeof text !== "string") {
          valid = false;
          break;
        }
        validTexts.push(text);
      }
      if (valid && validTexts.length > 0) ensureBlock(index).packedTexts.push(...validTexts);
      continue;
    }

    const chunk = record["type"] === "chunk" ? asRecord(record["chunk"]) : record;
    if (!chunk) continue;
    const index = chunk["index"];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
    if (chunk["type"] === "block-start" && chunk["blockType"] === "reasoning") {
      ensureBlock(index);
      continue;
    }
    if (chunk["type"] === "reasoning-delta" && typeof chunk["text"] === "string") {
      ensureBlock(index).rawDeltas.push(chunk["text"]);
      continue;
    }
    if (chunk["type"] === "block-end") {
      const block = asRecord(chunk["block"]);
      if (block?.["type"] !== "reasoning" || typeof block["text"] !== "string") continue;
      ensureBlock(index).completeText = block["text"];
    }
  }
  return [...blocks.values()]
    .map((state) => state.completeText ?? (state.packedTexts.length > 0
      ? state.packedTexts.join("")
      : state.rawDeltas.join("")))
    .filter((text) => text.trim() !== "");
}

function reasoningFor(event: DshSessionEvent): string[] {
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return [];
  const data = asRecord(event.data);
  return data ? collectReasoning(data["stream"]) : [];
}

function messageFromEvent(event: DshSessionEvent): DshHubMessage | null {
  let role: string;
  let message: unknown;
  switch (event.type) {
    case "user/message":
      role = "user";
      message = event.data;
      break;
    case "assistant/message":
      role = "assistant";
      message = asRecord(event.data)?.["message"];
      break;
    case "developer/message":
      role = "developer";
      message = asRecord(event.data)?.["message"];
      break;
    case "system/message":
      role = "system";
      message = asRecord(event.data)?.["message"];
      break;
    case "tool/result":
      role = "tool";
      message = asRecord(event.data)?.["message"];
      break;
    default:
      return null;
  }

  const raw: RawPart[] = [];
  const result: DshHubMessage = { role, ts: event.time, raw };
  if (role === "user" || role === "assistant") {
    const text = visibleText(message);
    if (text !== undefined) result.text = text;
  }
  raw.push(...reasoningFor(event).map(reasoningPart), rawEvent(event));
  return result;
}

function titleFromEvent(event: DshSessionEvent): string | undefined {
  if (event.type !== "session/title") return undefined;
  if (typeof event.data === "string") return event.data;
  const data = asRecord(event.data);
  return typeof data?.["title"] === "string" ? data["title"] : undefined;
}

function validateSnapshot(snapshot: DshSessionSnapshot): void {
  if (!snapshot || !snapshot.header || typeof snapshot.header.id !== "string" || snapshot.header.id.length === 0) {
    throw new TransformError("invalid_snapshot");
  }
  if (!Number.isSafeInteger(snapshot.header.createdAt) || snapshot.header.createdAt < 0 || !Array.isArray(snapshot.events)) {
    throw new TransformError("invalid_snapshot");
  }
  let previousSeq = -1;
  for (const event of snapshot.events) {
    if (!event || typeof event.type !== "string" || event.type.length === 0 || !Number.isSafeInteger(event.seq)) {
      throw new TransformError("invalid_event");
    }
    if (event.seq !== previousSeq + 1) throw new TransformError("non_contiguous_sequence");
    if (!Number.isSafeInteger(event.time) || event.time < 0) throw new TransformError("invalid_timestamp");
    previousSeq = event.seq;
  }
  const expectedLast = snapshot.events.length === 0 ? -1 : previousSeq;
  if (snapshot.lastSeq !== expectedLast) throw new TransformError("invalid_snapshot");
}

export function transformSession(snapshot: DshSessionSnapshot, machine: string): DshHubSession {
  validateSnapshot(snapshot);
  if (!machine.trim() || machine.length > 128) throw new TransformError("invalid_machine");
  if (snapshot.header.id.length > 256) throw new TransformError("invalid_snapshot");

  let title: string | undefined;
  const messages: DshHubMessage[] = [];
  let pendingEvents: DshSessionEvent[] = [];
  let pendingReasoning: string[] = [];
  let pendingReasoningTime: number | undefined;

  for (const event of snapshot.events) {
    const candidateTitle = titleFromEvent(event);
    if (candidateTitle !== undefined && candidateTitle.trim() !== "" && candidateTitle.length <= MAX_TITLE_LENGTH) {
      title = candidateTitle;
    }

    const message = messageFromEvent(event);
    if (message) {
      if (pendingReasoning.length > 0 && message.role !== "assistant") {
        const raw: RawPart[] = [];
        if (messages.length === 0) raw.push(headerPart(snapshot.header));
        raw.push(...pendingEvents.map(rawEvent), ...pendingReasoning.map(reasoningPart));
        const synthetic: DshHubMessage = { role: "assistant", text: "", raw };
        if (pendingReasoningTime !== undefined) synthetic.ts = pendingReasoningTime;
        messages.push(synthetic);
        pendingEvents = [];
        pendingReasoning = [];
        pendingReasoningTime = undefined;
      }

      const prefix: RawPart[] = [];
      if (messages.length === 0) prefix.push(headerPart(snapshot.header));
      prefix.push(...pendingEvents.map(rawEvent));
      if (message.role === "assistant") prefix.push(...pendingReasoning.map(reasoningPart));
      (message.raw as RawPart[]).unshift(...prefix);
      pendingEvents = [];
      if (message.role === "assistant") {
        pendingReasoning = [];
        pendingReasoningTime = undefined;
      }
      messages.push(message);
      continue;
    }

    pendingEvents.push(event);
    if (event.type === "assistant/attempt") {
      const reasoning = reasoningFor(event);
      if (reasoning.length > 0) {
        pendingReasoning.push(...reasoning);
        pendingReasoningTime = event.time;
      }
    }
  }

  if (pendingReasoning.length > 0) {
    const raw: RawPart[] = [];
    if (messages.length === 0) raw.push(headerPart(snapshot.header));
    raw.push(...pendingEvents.map(rawEvent), ...pendingReasoning.map(reasoningPart));
    const synthetic: DshHubMessage = { role: "assistant", text: "", raw };
    if (pendingReasoningTime !== undefined) synthetic.ts = pendingReasoningTime;
    messages.push(synthetic);
  } else if (pendingEvents.length > 0) {
    if (messages.length > 0) {
      (messages[messages.length - 1]!.raw as RawPart[]).push(...pendingEvents.map(rawEvent));
    } else {
      messages.push({ role: "event", raw: [headerPart(snapshot.header), ...pendingEvents.map(rawEvent)] });
    }
  } else if (messages.length === 0) {
    messages.push({ role: "event", raw: [headerPart(snapshot.header)] });
  }

  if (messages.length > MAX_MESSAGES) throw new TransformError("too_many_messages");
  for (const message of messages) {
    if (message.text !== undefined && message.text.length > MAX_TEXT_LENGTH) {
      throw new TransformError("text_too_long");
    }
  }

  const cwd = snapshot.header.cwd;
  if (cwd !== undefined && cwd.length > MAX_CWD_LENGTH) throw new TransformError("cwd_too_long");
  const updatedAt = snapshot.events.length === 0
    ? snapshot.header.createdAt
    : snapshot.events[snapshot.events.length - 1]!.time;
  const payload: DshHubSession = {
    agent: "dsh",
    machine: machine.trim(),
    source_id: snapshot.header.id,
    created_at: snapshot.header.createdAt,
    updated_at: updatedAt,
    messages,
  };
  payload.title = title ?? `DSH session ${snapshot.header.id}`;
  if (typeof cwd === "string" && cwd.length > 0) payload.cwd = cwd;
  return payload;
}

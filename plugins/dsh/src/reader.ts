import type {
  DshLiveSession,
  DshPersistenceListEntry,
  DshPersistenceReadHandle,
  DshSessionEvent,
  DshSessionPersistence,
  DshSessionSnapshot,
  DshSessionsService,
} from "./types.js";

export type SnapshotReadErrorCode =
  | "invalid_id"
  | "invalid_header"
  | "invalid_event"
  | "non_contiguous_sequence"
  | "snapshot_behind_required_sequence"
  | "invalid_list_entry";

export class SnapshotReadError extends Error {
  readonly code: SnapshotReadErrorCode;
  readonly retryable: boolean;

  constructor(code: SnapshotReadErrorCode, retryable = false) {
    super(code);
    this.name = "SnapshotReadError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateHeader(id: string, value: unknown): asserts value is DshPersistenceListEntry["header"] {
  if (!isRecord(value)
    || value["id"] !== id
    || typeof value["createdAt"] !== "number"
    || !Number.isSafeInteger(value["createdAt"])
    || value["createdAt"] < 0
    || (value["cwd"] !== undefined && typeof value["cwd"] !== "string")) {
    throw new SnapshotReadError("invalid_header");
  }
}

function validateEvents(value: unknown): asserts value is readonly DshSessionEvent[] {
  if (!Array.isArray(value)) throw new SnapshotReadError("invalid_event");
  for (let index = 0; index < value.length; index += 1) {
    const event: unknown = value[index];
    if (!isRecord(event)
      || typeof event["type"] !== "string"
      || event["type"].length === 0
      || event["seq"] !== index
      || typeof event["seq"] !== "number"
      || !Number.isSafeInteger(event["seq"])
      || typeof event["time"] !== "number"
      || !Number.isSafeInteger(event["time"])
      || event["time"] < 0
      || !Object.hasOwn(event, "data")
      || event["data"] === undefined
      || (event["ignorable"] !== undefined && event["ignorable"] !== true)) {
      if (isRecord(event) && event["seq"] !== index) {
        throw new SnapshotReadError("non_contiguous_sequence");
      }
      throw new SnapshotReadError("invalid_event");
    }
  }
}

async function closeHandle(handle: DshPersistenceReadHandle): Promise<void> {
  await handle.close();
}

export async function listSessionIds(persistence: DshSessionPersistence): Promise<string[]> {
  const entries = await persistence.list();
  if (!Array.isArray(entries)) throw new SnapshotReadError("invalid_list_entry");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry["header"])) {
      throw new SnapshotReadError("invalid_list_entry");
    }
    const id = entry["header"]["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new SnapshotReadError("invalid_list_entry");
    }
    validateHeader(id, entry["header"]);
    ids.add(id);
  }
  return [...ids].sort();
}

export async function readSessionSnapshot(
  persistence: DshSessionPersistence,
  sessions: DshSessionsService,
  id: string,
  requiredSeq = -1,
  liveSession?: DshLiveSession,
): Promise<DshSessionSnapshot> {
  if (!id || typeof id !== "string") throw new SnapshotReadError("invalid_id");
  const session = liveSession ?? sessions.get(id);
  if (session) await sessions.flush(session);

  const handle = await persistence.open(id, "read");
  let header: unknown;
  let events: unknown;
  try {
    header = handle.header;
    const readResult = await handle.read();
    events = readResult?.events;
  } finally {
    await closeHandle(handle);
  }

  validateHeader(id, header);
  validateEvents(events);
  const lastSeq = events.length === 0 ? -1 : events[events.length - 1]!.seq;
  if (lastSeq < requiredSeq) {
    throw new SnapshotReadError("snapshot_behind_required_sequence", true);
  }
  return { header, events, lastSeq };
}

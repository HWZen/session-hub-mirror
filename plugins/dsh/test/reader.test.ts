import { describe, expect, it } from "vitest";
import { listSessionIds, readSessionSnapshot, SnapshotReadError } from "../src/reader.js";
import type { DshPersistenceListEntry, DshSessionEvent, DshSessionHeader, DshSessionPersistence, DshSessionsService } from "../src/types.js";

const header: DshSessionHeader = { id: "session-1", createdAt: 1_700_000_000_000 };
const events: DshSessionEvent[] = [
  { type: "user/message", seq: 0, time: 1_700_000_000_100, data: { content: "hi" } },
  { type: "turn/end", seq: 1, time: 1_700_000_000_200, data: {} },
];

describe("readSessionSnapshot", () => {
  it("flushes a live session before read-open and closes the handle", async () => {
    const order: string[] = [];
    const live = { id: header.id };
    const sessions: DshSessionsService = {
      get: () => live,
      flush: async (session) => {
        expect(session).toBe(live);
        order.push("flush");
        return true;
      },
    };
    const persistence: DshSessionPersistence = {
      list: async () => [],
      open: async (id, access) => {
        expect(id).toBe(header.id);
        expect(access).toBe("read");
        order.push("open");
        return {
          header,
          read: async () => {
            order.push("read");
            return { events };
          },
          close: () => {
            order.push("close");
          },
        };
      },
    };

    const snapshot = await readSessionSnapshot(persistence, sessions, header.id, 1);

    expect(order).toEqual(["flush", "open", "read", "close"]);
    expect(snapshot).toEqual({ header, events, lastSeq: 1 });
  });

  it("reads cold sessions without flushing and retries a stale snapshot only after closing", async () => {
    const order: string[] = [];
    const sessions: DshSessionsService = {
      get: () => undefined,
      flush: async () => {
        order.push("flush");
        return true;
      },
    };
    const persistence: DshSessionPersistence = {
      list: async () => [],
      open: async () => ({
        header,
        read: async () => {
          order.push("read");
          return { events: [events[0]!] };
        },
        close: () => {
          order.push("close");
        },
      }),
    };

    await expect(readSessionSnapshot(persistence, sessions, header.id, 1))
      .rejects.toMatchObject({ code: "snapshot_behind_required_sequence", retryable: true });
    expect(order).toEqual(["read", "close"]);
  });

  it("rejects invalid sequence/envelopes and still closes the handle", async () => {
    let closed = false;
    const sessions: DshSessionsService = { get: () => undefined, flush: async () => true };
    const persistence: DshSessionPersistence = {
      list: async () => [],
      open: async () => ({
        header,
        read: async () => ({ events: [{ ...events[1]!, seq: 3 }] }),
        close: () => { closed = true; },
      }),
    };
    await expect(readSessionSnapshot(persistence, sessions, header.id))
      .rejects.toBeInstanceOf(SnapshotReadError);
    expect(closed).toBe(true);
  });
});

describe("listSessionIds", () => {
  it("returns unique sorted ids from header snapshots", async () => {
    const entries: DshPersistenceListEntry[] = [
      { header: { id: "z", createdAt: 1 } },
      { header: { id: "a", createdAt: 2 } },
      { header: { id: "z", createdAt: 1 } },
    ];
    const persistence: DshSessionPersistence = {
      list: async () => entries,
      open: async () => { throw new Error("unused"); },
    };
    expect(await listSessionIds(persistence)).toEqual(["a", "z"]);
  });

  it("rejects invalid list entries", async () => {
    const persistence = {
      list: async () => [{ header: { id: "", createdAt: 0 } }],
      open: async () => { throw new Error("unused"); },
    } as unknown as DshSessionPersistence;
    await expect(listSessionIds(persistence)).rejects.toMatchObject({ code: "invalid_list_entry" });
  });
});

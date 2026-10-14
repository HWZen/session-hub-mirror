import { describe, expect, it } from "vitest";
import { mapV2Messages, readAllSessionMessages, readStableSessionSnapshot } from "../src/adapter-v2.js";
import { transformSession } from "../src/plugin.js";

describe("OpenCode V2 full-history pagination", () => {
  it("reads ascending pages through cursor.next until the empty page without reshaping messages", async () => {
    const first = {
      id: "msg_first",
      type: "user",
      time: { created: 1700000000000 },
      text: "question",
      files: [{ type: "file", uri: "file:///mock.txt", mime: "text/plain" }],
    };
    const second = {
      id: "msg_second",
      type: "assistant",
      time: { created: 1700000001000 },
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "tool", callID: "call-1", tool: "mock", state: { status: "completed", input: {}, content: [] } },
      ],
    };
    const third = { id: "msg_third", type: "compaction", summary: "compressed", time: { created: 1700000002000 } };
    const pages = [
      { data: [first, second], cursor: { previous: "before", next: "cursor-2" } },
      { data: [third], cursor: { next: "cursor-3" } },
      { data: [], cursor: {} },
    ];
    const calls: unknown[] = [];
    const api = {
      message: {
        list: async (input: unknown) => {
          calls.push(input);
          const page = pages.shift();
          if (!page) throw new Error("unexpected page request");
          return page;
        },
      },
    };

    const result = await readAllSessionMessages(api as never, "ses_mock");

    expect(calls).toEqual([
      { sessionID: "ses_mock", limit: 200, order: "asc" },
      { sessionID: "ses_mock", cursor: "cursor-2" },
      { sessionID: "ses_mock", cursor: "cursor-3" },
    ]);
    expect(result).toEqual([first, second, third]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
    expect(result[2]).toBe(third);
  });

  it("stops when a non-empty page has no cursor or repeats a cursor", async () => {
    const message = { id: "msg_a", type: "user", time: { created: 1 }, text: "hi" };
    const noNext = { message: { list: async () => ({ data: [message], cursor: {} }) } };
    await expect(readAllSessionMessages(noNext as never, "ses_mock")).rejects.toThrow(/空页/);

    const repeat = [
      { data: [message], cursor: { next: "again" } },
      { data: [{ ...message, id: "msg_b" }], cursor: { next: "again" } },
    ];
    const repeatApi = {
      message: {
        list: async () => {
          const page = repeat.shift();
          if (!page) throw new Error("unexpected page request");
          return page;
        },
      },
    };
    await expect(readAllSessionMessages(repeatApi as never, "ses_mock")).rejects.toThrow(/游标重复/);
  });

  it("stops when a repeated message id indicates overlapping pages", async () => {
    const message = { id: "msg_a", type: "user", time: { created: 1 }, text: "hi" };
    const pages = [
      { data: [message], cursor: { next: "n1" } },
      { data: [{ ...message }], cursor: { next: "n2" } },
    ];
    const api = {
      message: {
        list: async () => {
          const page = pages.shift();
          if (!page) throw new Error("unexpected page request");
          return page;
        },
      },
    };
    await expect(readAllSessionMessages(api as never, "ses_mock")).rejects.toThrow(/重复消息/);
  });

  it("retries instead of returning a history read across a session update", async () => {
    const snapshots = [
      { id: "ses_mock", time: { created: 10, updated: 20 }, title: "old", location: { directory: "/mock" } },
      { id: "ses_mock", time: { created: 10, updated: 21 }, title: "new", location: { directory: "/mock" } },
      { id: "ses_mock", time: { created: 10, updated: 21 }, title: "new", location: { directory: "/mock" } },
      { id: "ses_mock", time: { created: 10, updated: 21 }, title: "new", location: { directory: "/mock" } },
    ];
    const stale = { id: "msg_stale", type: "user", text: "stale" };
    const current = { id: "msg_current", type: "user", text: "current" };
    const pages = [
      { data: [stale], cursor: { next: "stale-next" } },
      { data: [], cursor: {} },
      { data: [current], cursor: { next: "current-next" } },
      { data: [], cursor: {} },
    ];
    const api = {
      session: { get: async () => snapshots.shift() },
      message: {
        list: async () => {
          const page = pages.shift();
          if (!page) throw new Error("unexpected page request");
          return page;
        },
      },
    };

    const result = await readStableSessionSnapshot(api as never, "ses_mock");

    expect(result.session.time.updated).toBe(21);
    expect(result.session.title).toBe("new");
    expect(result.messages).toEqual([current]);
    expect(snapshots).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });
});

describe("OpenCode V2 message mapping", () => {
  const user = {
    id: "msg_user",
    type: "user",
    time: { created: 100 },
    text: "question",
    files: [{ type: "file", uri: "file:///mock.txt", mime: "text/plain" }],
  };
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 200, completed: 250 },
    agent: "mock-agent",
    model: { providerID: "mock", id: "mock-model" },
    content: [
      { type: "text", text: "answer" },
      { type: "reasoning", text: "reasoning text" },
      {
        type: "tool",
        id: "part_tool",
        name: "mock.tool",
        state: { status: "completed", input: { key: "value" }, content: [{ type: "text", text: "tool result" }] },
        time: { created: 220, completed: 240 },
      },
    ],
    finish: "stop",
    providerState: { raw: "preserved" },
  };
  const synthetic = { id: "msg_synthetic", type: "synthetic", time: { created: 260 }, text: "hidden note" };
  const system = { id: "msg_system", type: "system", time: { created: 280 }, text: "system note" };
  const skill = { id: "msg_skill", type: "skill", time: { created: 290 }, skill: "mock", name: "mock skill", text: "skill body" };
  const shell = {
    id: "msg_shell",
    type: "shell",
    time: { created: 300, completed: 310 },
    shellID: "sh_1",
    command: "echo hi",
    status: "exited",
    exit: 0,
    output: { output: "cmd out", cursor: 0, size: 7, truncated: false },
  };
  const compaction = {
    id: "msg_compaction",
    type: "compaction",
    time: { created: 320 },
    status: "completed",
    reason: "auto",
    summary: "summary text",
    recent: "recent text",
  };
  const idle = { id: "msg_idle", type: "idle", time: { created: 340 }, outcome: "succeeded" };
  const agentSwitched = { id: "msg_agent", type: "agent-switched", time: { created: 360 }, agent: "build" };
  const modelSwitched = { id: "msg_model", type: "model-switched", time: { created: 380 }, model: { providerID: "mock", id: "mock-model" } };
  const locationSwitched = { id: "msg_location", type: "location-switched", time: { created: 390 }, location: { directory: "/other" } };
  const sourceMessages = [
    user,
    assistant,
    synthetic,
    system,
    skill,
    shell,
    compaction,
    idle,
    agentSwitched,
    modelSwitched,
    locationSwitched,
  ];

  it("keeps every source kind, role and the complete V2 envelope while exposing text and reasoning parts", () => {
    const mapped = mapV2Messages(sourceMessages as never[]);
    const payload = transformSession(
      { id: "ses_mock", title: "mock", directory: "/mock", time_created: 1, time_updated: 2 },
      mapped,
      "M1",
    );

    const expectedRoles = [
      "user",
      "assistant",
      "synthetic",
      "system",
      "skill",
      "shell",
      "compaction",
      "idle",
      "agent-switched",
      "model-switched",
      "location-switched",
    ];
    expect(mapped.map((message) => message.role)).toEqual(expectedRoles);
    expect(payload.messages.map((message) => message.role)).toEqual(expectedRoles);
    expect(payload.messages).toHaveLength(sourceMessages.length);

    expect(payload.messages[0]?.text).toBe("question");
    expect(payload.messages[0]?.raw).toEqual([
      { type: "text", text: "question" },
      { type: "opencode-v2-envelope", version: "2.0.26", message: user },
    ]);

    expect(payload.messages[1]?.text).toBe("answer");
    expect(payload.messages[1]?.ts).toBe(200);
    expect(payload.messages[1]?.raw).toEqual([
      ...assistant.content,
      { type: "opencode-v2-envelope", version: "2.0.26", message: assistant },
    ]);

    expect("text" in (payload.messages[2] ?? {})).toBe(false);
    expect(payload.messages[2]?.raw).toEqual([
      { type: "text", text: "hidden note", synthetic: true },
      { type: "opencode-v2-envelope", version: "2.0.26", message: synthetic },
    ]);

    expect(payload.messages[3]?.text).toBe("system note");
    expect(payload.messages[4]?.text).toBe("skill body");
    expect(payload.messages[5]?.text).toBe("cmd out");

    expect(payload.messages[6]?.text).toBe("summary text\n\nrecent text");
    expect(payload.messages[6]?.raw).toEqual([
      { type: "text", text: "summary text" },
      { type: "text", text: "recent text" },
      { type: "opencode-v2-envelope", version: "2.0.26", message: compaction },
    ]);

    expect("text" in (payload.messages[7] ?? {})).toBe(false);
    expect(payload.messages[7]?.raw).toEqual({ type: "opencode-v2-envelope", version: "2.0.26", message: idle });

    for (const index of [8, 9, 10]) {
      expect("text" in (payload.messages[index] ?? {})).toBe(false);
      expect(payload.messages[index]?.raw).toEqual({
        type: "opencode-v2-envelope",
        version: "2.0.26",
        message: sourceMessages[index],
      });
    }
  });

  it("preserves unknown future kinds under a length-checked role instead of dropping them", () => {
    const future = { id: "msg_future", type: "future-kind", time: { created: 1 } };
    const mapped = mapV2Messages([future] as never[]);
    expect(mapped[0]?.role).toBe("future-kind");
    expect(Object.keys(mapped[0] ?? {}).sort()).toEqual(["parts", "role", "time_created"]);
    expect(mapped[0]?.parts).toEqual([{ type: "opencode-v2-envelope", version: "2.0.26", message: future }]);
  });
});

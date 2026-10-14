import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

export const fixtureSession: SessionInfo = {
  id: "ses_loopback",
  projectID: "proj_loopback",
  title: "Synthetic history",
  location: { directory: "D:/synthetic-project" },
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  cost: 0,
  tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
};

export function historyFixture(): SessionMessageInfo[] {
  const messages: SessionMessageInfo[] = Array.from({ length: 201 }, (_, index) => ({
    id: `msg_${String(201 - index).padStart(4, "0")}`,
    type: "user",
    text: `Synthetic question ${index}`,
    time: { created: fixtureSession.time.created + index },
    metadata: { syntheticFixture: true, sequence: index },
  }));
  messages.push({
    id: "msg_assistant",
    type: "assistant",
    agent: "synthetic-agent",
    model: { providerID: "loopback", id: "synthetic-model" },
    time: { created: fixtureSession.time.created + 300, completed: fixtureSession.time.created + 400 },
    finish: "stop",
    metadata: { syntheticFixture: true },
    content: [
      { type: "text", text: "Synthetic answer 中文" },
      { type: "reasoning", text: "Synthetic reasoning 中文" },
      {
        type: "tool", id: "tool_synthetic", name: "synthetic-tool",
        time: { created: fixtureSession.time.created + 310, completed: fixtureSession.time.created + 350 },
        state: {
          status: "completed", input: { synthetic: true },
          content: [{ type: "text", text: "Synthetic tool result" }],
          metadata: { syntheticFixture: true },
        },
      },
    ],
  });
  messages.push({
    id: "msg_compaction", type: "compaction", status: "completed", reason: "auto",
    time: { created: fixtureSession.time.created + 500 },
    summary: "Synthetic compressed summary", recent: "Synthetic recent context",
  });
  messages.push({
    id: "msg_synthetic", type: "synthetic", text: "Synthetic hidden note",
    time: { created: fixtureSession.time.created + 600 },
  });
  return messages;
}

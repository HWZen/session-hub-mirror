import { describe, expect, it } from "vitest";
import { FakeEmbedProvider, TEST_TOKEN, buildApp, putSession, sessionBody } from "./helpers.js";

class RecordingEmbedProvider extends FakeEmbedProvider {
  inputs: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.inputs.push(texts);
    return super.embed(texts);
  }
}

describe("SessionIndexer chunk numbering", () => {
  it("gives distinct chunk_no to multiple reasoning parts of the same message", async () => {
    const { app, db, repo, settleIndexing } = buildApp();
    const res = await putSession(
      app,
      sessionBody({
        source_id: "multi-reasoning",
        messages: [
          {
            role: "assistant",
            text: "visible answer",
            ts: 1,
            raw: [
              { type: "reasoning", text: "first hidden thought" },
              { type: "reasoning", text: "second hidden thought" },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await settleIndexing();

    const chunks = db
      .prepare("SELECT source, chunk_no FROM message_chunks ORDER BY source, chunk_no")
      .all() as Array<{ source: string; chunk_no: number }>;
    expect(chunks).toHaveLength(3);
    expect(chunks.filter((c) => c.source === "text").map((c) => c.chunk_no)).toEqual([0]);
    expect(chunks.filter((c) => c.source === "reasoning").map((c) => c.chunk_no)).toEqual([0, 1]);
    expect(repo.get(id)!.indexed_at).not.toBeNull();
  });
});

describe("SessionIndexer session meta header", () => {
  it("prepends the meta header only to the first chunk's embedding input, storing raw chunk texts", async () => {
    const provider = new RecordingEmbedProvider("fake");
    const { app, db, settleIndexing } = buildApp(TEST_TOKEN, [provider]);
    const longText = Array.from({ length: 80 }, (_, i) => `line ${i} of a long first message`).join("\n");
    await putSession(
      app,
      sessionBody({
        machine: "M-16",
        source_id: "meta-first",
        title: "release notes",
        cwd: "D:/work/app",
        messages: [{ role: "user", text: longText, ts: 1 }],
      }),
    );
    await settleIndexing();

    expect(provider.inputs).toHaveLength(1);
    const inputs = provider.inputs[0]!;
    expect(inputs.length).toBeGreaterThan(1);
    const header = "会话元数据：标题=release notes；Agent=opencode；机器=M-16；源会话ID=meta-first；工作目录=D:/work/app";
    for (const input of inputs.slice(1)) {
      expect(input.startsWith("会话元数据：")).toBe(false);
    }

    const chunks = db
      .prepare("SELECT text FROM message_chunks ORDER BY id")
      .all() as Array<{ text: string }>;
    expect(chunks.length).toBe(inputs.length);
    expect(inputs[0]).toBe(`${header}\n${chunks[0]!.text}`);
    for (const chunk of chunks) {
      expect(chunk.text.includes("会话元数据：")).toBe(false);
    }
  });
});

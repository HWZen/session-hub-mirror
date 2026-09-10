import { describe, expect, it } from "vitest";
import { buildApp, putSession, sessionBody } from "./helpers.js";

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

export const durablePackedDshLlmProviderReasoningStream = [
  { type: "chunk", time: 100, chunk: { type: "block-start", index: 4, blockType: "reasoning" } },
  { type: "reasoning-chunks", time0: 100, index: 4, dt: [25], texts: ["durable ", "packed"] },
] as const;

export const deltaOnlyDshLlmProviderReasoningStream = [
  { type: "reasoning-delta", index: 9, text: "delta-only " },
  { type: "chunk", time: 125, chunk: { type: "reasoning-delta", index: 9, text: "interrupted" } },
] as const;

export const durableBlockEndOverrideDshLlmProviderReasoningStream = [
  { type: "reasoning-chunks", time0: 200, index: 3, dt: [], texts: ["accumulated delta"] },
  { type: "chunk", time: 250, chunk: {
    type: "block-end",
    index: 3,
    block: { type: "reasoning", text: "complete reasoning" },
  } },
] as const;

export const rawDshLlmProviderReasoningStream = [
  { type: "block-start", index: 0, blockType: "reasoning" },
  { type: "reasoning-delta", index: 0, text: "raw partial" },
  { type: "block-end", index: 0, block: { type: "reasoning", text: "raw completed" } },
] as const;

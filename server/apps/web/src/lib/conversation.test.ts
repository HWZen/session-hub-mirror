import { describe, expect, it } from "vitest";
import { filterConversationMessages, isConversationMessage } from "./conversation";

describe("isConversationMessage", () => {
  it("保留有正文的 user 与 assistant", () => {
    expect(isConversationMessage({ role: "user", text: "你好" })).toBe(true);
    expect(isConversationMessage({ role: "assistant", text: "world" })).toBe(true);
  });

  it("仅白名单 role 进入对话视图", () => {
    for (const role of ["system", "synthetic", "idle", "tool", "unknown-future-role"]) {
      expect(isConversationMessage({ role, text: "有正文" })).toBe(false);
    }
  });

  it("空串、纯空白与缺失文本一律排除", () => {
    for (const text of ["", "   ", "\n\t", undefined, null]) {
      expect(isConversationMessage({ role: "user", text })).toBe(false);
      expect(isConversationMessage({ role: "assistant", text })).toBe(false);
    }
  });

  it("正文两侧空白不裁剪，只判定非空", () => {
    expect(isConversationMessage({ role: "assistant", text: "  x  " })).toBe(true);
  });
});

describe("filterConversationMessages", () => {
  it("混合序列过滤后仅剩用户内容与助手正文，原顺序与字段保留", () => {
    const messages = [
      { idx: 0, role: "system", text: "46KB 系统提示词", raw: { kind: "system" } },
      { idx: 1, role: "user", text: "问题", raw: { kind: "user" } },
      { idx: 2, role: "assistant", text: "", raw: { kind: "step" } },
      { idx: 3, role: "assistant", text: "正文回答", raw: { kind: "text" } },
      { idx: 4, role: "synthetic", text: "AGENTS.md 注入块" },
      { idx: 5, role: "assistant", text: "   ", raw: { kind: "step" } },
      { idx: 6, role: "idle", text: "轮次结束" },
      { idx: 7, role: "user", text: "继续", raw: { kind: "user" } },
    ];
    const filtered = filterConversationMessages(messages);
    expect(filtered.map((m) => m.idx)).toEqual([1, 3, 7]);
    expect(filtered[1]).toBe(messages[3]);
    expect(filtered[1]!.raw).toEqual({ kind: "text" });
  });

  it("全部被过滤时返回空数组", () => {
    const messages = [
      { idx: 0, role: "system", text: "s" },
      { idx: 1, role: "assistant", text: " " },
    ];
    expect(filterConversationMessages(messages)).toEqual([]);
  });
});

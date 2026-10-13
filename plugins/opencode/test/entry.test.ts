import { describe, expect, it, vi } from "vitest";

const hooks = { event: vi.fn(), dispose: vi.fn() };
const v1 = vi.hoisted(() => vi.fn());
vi.mock("../src/plugin.js", async (original) => ({
  ...await original<typeof import("../src/plugin.js")>(),
  sessionHubPlugin: v1,
}));

import * as entry from "../src/entry.js";

describe("single dual-support entry", () => {
  it("exports only a default object with stable id and V2 setup", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(entry.default).toMatchObject({ id: "session-hub", setup: expect.any(Function), server: expect.any(Function) });
  });

  it("delegates V1 input and options unchanged and returns the existing hooks", async () => {
    v1.mockResolvedValueOnce(hooks);
    const input = { client: {} };
    const options = { marker: "unchanged" };
    const plugin = entry.default as unknown as { server: (...args: unknown[]) => Promise<unknown> };
    expect(await plugin.server(input, options)).toBe(hooks);
    expect(v1).toHaveBeenCalledWith(input, options);
  });
});

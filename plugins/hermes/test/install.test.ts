import { describe, expect, it } from "vitest";
import { mergeAllowlist, updateConfigYaml } from "../scripts/install.mjs";

const COMMAND = 'node "D:/session-hub/plugins/hermes/dist/hook.js" --profile "C:/Users/test/profiles/dev"';

describe("Hermes hook installer configuration", () => {
  it("adds a single managed block when hooks are not configured and is idempotent", () => {
    const source = "model: {}\n# hooks:\n";
    const result = updateConfigYaml(source, COMMAND);
    expect((result.match(/^hooks:/gm) ?? [])).toHaveLength(1);
    expect(result).toContain("post_api_request:");
    expect(result).toContain("on_session_reset:");
    expect(updateConfigYaml(result, COMMAND)).toBe(result);
  });

  it("preserves existing shell hooks and converts an empty hooks map", () => {
    const source = "hooks:\n  post_tool_call:\n    - command: 'logger'\nagent: {}\n";
    const result = updateConfigYaml(source, COMMAND);
    expect(result).toContain("command: 'logger'");
    expect(result).toContain("agent: {}");
    expect(updateConfigYaml(result, COMMAND)).toBe(result);
    expect(updateConfigYaml("hooks: {}\nagent: {}\n", COMMAND)).toContain("  post_api_request:");
  });

  it("adds each event-command approval once and preserves existing approvals", () => {
    const existing = JSON.stringify({ approvals: [{ event: "existing", command: "keep" }] });
    const approval = { event: "post_api_request", command: COMMAND };
    const result = mergeAllowlist(existing, [approval, approval]);
    expect(JSON.parse(result).approvals).toEqual([
      { event: "existing", command: "keep" },
      approval,
    ]);
    expect(mergeAllowlist(result, [approval])).toBe(result);
  });
});

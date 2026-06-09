/**
 * ee_query builtin tool — the in-CLI counterpart of the MCP `ee.query` tool.
 *
 * Session d95113d3be09: the Agent Operating Contract + checkpoint reminders
 * instruct the agent to "Use the ee_query tool with 'tool-artifact id=XXX'" to
 * rehydrate compaction-elided outputs, but the in-CLI agent had no such tool —
 * a dead reference. This verifies the tool now exists in the agent toolset, is
 * absent from non-agent modes, and degrades gracefully on a malformed call
 * (no network).
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown) => Promise<unknown> | unknown;
}

describe("ee_query builtin tool", () => {
  it("is registered in agent mode", () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    expect(tools.ee_query).toBeDefined();
    expect((tools.ee_query as ToolWithExecute).execute).toBeTypeOf("function");
  });

  it("is NOT registered in non-agent modes (plan/ask)", () => {
    expect(createBuiltinTools(new BashTool(os.tmpdir()), "plan").ee_query).toBeUndefined();
    expect(createBuiltinTools(new BashTool(os.tmpdir()), "ask").ee_query).toBeUndefined();
  });

  it("returns a corrective error for an empty query (no network)", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const t = tools.ee_query as ToolWithExecute;
    const out = String(await t.execute?.({ query: "  " }));
    expect(out).toMatch(/ERROR/);
    expect(out).toMatch(/query/i);
  });
});

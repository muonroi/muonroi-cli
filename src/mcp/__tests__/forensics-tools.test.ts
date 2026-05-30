import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { CostForensicsSummary } from "../../cli/cost-forensics.js";
import { registerForensicsTools } from "../forensics-tools.js";

function collectTools(register: (s: McpServer) => void) {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const fake = {
    registerTool(name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  register(fake);
  return handlers;
}
function parse(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}

const fakeSummary = (id: string): CostForensicsSummary =>
  ({
    sessionId: id,
    rowCount: 1,
    userPromptCount: 1,
    toolCallCount: 0,
    totalInput: 100,
    totalOutput: 50,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalCostUsd: 0.01,
    cacheHitRatio: 0,
    peakSingleCallInput: 100,
    events: [],
  }) as CostForensicsSummary;

describe("forensics-tools", () => {
  it("usage.forensics returns the summary for a unique prefix", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => ["sess123"], collect: (id) => fakeSummary(id) }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "sess" }));
    expect(out.isError).toBeFalsy();
    expect(out.json.sessionId).toBe("sess123");
    expect(out.json.peakSingleCallInput).toBe(100);
  });

  it("usage.forensics returns not_found for zero matches", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => [], collect: () => fakeSummary("x") }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "nope" }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("not_found");
  });

  it("usage.forensics returns ambiguous for multiple matches", async () => {
    const handlers = collectTools((s) =>
      registerForensicsTools(s, { resolve: () => ["a1", "a2"], collect: () => fakeSummary("a1") }),
    );
    const out = parse(await handlers["usage.forensics"]!({ prefix: "a" }));
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ambiguous");
    expect(out.json.matches).toEqual(["a1", "a2"]);
  });
});

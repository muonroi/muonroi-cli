import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { NATIVE_MUONROI_TOOL_NAMES, registerNativeMuonroiTools } from "../native-tools.js";

async function exec(tools: ToolSet, name: string, args: unknown): Promise<string> {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return (await tool.execute(args, {})) as string;
}

describe("registerNativeMuonroiTools", () => {
  it("registers every muonroi-tools capability as a native builtin", () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    for (const name of NATIVE_MUONROI_TOOL_NAMES) {
      expect(tools[name], `missing native tool ${name}`).toBeDefined();
      expect(typeof (tools[name] as { execute?: unknown }).execute).toBe("function");
    }
    // ee_query stays the registry's own native tool — not duplicated here.
    expect(tools.ee_query).toBeUndefined();
  });

  it("setup_guide returns the shared guide text (no MCP round-trip)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "setup_guide", {});
    expect(out).toContain("muonroi-cli Setup Guide");
    expect(out).toContain("muonroi-cli doctor");
  });

  it("ee_feedback rejects a noise verdict with no reason (no network call)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "ee_feedback", { id: "abc", collection: "experience-behavioral", verdict: "noise" });
    expect(out).toMatch(/reason_required/);
  });

  it("ee_feedback validates required args", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "ee_feedback", { verdict: "followed" })).toMatch(/invalid_args/);
  });

  it("selfverify_status returns not_found for an unknown runId (shared JobManager)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "selfverify_status", { runId: "does-not-exist" });
    expect(out).toMatch(/not_found/);
  });

  it("selfverify_start rejects agentic mode without goal+llm", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "selfverify_start", { mode: "agentic" })).toMatch(/invalid_args/);
  });

  it("usage_forensics rejects an empty prefix without touching the DB", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "usage_forensics", { prefix: "  " })).toMatch(/invalid_args/);
  });
});

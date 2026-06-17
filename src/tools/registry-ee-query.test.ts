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
import { afterEach, describe, expect, it } from "vitest";
import { __resetArtifactCacheForTests, recordArtifact } from "../ee/artifact-cache.js";
import { __resetSessionExperienceForTests, getSessionExperience } from "../orchestrator/session-experience.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools, isToolArtifactQuery } from "./registry.js";

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

describe("isToolArtifactQuery — ee_query intent routing", () => {
  it("matches tool-artifact / full-tool-result id lookups (→ /api/search)", () => {
    expect(isToolArtifactQuery("tool-artifact id=abc123")).toBe(true);
    expect(isToolArtifactQuery("full tool result id=9f2c")).toBe(true);
    expect(isToolArtifactQuery("rehydrate the TOOL-ARTIFACT  ID = xyz")).toBe(true);
  });

  it("does NOT match general recall queries (→ /api/recall)", () => {
    expect(isToolArtifactQuery("recent compaction checkpoint Progress DONE")).toBe(false);
    expect(isToolArtifactQuery("how do we restart the experience-engine server")).toBe(false);
    // "id=" alone, without the artifact phrase, is not an artifact lookup.
    expect(isToolArtifactQuery("what is the user id=field convention")).toBe(false);
    // The artifact phrase without an id= is also not an exact lookup.
    expect(isToolArtifactQuery("tool-artifact storage design")).toBe(false);
  });
});

describe("ee_query — anti-mù rehydrate (local-first, durable when EE is down)", () => {
  afterEach(() => {
    __resetArtifactCacheForTests();
    __resetSessionExperienceForTests();
  });

  it("rehydrates a tool-artifact from the in-session cache with NO EE/network call", async () => {
    // Simulates: the compactor elided this output earlier (recordArtifact), EE is
    // now down. The agent's ee_query("tool-artifact id=X") must still return the
    // full content from the local cache rather than an [ee_unavailable] note.
    recordArtifact("call_42", "read_file", "FULL ELIDED CONTENT — line A\nline B\nline C");
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const t = tools.ee_query as ToolWithExecute;

    const out = String(await t.execute?.({ query: "tool-artifact id=call_42" }));

    expect(out).toContain("rehydrated from in-session cache");
    expect(out).toContain("tool=read_file");
    expect(out).toContain("FULL ELIDED CONTENT");
    expect(out).not.toMatch(/ee_unavailable/);
    // Lived-experience telemetry recorded the cache-sourced rehydrate.
    expect(getSessionExperience().rehydrations.cache).toBe(1);
  });
});

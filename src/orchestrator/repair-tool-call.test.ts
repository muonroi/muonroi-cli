/**
 * Regression for the tool-NAME repair added after session 47b3a8a546ca, where
 * a model called the native builtin `ee_feedback` under the Anthropic MCP
 * convention name `mcp__muonroi-tools__ee_feedback` (double-underscore prefix)
 * → NoSuchToolError → 5× "unavailable tool" failures per the recall-ledger nag.
 *
 * The hook strips the MCP namespace back to the bare registered name so the
 * call executes, WITHOUT ever touching a legitimate MCP-only tool.
 */
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { recoverArgsFromToolName, repairToolCallHook, resolveToolName } from "./repair-tool-call.js";

const REGISTERED = new Set(["ee_feedback", "ee_query", "usage_forensics", "grep", "read"]);

describe("resolveToolName", () => {
  it("strips the double-underscore Anthropic MCP prefix onto a bare native tool", () => {
    expect(resolveToolName("mcp__muonroi-tools__ee_feedback", REGISTERED)).toBe("ee_feedback");
  });

  it("strips the single-underscore muonroi MCP prefix (mcp_<server>__<tool>)", () => {
    expect(resolveToolName("mcp_muonroi-tools__ee_query", REGISTERED)).toBe("ee_query");
  });

  it("returns null when the name is already a valid registered tool", () => {
    expect(resolveToolName("ee_feedback", REGISTERED)).toBeNull();
  });

  it("returns null for a non-MCP-prefixed unknown name (does not guess)", () => {
    expect(resolveToolName("totally_unknown", REGISTERED)).toBeNull();
  });

  it("leaves a legitimate MCP-only tool untouched (bare name not registered)", () => {
    // `docs_search` is a real MCP tool with no native twin — must NOT rewrite.
    expect(resolveToolName("mcp__muonroi-docs__docs_search", REGISTERED)).toBeNull();
  });

  it("handles a bare tool name that itself contains underscores", () => {
    expect(resolveToolName("mcp__muonroi-tools__usage_forensics", REGISTERED)).toBe("usage_forensics");
  });

  it("returns null when mcp-prefixed but no __ separator present", () => {
    expect(resolveToolName("mcp_ee_feedback", REGISTERED)).toBeNull();
  });
});

const call = (toolName: string, input: string): LanguageModelV3ToolCall => ({
  type: "tool-call",
  toolCallId: "call-1",
  toolName,
  input,
});

describe("repairToolCallHook — tool-name repair", () => {
  const tools = { ee_feedback: {}, grep: {} } as Record<string, unknown>;

  it("rewrites the hallucinated MCP-prefixed name and preserves valid args", async () => {
    const out = await repairToolCallHook({
      toolCall: call("mcp__muonroi-tools__ee_feedback", '{"id":"abc","collection":"c","verdict":"followed"}'),
      tools,
    });
    expect(out).not.toBeNull();
    expect(out?.toolName).toBe("ee_feedback");
    // Valid args round-trip unchanged.
    expect(JSON.parse(out?.input as string)).toEqual({
      id: "abc",
      collection: "c",
      verdict: "followed",
    });
  });

  it("repairs both name AND malformed args in one pass", async () => {
    const out = await repairToolCallHook({
      // trailing native-format leak + extra brace, plus prefixed name.
      toolCall: call("mcp__muonroi-tools__ee_feedback", '{"id":"abc"}}\n</tool_call>'),
      tools,
    });
    expect(out?.toolName).toBe("ee_feedback");
    expect(JSON.parse(out?.input as string)).toEqual({ id: "abc" });
  });

  it("returns null when the name is valid and args are already valid (nothing to fix)", async () => {
    const out = await repairToolCallHook({
      toolCall: call("ee_feedback", '{"id":"abc"}'),
      tools,
    });
    expect(out).toBeNull();
  });

  it("returns null when tools is absent and args are valid", async () => {
    const out = await repairToolCallHook({
      toolCall: call("mcp__muonroi-tools__ee_feedback", '{"id":"abc"}'),
    });
    expect(out).toBeNull();
  });
});

/**
 * Regression for session 2e5b1e80a4e6 — glm-4.7 on the Z.ai coding endpoint.
 * The model leaked its own chat-template markup as content
 * (`<tool_call>read_file file_path="README.md"</arg_value>`); Z.ai's server-side
 * parser then returned ONE tool call whose `function.name` was that whole blob
 * and whose `arguments` was `{}`. All three calls that turn died as
 * NoSuchToolError, so the turn printed free text and did no work — even though
 * both the tool and its argument were fully recoverable from the garbage name.
 */
describe("mangled tool name (provider swallowed the leaked markup)", () => {
  const REG = new Set(["read_file", "ee_query", "grep"]);

  it("resolves the leading identifier out of a name carrying inline args + a stray close tag", () => {
    expect(resolveToolName('read_file file_path="README.md"</arg_value>', REG)).toBe("read_file");
    expect(
      resolveToolName('ee_query collection="experience-principles" query="project overview"</arg_value>', REG),
    ).toBe("ee_query");
  });

  it("does NOT rewrite a genuinely unknown tool name", () => {
    expect(resolveToolName("some_unknown_tool", REG)).toBeNull();
    expect(resolveToolName('unknown_tool arg="x"', REG)).toBeNull();
  });

  it("leaves an already-registered name alone even when it contains a dash", () => {
    expect(resolveToolName("read_file", REG)).toBeNull();
  });

  it("recovers the swallowed args when the provider sent an empty arguments object", async () => {
    const out = await repairToolCallHook({
      toolCall: call('read_file file_path="README.md"</arg_value>', "{}"),
      tools: { read_file: {}, ee_query: {} },
    });
    expect(out?.toolName).toBe("read_file");
    expect(JSON.parse(String(out?.input))).toEqual({ file_path: "README.md" });
  });

  it("never overrides arguments the model actually supplied", async () => {
    const out = await repairToolCallHook({
      toolCall: call('read_file file_path="README.md"', '{"file_path":"package.json"}'),
      tools: { read_file: {} },
    });
    expect(out?.toolName).toBe("read_file");
    expect(JSON.parse(String(out?.input))).toEqual({ file_path: "package.json" });
  });
});

describe("recoverArgsFromToolName", () => {
  it("parses double- and single-quoted pairs, and returns null when there are none", () => {
    expect(recoverArgsFromToolName("read_file file_path=\"a.ts\" mode='r'")).toEqual({
      file_path: "a.ts",
      mode: "r",
    });
    expect(recoverArgsFromToolName("read_file")).toBeNull();
  });
});

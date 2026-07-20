/**
 * src/orchestrator/repair-tool-call.ts
 *
 * AI SDK 6 hook adapter for tool-call repair. Plugs into
 * `streamText({ repairToolCall, ... })` — AI SDK invokes the hook on BOTH
 * NoSuchToolError (unknown tool name) and InvalidToolInputError (bad args)
 * BEFORE emitting tool-error, so a successful repair lets the tool execute
 * normally instead of bubbling up as a failure that triggers the
 * tool-repetition detector.
 *
 * Two independent repairs:
 *
 *   (A) Tool-NAME repair — a model trained on the Anthropic MCP convention
 *       (`mcp__<server>__<tool>`) sometimes calls a NATIVE builtin using that
 *       prefixed name. muonroi-cli exposes ee_query / ee_feedback / ee_write /
 *       usage_forensics / lsp_query / selfverify_* as bare native builtins
 *       (src/tools/native-tools.ts), NOT via MCP — so `mcp__muonroi-tools__
 *       ee_feedback` is NoSuchToolError. Stripping the MCP namespace lands on
 *       the real bare tool, so we rewrite the name and the call executes.
 *       Without this, the EE recall-ledger keeps re-nagging the model to rate
 *       an entry, the model keeps emitting the same prefixed name, and every
 *       turn burns a failed tool call (observed: session 47b3a8a546ca — 5×
 *       `mcp__muonroi-tools__ee_feedback` "unavailable tool").
 *
 *   (B) Tool-ARGS repair — conservative recovery of malformed argument JSON
 *       emitted by models whose tokenization breaks structured JSON (first
 *       observed on Qwen3-30B via SiliconFlow). See tool-args-repair.ts.
 *
 * Returns:
 *   - corrected ToolCall when a name and/or args repair applied
 *   - null when nothing could be repaired; AI SDK then re-throws the original
 *     error and tool-error fires (which our repetition detector still catches)
 *
 * Provider-agnostic by design — both repairs decide locally from the input
 * (tool name / args string) with no `if (providerId === ...)` branching.
 */

import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { repairToolCallArgs } from "./tool-args-repair.js";

/**
 * Resolve a hallucinated/mis-namespaced tool name to a real one in `available`.
 *
 * Only handles the observed failure mode: an MCP-prefixed name for a tool that
 * is actually a bare native builtin. muonroi-cli namespaces MCP tools as
 * `mcp_<server>__<tool>` (single underscore, src/mcp/runtime.ts), while models
 * default to the Anthropic `mcp__<server>__<tool>` (double). Either way the
 * bare tool name is the segment after the LAST `__`. We rewrite ONLY when that
 * bare name is a real registered tool, so a legitimate MCP-only tool (whose
 * bare name is NOT registered) is never touched.
 *
 * Returns the resolved bare name, or null when no safe rewrite applies (already
 * valid, not MCP-prefixed, or the stripped name is not registered).
 */
export function resolveToolName(toolName: string, available: ReadonlySet<string>): string | null {
  if (available.has(toolName)) return null; // already valid — nothing to do
  if (!toolName.startsWith("mcp_") || !toolName.includes("__")) return null;
  const bare = toolName.slice(toolName.lastIndexOf("__") + 2);
  if (bare && bare !== toolName && available.has(bare)) return bare;
  return null;
}

/**
 * AI SDK invokes this on NoSuchToolError / InvalidToolInputError before
 * tool-error fires. Returns a corrected LanguageModelV3ToolCall (repaired name
 * and/or repaired input) or null to fall through to the existing error path.
 *
 * `tools` is used for the name repair; the remaining AI SDK options
 * (inputSchema, system, messages, error) are accepted to match the signature
 * but ignored.
 */
export async function repairToolCallHook(args: {
  toolCall: LanguageModelV3ToolCall;
  tools?: Record<string, unknown>;
}): Promise<LanguageModelV3ToolCall | null> {
  const original = args.toolCall;

  // (A) Tool-NAME repair.
  let toolName = original.toolName;
  if (args.tools) {
    const resolved = resolveToolName(toolName, new Set(Object.keys(args.tools)));
    if (resolved) toolName = resolved;
  }
  const nameChanged = toolName !== original.toolName;

  // (B) Tool-ARGS repair (best-effort). Valid JSON takes the fast path
  // (transforms empty) and is left byte-for-byte alone; only actually-
  // transformed args produce a new serialization. Re-emitting identical args
  // is pointless — the hook only fires on error, so an unchanged args string
  // means the failure was the NAME, handled by (A).
  const rawInput = original.input;
  let repairedInput: string | null = null;
  if (typeof rawInput === "string" && rawInput.length > 0) {
    const result = repairToolCallArgs(rawInput);
    if (result.ok && result.transforms.length > 0) {
      try {
        repairedInput = JSON.stringify(result.value);
      } catch {
        repairedInput = null;
      }
    }
  }

  // Nothing to fix → fall through to the original error path.
  if (!nameChanged && repairedInput === null) return null;

  return {
    ...original,
    toolName,
    input: repairedInput ?? original.input,
  };
}

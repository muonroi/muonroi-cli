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
 *       The same repair also salvages a name the PROVIDER mangled: when a model
 *       leaks its chat-template markup as content, some endpoints parse it into
 *       one tool call whose `function.name` is the whole blob and whose
 *       `arguments` is `{}` (live: session 2e5b1e80a4e6, glm-4.7 on Z.ai coding
 *       → `read_file file_path="README.md"</arg_value>`). We recover both the
 *       leading tool name and the args swallowed alongside it.
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

  if (toolName.startsWith("mcp_") && toolName.includes("__")) {
    const bare = toolName.slice(toolName.lastIndexOf("__") + 2);
    if (bare && bare !== toolName && available.has(bare)) return bare;
    return null;
  }

  // Mangled name: the provider's own tool-call parser swallowed the model's
  // leaked chat-template markup into `function.name`.
  //
  // Live: session 2e5b1e80a4e6 — glm-4.7 on the Z.ai coding endpoint emitted
  // `<tool_call>read_file file_path="README.md"</arg_value>`, and Z.ai returned
  // it as ONE tool call named `read_file file_path="README.md"</arg_value>` with
  // `arguments: {}`. All three calls that turn died as NoSuchToolError, so the
  // turn produced free text and no work — even though the intended call was
  // fully recoverable from the garbage name.
  //
  // Precision: only fires when the raw name is NOT registered, the leading
  // identifier IS registered, and what follows is non-identifier junk (a space,
  // quote, or angle bracket). A legitimate unknown tool name is never rewritten.
  const lead = toolName.match(MANGLED_NAME_RE);
  if (lead?.[1] && available.has(lead[1])) return lead[1];
  return null;
}

/** Leading tool identifier followed by junk (whitespace / `<` / `"` / `=`). */
const MANGLED_NAME_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)[\s<"'=]/;

/** `k="v"` / `k='v'` pairs, as leaked inside a mangled tool name. */
const NAME_INLINE_ARG_RE = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*"([^"]*)"|([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*'([^']*)'/g;

/**
 * Recover arguments that the provider swallowed into the tool NAME.
 *
 * When Z.ai mangles `read_file file_path="README.md"` into the name, it also
 * emits `arguments: {}` — so repairing the name alone would run `read_file`
 * with no path and fail again. Returns the parsed pairs, or null when the name
 * carries none.
 */
export function recoverArgsFromToolName(toolName: string): Record<string, string> | null {
  NAME_INLINE_ARG_RE.lastIndex = 0;
  const args: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = NAME_INLINE_ARG_RE.exec(toolName)) !== null) {
    const k = m[1] ?? m[3];
    const v = m[2] ?? m[4];
    if (k) args[k] = (v ?? "").trim();
  }
  return Object.keys(args).length > 0 ? args : null;
}

/** True when the model supplied no usable arguments (missing / empty / `{}`). */
function hasNoUsableInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === "{}") return true;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
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

  // (A2) When the name was mangled, the args it swallowed are the ONLY copy —
  // the provider sent `arguments: {}` alongside it. Recover them, but never
  // override arguments the model actually supplied.
  let recoveredInput: string | null = null;
  if (nameChanged && hasNoUsableInput(original.input)) {
    const recovered = recoverArgsFromToolName(original.toolName);
    if (recovered) {
      try {
        recoveredInput = JSON.stringify(recovered);
      } catch {
        recoveredInput = null;
      }
    }
  }

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
  if (!nameChanged && repairedInput === null && recoveredInput === null) return null;

  return {
    ...original,
    toolName,
    input: recoveredInput ?? repairedInput ?? original.input,
  };
}

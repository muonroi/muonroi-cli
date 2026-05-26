/**
 * src/orchestrator/repair-tool-call.ts
 *
 * AI SDK 6 hook adapter for the conservative tool-args repair. Plugs into
 * `streamText({ repairToolCall, ... })` — AI SDK invokes the hook on
 * InvalidToolInputError BEFORE emitting tool-error, so a successful repair
 * lets the tool execute normally instead of bubbling up as a failure that
 * triggers the tool-repetition detector.
 *
 * Returns:
 *   - corrected ToolCall when repair produced valid JSON for the schema
 *   - null when repair failed; AI SDK then re-throws the original error
 *     and tool-error fires (which our repetition detector still catches)
 *
 * This is provider-agnostic by design — the malformed-JSON pattern has been
 * observed on Qwen3-30B-Instruct via SiliconFlow but the SAME repair would
 * apply to any model whose tokenization breaks structured JSON. No
 * `if (providerId === ...)` branching: the repair function decides locally
 * whether each transform applies based on the input string alone.
 */

import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { repairToolCallArgs } from "./tool-args-repair.js";

/**
 * AI SDK invokes this on InvalidToolInputError before tool-error fires.
 * Returns a corrected LanguageModelV3ToolCall (with input as the stringified
 * repaired JSON) or null to fall through to the existing error path.
 *
 * Only `toolCall` is consumed — other args (tools, inputSchema, system,
 * messages, error) are accepted to match AI SDK's signature but ignored.
 */
export async function repairToolCallHook(args: {
  toolCall: LanguageModelV3ToolCall;
}): Promise<LanguageModelV3ToolCall | null> {
  const original = args.toolCall;
  const rawInput = original.input;
  if (typeof rawInput !== "string" || rawInput.length === 0) return null;

  const result = repairToolCallArgs(rawInput);
  if (!result.ok) return null;

  let repairedInput: string;
  try {
    repairedInput = JSON.stringify(result.value);
  } catch {
    return null;
  }

  return {
    ...original,
    input: repairedInput,
  };
}

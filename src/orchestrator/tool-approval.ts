/**
 * Host-owned approval for the main agent's own tool calls (safe mode).
 *
 * WHY approval is decided INSIDE `execute` instead of via the AI SDK's
 * `needsApproval`: an SDK approval ends the streamText loop with a dangling
 * tool-call, and the SDK only executes it on the NEXT streamText call when the
 * history's last message is a `tool` message carrying the
 * `tool-approval-response` (ai@6 collectToolApprovals reads `messages.at(-1)`
 * only). The host resumed by starting a brand-new user turn — the UI injected
 * a synthetic "[Payment approved]" user message, inherited from the removed
 * x402 payment flow (e1101dde) — so the approval response was never last, the
 * read never ran, and the model saw a tool-call with no tool-result
 * (tests/harness/safe-mode-tool-approval.spec.ts, recorded prompt:
 * `assistant:[tool-call] | assistant:[text("[Task incomplete …")] |
 * user:"[Payment approved]"`). Deny sent nothing at all. Waiting for the human
 * inside `execute` keeps the SAME turn alive, so approve → the tool runs and
 * its result is in history; deny → a denial tool-result the model can act on.
 * Worker tools already work this way (worker-approval.ts gateWorkerTools).
 */

import { redactSecrets } from "../utils/logger.js";

export interface ToolApprovalAskInfo {
  toolCallId: string;
  toolName: string;
  /** Redacted, bounded JSON of the tool input — what the user is approving. */
  preview: string;
}

/**
 * `no-approver` is distinct from `deny` so the model is never told "the user
 * denied" when no human was ever asked (headless, or the TUI handler unset).
 */
export type ToolApprovalVerdict = "allow" | "deny" | "no-approver";

const PREVIEW_MAX_CHARS = 2_000;

export function buildToolApprovalInfo(
  toolName: string,
  input: unknown,
  toolCallId: string | undefined,
): ToolApprovalAskInfo {
  let encoded: string;
  try {
    encoded =
      JSON.stringify(input, (key, value) =>
        /secret|token|password|api.?key|authorization|cookie/i.test(key) ? "[REDACTED]" : value,
      ) ?? String(input);
  } catch (err) {
    encoded = `[unserializable input: ${(err as Error)?.message ?? String(err)}]`;
  }
  const redacted = redactSecrets(encoded);
  const preview =
    redacted.length > PREVIEW_MAX_CHARS
      ? `${redacted.slice(0, PREVIEW_MAX_CHARS)}… (${redacted.length - PREVIEW_MAX_CHARS} more chars)`
      : redacted;
  return { toolCallId: toolCallId ?? "", toolName, preview };
}

/** Tool-result text the model receives when the user (or a missing UI) denies the call. */
export function toolApprovalDeniedResult(toolName: string, verdict: Exclude<ToolApprovalVerdict, "allow">): string {
  const why =
    verdict === "deny"
      ? "The user denied this tool call"
      : "This tool call needs user approval (safe mode) but no approval decision could be obtained (no interactive approver, or the turn was cancelled)";
  return `${why}: ${toolName} did not run and returned no data. Continue without it, or explain to the user what you need and why.`;
}

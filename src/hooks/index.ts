/**
 * Hook dispatcher — routes PreToolUse / PostToolUse events through the
 * Experience Engine HTTP client at localhost:8082.
 *
 * Plan 00.06: src/hooks/executor.ts (shell-spawn approach) has been deleted.
 * This module is the new dispatcher. It preserves the original public function
 * signatures so call sites in the orchestrator do not change.
 *
 * Shell-spawn was:
 *   spawn("sh", ["-c", hook.command], ...)  — broken on Windows without WSL.
 * HTTP client is:
 *   POST http://localhost:8082/api/intercept  — cross-platform, safe, auditable.
 *
 * Architecture: EE is optional. If EE is not running, all intercepts fall back
 * to { decision: "allow" } so the TUI is never blocked by a missing EE process.
 */

// Re-export type-only items that callers may import from this module
export { getMatchingHooks, loadHooksConfig } from "./config.js";
export type {
  AggregatedHookResult,
  BaseHookInput,
  CommandHook,
  HookCommand,
  HookEvent,
  HookInput,
  HookMatcher,
  HookOutput,
  HookResult,
  HooksConfig,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./types.js";
export { getMatchQuery, HOOK_EVENTS, isHookEvent } from "./types.js";

import { intercept, posttool } from "../ee/index.js";
import type {
  AggregatedHookResult,
  HookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./types.js";

function emptyResult(): AggregatedHookResult {
  return {
    blocked: false,
    blockingErrors: [],
    preventContinuation: false,
    additionalContexts: [],
    results: [],
  };
}

/**
 * Dispatch a hook event to the EE HTTP client.
 *
 * - PreToolUse:  blocking intercept call → may return decision:block
 * - PostToolUse: fire-and-forget posttool call
 * - All other events: allow by default (Phase 1 EE-02+ extends this)
 *
 * Swallows all errors so hooks never crash the orchestrator.
 */
export async function executeEventHooks(
  input: HookInput,
  cwd: string,
  _signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  try {
    if (input.hook_event_name === "PreToolUse") {
      const r = await intercept({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd,
      });
      if (r.decision === "block") {
        return {
          blocked: true,
          blockingErrors: [{ command: "ee:intercept", stderr: r.reason ?? "ee-blocked" }],
          preventContinuation: true,
          stopReason: r.reason ?? "ee-blocked",
          additionalContexts: r.suggestions ?? [],
          decision: "block",
          results: [],
        };
      }
      return {
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: r.suggestions ?? [],
        decision: "approve",
        results: [],
      };
    }

    if (input.hook_event_name === "PostToolUse") {
      posttool({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        outcome: {
          // PostToolUse always means success — failure goes to PostToolUseFailure
          success: true,
        },
        cwd,
      });
      return emptyResult();
    }

    if (input.hook_event_name === "PostToolUseFailure") {
      const failInput = input as PostToolUseFailureHookInput;
      posttool({
        toolName: failInput.tool_name,
        toolInput: failInput.tool_input,
        outcome: {
          success: false,
          error: failInput.error,
        },
        cwd,
      });
      return emptyResult();
    }

    // All other event names: allow by default (Phase 1 EE-02+ extends coverage)
    return emptyResult();
  } catch {
    // EE errors must never crash the orchestrator
    return emptyResult();
  }
}

/**
 * Fire PreToolUse hooks. Returns the aggregated result which may block execution.
 */
export async function executePreToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}

/**
 * Fire PostToolUse hooks after a successful tool execution.
 */
export async function executePostToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: Record<string, unknown>,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PostToolUseHookInput = {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}

/**
 * Fire PostToolUseFailure hooks after a tool execution fails.
 */
export async function executePostToolFailureHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  error: string,
  cwd: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  const input: PostToolUseFailureHookInput = {
    hook_event_name: "PostToolUseFailure",
    tool_name: toolName,
    tool_input: toolInput,
    error,
    session_id: sessionId,
    cwd,
  };
  return executeEventHooks(input, cwd, signal);
}

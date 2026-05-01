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

import { interceptWithDefaults } from "../ee/intercept.js";
import { type JudgeContext } from "../ee/judge.js";
import { posttool } from "../ee/posttool.js";
import { reconcilePromptStale } from "../ee/prompt-stale.js";
import { buildScope } from "../ee/scope.js";
import type { InterceptResponse, Scope } from "../ee/types.js";
import type {
  AggregatedHookResult,
  HookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./types.js";

// Cached scope for posttool calls (computed once at first use)
let _cachedScope: Scope | null = null;

// Latch: stores the last PreToolUse warning response so PostToolUse can build judgeCtx.
// Follows the _cachedScope module-level variable pattern.
let _lastWarningResponse: InterceptResponse | null = null;

/** Reset hook module state — for test teardown only. */
export function resetHookState(): void {
  _lastWarningResponse = null;
  _cachedScope = null;
}

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
      const r = await interceptWithDefaults({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd,
      });
      // Thread the warning response to PostToolUse via module-level latch
      _lastWarningResponse = r;
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
      if (!_cachedScope) _cachedScope = await buildScope({ cwd });
      const judgeCtx: JudgeContext = {
        warningResponse: _lastWarningResponse,
        toolName: input.tool_name,
        outcome: { success: true },
        cwdMatchedAtPretool: _lastWarningResponse !== null,
        diffPresent: false,
        tenantId: "local",
      };
      _lastWarningResponse = null; // reset after use — prevents cross-turn contamination
      await posttool(
        {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          outcome: {
            // PostToolUse always means success — failure goes to PostToolUseFailure
            success: true,
          },
          cwd,
          tenantId: "local",
          scope: _cachedScope,
        },
        judgeCtx,
      );
      // STALE-02/STALE-03: fire-and-forget per-turn prompt-stale reconciliation
      reconcilePromptStale(cwd); // void — does not block (B-4)
      return emptyResult();
    }

    if (input.hook_event_name === "PostToolUseFailure") {
      const failInput = input as PostToolUseFailureHookInput;
      if (!_cachedScope) _cachedScope = await buildScope({ cwd });
      const judgeCtx: JudgeContext = {
        warningResponse: _lastWarningResponse,
        toolName: failInput.tool_name,
        outcome: { success: false, error: failInput.error },
        cwdMatchedAtPretool: _lastWarningResponse !== null,
        diffPresent: false,
        tenantId: "local",
      };
      _lastWarningResponse = null; // reset after use — prevents cross-turn contamination
      await posttool(
        {
          toolName: failInput.tool_name,
          toolInput: failInput.tool_input,
          outcome: {
            success: false,
            error: failInput.error,
          },
          cwd,
          tenantId: "local",
          scope: _cachedScope,
        },
        judgeCtx,
      );
      // STALE-02/STALE-03: fire-and-forget per-turn prompt-stale reconciliation
      reconcilePromptStale(cwd); // void — does not block (B-4)
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

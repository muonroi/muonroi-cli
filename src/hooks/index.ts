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
  EEMatchEntry,
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
import { type JudgeContext, judge } from "../ee/judge.js";
import { getMistakeDetector } from "../ee/mistake-detector.js";
import * as phaseTracker from "../ee/phase-tracker.js";
import { posttool } from "../ee/posttool.js";
import { reconcilePromptStale } from "../ee/prompt-stale.js";
import { getRenderSink, setRenderSink } from "../ee/render.js";
import { buildScope } from "../ee/scope.js";
import { fireTrajectoryEvent } from "../ee/session-trajectory.js";
import { getTenantId } from "../ee/tenant.js";
import type { InterceptResponse, PostToolOutcome, Scope } from "../ee/types.js";
import { logInteraction } from "../storage/interaction-log.js";
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

// Fix 2: throttle recall-feedback reminder to once per unique pending-set.
// Tracks the sha of pending IDs so identical reminders don't repeat on every tool call.
let _lastRecallReminderSha: string | null = null;

/** Reset hook module state — for test teardown only. */
export function resetHookState(): void {
  _lastWarningResponse = null;
  _cachedScope = null;
  _lastRecallReminderSha = null;
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
      const preInput = input as PreToolUseHookInput;

      // Capture EE render output so warnings surface in the agent content stream
      // (yielded as content above the tool action) rather than going to console.warn.
      // Also fan out to the previous sink so the active TUI render path (activeEeYield)
      // receives the experience_warning chunks and renders the full [conf%] message + Why
      // inline — without this fan-out the user only sees the count, not the detail.
      const capturedWarnings: string[] = [];
      const originalSink = getRenderSink();
      setRenderSink((chunk) => {
        capturedWarnings.push(typeof chunk === "string" ? chunk : ((chunk as { content?: string }).content ?? ""));
        try {
          originalSink(chunk);
        } catch {
          /* TUI sink fail-open — never block intercept */
        }
      });
      let r: Awaited<ReturnType<typeof interceptWithDefaults>>;
      try {
        r = await interceptWithDefaults({
          toolName: input.tool_name,
          toolInput: input.tool_input,
          cwd,
          ...(preInput.intent_context ? { context: preInput.intent_context } : {}),
        });
      } finally {
        setRenderSink(originalSink);
      }
      // Thread the warning response to PostToolUse via module-level latch
      _lastWarningResponse = r;

      // P1 Item 3 wiring: feed surfaced principles into the phase tracker.
      // Tracker is no-op when no phase is active.
      try {
        const refs = (r.matches ?? [])
          .map((m) => ({ collection: m.collection ?? "", pointId: m.principle_uuid }))
          .filter((ref) => ref.collection && ref.pointId);
        if (refs.length > 0) phaseTracker.recordIntercept(refs);
      } catch {
        /* fail-open */
      }

      // P0 native observation: record into mistake-detector ring buffer,
      // then check for file-revert against the prior batch (across-turn
      // re-edit of a file the agent just touched with warnings).
      const matchCount = r.matches?.length ?? 0;
      const matchIds = r.matches?.map((m) => m.principle_uuid) ?? [];
      try {
        const det = getMistakeDetector();
        det.recordPreTool(input.tool_name, input.tool_input, matchCount > 0);
        const revertEvents = det.detectFileRevert(input.tool_name, input.tool_input);
        if (revertEvents.length > 0) {
          if (!_cachedScope) _cachedScope = await buildScope({ cwd });
          const tenantId = getTenantId();
          const scope = _cachedScope;
          for (const ev of revertEvents) {
            void posttool(
              {
                toolName: ev.toolName,
                toolInput: ev.toolInput,
                outcome: { success: false, mistakeKind: ev.kind, evidence: ev.evidence },
                cwd,
                tenantId,
                scope,
              },
              {
                warningResponse: null,
                toolName: ev.toolName,
                outcome: { success: false, mistakeKind: ev.kind, evidence: ev.evidence },
                cwdMatchedAtPretool: true,
                diffPresent: false,
                tenantId,
              },
            );
          }
        }
      } catch {
        /* fail-open */
      }

      // P0 trajectory log — append-only, fire-and-forget.
      const sid = preInput.session_id;
      if (sid) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: sid,
          kind: "intercept",
          toolName: input.tool_name,
          decision: r.decision,
          matchCount,
          matchIds,
          ...(r.reason ? { reason: r.reason } : {}),
        });
        if (matchCount > 0) {
          fireTrajectoryEvent({
            ts: new Date().toISOString(),
            sessionId: sid,
            kind: "warning_surfaced",
            toolName: input.tool_name,
            principleIds: matchIds,
          });
        }
      }

      // EE detail log: what EE decided and what warnings were surfaced
      try {
        const sid = (input as PreToolUseHookInput).session_id;
        if (sid) {
          const matches = r.matches ?? [];
          // r.decision can be empty when the server short-circuits (budget cap,
          // read-only fast-path, missing embedding). Use a stable fallback so
          // analytics queries can group these without losing rows.
          const subtype = typeof r.decision === "string" && r.decision.trim().length > 0 ? r.decision : "no-decision";
          logInteraction(sid, "ee_intercept", {
            eventSubtype: subtype,
            data: {
              phase: "pre_tool",
              role: "guardian",
              toolName: input.tool_name,
              decision: r.decision,
              matchCount: matches.length,
              matches: matches.map((m) => ({
                id: m.principle_uuid,
                confidence: m.confidence,
                message: m.message.slice(0, 120),
                expectedBehavior: m.expectedBehavior ?? null,
              })),
              reason: r.reason ?? null,
              noise_risk: matches.length > 0 && matches.every((m) => m.confidence < 0.5),
            },
          });
        }
      } catch {
        /* fail-open */
      }

      const eeMatches = (r.matches ?? []).map((m) => ({
        id: m.principle_uuid,
        toolName: input.tool_name,
        message: m.message,
        why: m.why,
        confidence: m.confidence,
      }));

      // Hard EE recall-feedback gate: inject mandatory reminder when there are
      // pending unrated hints. The agent MUST clear all pending ee_feedback before
      // proceeding with the task — system prompt in message-processor.ts enforces
      // this as a first-before-anything directive.
      //
      // Fix 2: throttle to once per unique pending-set. The same 9 hints repeating
      // after each of 10+ tool calls is pure UI noise — the model can't even see
      // yield-content, and the user must scroll past identical blocks. Show the
      // reminder ONCE when the set first appears or changes (e.g. after ee_feedback
      // clears some entries), then stay silent until the set changes again.
      let recallReminder: string | null = null;
      try {
        const { sessionRecallLedger, isRecallLedgerEnabled, formatPendingReminder } = await import(
          "../ee/recall-ledger.js"
        );
        if (isRecallLedgerEnabled()) {
          const pending = sessionRecallLedger.pending();
          if (pending.length > 0) {
            const pendingSha = pending
              .map((p) => p.id)
              .sort()
              .join(",");
            if (pendingSha !== _lastRecallReminderSha) {
              _lastRecallReminderSha = pendingSha;
              recallReminder = `↳ ${pending.length} unrated EE recall(s) — rate the one(s) you acted on when convenient (does not block the task; queued if the brain is down).\n${formatPendingReminder(pending, { max: 5 })}`;
            }
          } else {
            // All cleared — reset so next batch shows fresh
            _lastRecallReminderSha = null;
          }
        }
      } catch {
        /* fail-open */
      }

      if (r.decision === "block") {
        return {
          blocked: true,
          blockingErrors: [{ command: "ee:intercept", stderr: r.reason ?? "ee-blocked" }],
          preventContinuation: true,
          stopReason: r.reason ?? "ee-blocked",
          additionalContexts: [
            ...capturedWarnings,
            ...(r.suggestions ?? []),
            ...(recallReminder ? [recallReminder] : []),
          ],
          decision: "block",
          results: [],
          eeMatches,
        };
      }
      return {
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [
          ...capturedWarnings,
          ...(r.suggestions ?? []),
          ...(recallReminder ? [recallReminder] : []),
        ],
        decision: "approve",
        results: [],
        eeMatches,
      };
    }

    if (input.hook_event_name === "PostToolUse") {
      const postInput = input as PostToolUseHookInput;
      if (!_cachedScope) _cachedScope = await buildScope({ cwd });

      // P0 native observation: mark detector entry, then look for retry-pattern.
      let mistakeOutcomeOverlay: Partial<PostToolOutcome> = {};
      try {
        const det = getMistakeDetector();
        det.recordPostTool(input.tool_name, true);
        const retry = det.detectRetryPattern();
        if (retry) {
          mistakeOutcomeOverlay = {
            mistakeKind: retry.kind,
            evidence: retry.evidence,
          };
        }
      } catch {
        /* fail-open */
      }

      const richOutcome: PostToolOutcome = {
        success: true,
        ...(postInput.rich_outcome ?? {}),
        ...mistakeOutcomeOverlay,
      };
      const judgeCtx: JudgeContext = {
        warningResponse: _lastWarningResponse,
        toolName: input.tool_name,
        outcome: richOutcome,
        cwdMatchedAtPretool: _lastWarningResponse !== null,
        diffPresent: false,
        tenantId: getTenantId(),
      };

      // EE detail log: judge classification and agent feedback behavior.
      // Phase 5 F5 — skip the write when EE produced ZERO warnings for this
      // tool call. 5-baseline measurements showed ~100% of ee_judge rows
      // came from hadWarnings=false / agent_response_to_ee="no_warning_present"
      // — pure logging noise, no signal. We only persist the judge event when
      // there were warnings to evaluate against.
      try {
        const sid = (input as PostToolUseHookInput).session_id;
        if (sid) {
          const classification = judge(judgeCtx);
          const matches = _lastWarningResponse?.matches ?? [];
          const hadWarnings = matches.length > 0;
          if (!hadWarnings) {
            // F5 skip — no warnings, no judge row.
          } else
            logInteraction(sid, "ee_judge", {
              eventSubtype: classification,
              data: {
                phase: "post_tool",
                role: "judge",
                toolName: input.tool_name,
                classification,
                hadWarnings,
                matchCount: matches.length,
                cwdMatched: judgeCtx.cwdMatchedAtPretool,
                outcomeSuccess: true,
                agent_response_to_ee: hadWarnings
                  ? classification === "FOLLOWED"
                    ? "agent_complied"
                    : classification === "IGNORED"
                      ? "agent_overrode"
                      : "no_relevant_warning"
                  : "no_warning_present",
                noise_analysis: hadWarnings
                  ? {
                      all_low_confidence: matches.every((m) => m.confidence < 0.5),
                      forced_feedback_on_noise:
                        matches.some((m) => m.confidence < 0.3) && classification !== "IRRELEVANT",
                    }
                  : null,
              },
            });
        }
      } catch {
        /* fail-open */
      }

      _lastWarningResponse = null; // reset after use — prevents cross-turn contamination
      await posttool(
        {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          outcome: richOutcome,
          cwd,
          tenantId: getTenantId(),
          scope: _cachedScope,
        },
        judgeCtx,
      );

      // P0 trajectory log
      const sidPost = postInput.session_id;
      if (sidPost) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: sidPost,
          kind: "posttool",
          toolName: input.tool_name,
          success: true,
          ...(richOutcome.durationMs !== undefined ? { durationMs: richOutcome.durationMs } : {}),
          ...(richOutcome.mistakeKind ? { mistakeKind: richOutcome.mistakeKind } : {}),
          ...(richOutcome.verifyResult ? { verifyResult: richOutcome.verifyResult } : {}),
          ...(richOutcome.buildResult ? { buildExitCode: richOutcome.buildResult.exitCode } : {}),
        });
      }
      // P1 Item 3 wiring: feed posttool signal into phase tracker.
      try {
        phaseTracker.recordPostTool({
          success: true,
          ...(richOutcome.verifyResult ? { verifyResult: richOutcome.verifyResult } : {}),
        });
      } catch {
        /* fail-open */
      }
      // STALE-02/STALE-03: fire-and-forget per-turn prompt-stale reconciliation
      reconcilePromptStale(cwd); // void — does not block (B-4)
      return emptyResult();
    }

    if (input.hook_event_name === "PostToolUseFailure") {
      const failInput = input as PostToolUseFailureHookInput;
      if (!_cachedScope) _cachedScope = await buildScope({ cwd });

      // P0 native observation: mark detector entry as failure (no retry detection on failure).
      try {
        getMistakeDetector().recordPostTool(failInput.tool_name, false);
      } catch {
        /* fail-open */
      }

      const failOutcome: PostToolOutcome = {
        success: false,
        error: failInput.error,
        ...(failInput.rich_outcome ?? {}),
      };
      const judgeCtx: JudgeContext = {
        warningResponse: _lastWarningResponse,
        toolName: failInput.tool_name,
        outcome: failOutcome,
        cwdMatchedAtPretool: _lastWarningResponse !== null,
        diffPresent: false,
        tenantId: getTenantId(),
      };

      // EE detail log: judge classification on tool failure.
      // F5 — same suppression: skip when EE issued no warning. A tool failure
      // without a pre-warning is signal for OTHER systems (verify-failure
      // tracker etc.), not for the EE judge log.
      try {
        const sid = failInput.session_id;
        if (sid) {
          const classification = judge(judgeCtx);
          const matches = _lastWarningResponse?.matches ?? [];
          const hadWarnings = matches.length > 0;
          if (!hadWarnings) {
            // F5 skip
          } else
            logInteraction(sid, "ee_judge", {
              eventSubtype: classification,
              data: {
                phase: "post_tool_failure",
                role: "judge",
                toolName: failInput.tool_name,
                classification,
                hadWarnings,
                matchCount: matches.length,
                cwdMatched: judgeCtx.cwdMatchedAtPretool,
                outcomeSuccess: false,
                errorPreview: failInput.error?.slice(0, 120) ?? null,
                agent_response_to_ee: hadWarnings ? "tool_failed_after_warning" : "tool_failed_no_warning",
                noise_analysis: hadWarnings
                  ? {
                      all_low_confidence: matches.every((m) => m.confidence < 0.5),
                      forced_feedback_on_noise:
                        matches.some((m) => m.confidence < 0.3) && classification !== "IRRELEVANT",
                    }
                  : null,
              },
            });
        }
      } catch {
        /* fail-open */
      }

      _lastWarningResponse = null; // reset after use — prevents cross-turn contamination
      await posttool(
        {
          toolName: failInput.tool_name,
          toolInput: failInput.tool_input,
          outcome: failOutcome,
          cwd,
          tenantId: getTenantId(),
          scope: _cachedScope,
        },
        judgeCtx,
      );

      // P0 trajectory log
      const sidFail = failInput.session_id;
      if (sidFail) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: sidFail,
          kind: "posttool",
          toolName: failInput.tool_name,
          success: false,
          ...(failOutcome.durationMs !== undefined ? { durationMs: failOutcome.durationMs } : {}),
          ...(failOutcome.verifyResult ? { verifyResult: failOutcome.verifyResult } : {}),
          ...(failOutcome.buildResult ? { buildExitCode: failOutcome.buildResult.exitCode } : {}),
        });
      }
      // P1 Item 3 wiring: feed posttool failure signal into phase tracker.
      try {
        phaseTracker.recordPostTool({
          success: false,
          ...(failOutcome.verifyResult ? { verifyResult: failOutcome.verifyResult } : {}),
        });
      } catch {
        /* fail-open */
      }
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
  intentContext?: import("./types.js").PreToolIntentContext,
): Promise<AggregatedHookResult> {
  const input: PreToolUseHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    cwd,
    ...(intentContext ? { intent_context: intentContext } : {}),
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
  richOutcome?: import("./types.js").PostToolRichOutcome,
): Promise<AggregatedHookResult> {
  const input: PostToolUseHookInput = {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
    session_id: sessionId,
    cwd,
    ...(richOutcome ? { rich_outcome: richOutcome } : {}),
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
  richOutcome?: import("./types.js").PostToolRichOutcome,
): Promise<AggregatedHookResult> {
  const input: PostToolUseFailureHookInput = {
    hook_event_name: "PostToolUseFailure",
    tool_name: toolName,
    tool_input: toolInput,
    error,
    session_id: sessionId,
    cwd,
    ...(richOutcome ? { rich_outcome: richOutcome } : {}),
  };
  return executeEventHooks(input, cwd, signal);
}

// MessageProcessor — extracted from orchestrator.ts as part of Phase 12.4.
//
// Owns the main streaming turn loop that lives in `Agent.processMessage`:
//   - Abort wiring (external AbortContext + per-turn AbortController)
//   - Trajectory + phase tracker observations on user_turn / abort
//   - PIL enrichment pipeline (layers 1/3/6 — fail-open with logging)
//   - ROUTE-11 per-turn model routing (decide + fallback to non-disabled
//     provider via CouncilManager)
//   - Vision proxy (history + current turn)
//   - Auto-council gate (PIL taskType + heavy tier + role count) — routes
//     into runCouncilV2 and re-enters processMessage with synthesis
//   - System prompt assembly (chitchat / playwright gating + PIL suffix +
//     model constraints)
//   - SAMR step-aware routing (phase1 reasoning → phase2 execution)
//   - Tool roundtrip loop:
//       - Compaction (relax on overflow recovery, B4 top-level prepareStep)
//       - Tool set assembly: builtin + MCP (smart filter for chitchat /
//         browser-vocab) + PIL response tools, all wrapped with top-level
//         cumulative cap (F1), cross-turn dedup (C3), read-path budget
//       - ProviderOptions composition (buildTurnProviderOptions +
//         taskTypeToReasoningEffort budget + thinkingType adaptive override
//         + O1 shape capture)
//       - streamText({...}) with prepareStep (top-level compactor +
//         capability sanitizeHistory), onStepStart/Finish, onFinish
//         (correlation cleanup)
//       - fullStream consumer (text-delta / reasoning-delta / tool-call
//         with EE PreToolUse intercept / tool-result with EE PostToolUse
//         and vision-bridge / tool-error / tool-approval-request /
//         error / abort)
//   - Write-ahead persistence (Phase A4 tool_calls, A5 message_seq)
//   - Context-overflow recovery + transient retry with exponential backoff
//   - Post-turn compact + Stop / StopFailure hooks
//   - Debug pipeline trace
//
// Zero behavioral changes — every method body mirrors the original
// `processMessage` (see commit history). The DI surface (`MessageProcessorDeps`)
// is the minimum proxy onto Agent state needed to reach back into Agent
// without holding a circular reference. Public `Agent.processMessage`
// signature is unchanged and continues to be the entrypoint; internally it
// constructs a `MessageProcessor` per call.
//
// Cost-leak code paths preserved here:
//   - F1 (top-level cumulative cap)         — wrapToolSetWithCap (top-level)
//   - F1 (openai.promptCacheKey)            — buildTurnProviderOptions
//   - G1 (OAuth `maxOutputTokens` drop)     — shouldDropParam(runtime, ...)
//   - B4 (top-level prepareStep compaction) — compactSubAgentMessages
//   - C3 (cross-turn dedup wrap)            — wrapToolSetWithDedup
//   - A4 (tool_call write-ahead)            — persistToolCallWriteAhead
//   - A5 (message_seq write-ahead)          — persistMessageWriteAhead
//   - O1 (providerOptions shape forensics)  — extractProviderOptionsShape
//   - reasoning-strip (provider quirk)       — turnCaps.sanitizeHistory

import { generateText, type ModelMessage, type StopCondition, stepCountIs, streamText, type ToolSet } from "ai";
import { breadcrumb } from "../council/crash-breadcrumb.js";
import { recordArtifact } from "../ee/artifact-cache.js";
import { getCachedAuthToken, getCachedServerBaseUrl } from "../ee/auth.js";
import { routeFeedback, routeModel } from "../ee/bridge.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { getMistakeDetector } from "../ee/mistake-detector.js";
import { fireAndForgetPhaseOutcome } from "../ee/phase-outcome.js";
import * as phaseTracker from "../ee/phase-tracker.js";
import { buildScope as buildScopeForVeto } from "../ee/scope.js";
import { fireTrajectoryEvent } from "../ee/session-trajectory.js";
import { getTenantId as getTenantIdForVeto } from "../ee/tenant.js";
import { isGsdNativeEnabled } from "../gsd/flags.js";
import { getGsdLoopHost } from "../gsd/loop-host.js";
import { readState, syncWorkflowContext } from "../gsd/workflow-engine.js";
import type {
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { acquireMcpTools } from "../mcp/client-pool";
import { dropRedundantFsMcpTools, filterMcpServersByMessage } from "../mcp/smart-filter";
import type { getModelInfo } from "../models/registry.js";
import {
  cheapModelShellLine,
  injectCheapModelPlaybook,
  injectCheapModelShellDirective,
  shouldInjectCheapModelPlaybook,
} from "../pil/cheap-model-playbook.js";
import { injectCheapModelWorkbook, shouldInjectCheapModelWorkbook } from "../pil/cheap-model-workbooks.js";
import type { DiscoveryInteractionHandler } from "../pil/discovery-types.js";
import {
  applyPilSuffix,
  getResponseTaskType,
  getResponseToolSet,
  isResponseTool,
  normalizeStructuredResponseTaskType,
  runPipeline,
  shouldHaltOnResponseTool,
} from "../pil/index.js";
import { isContinuationPhrase } from "../pil/layer1-intent.js";
import { isMetaAnalysisPrompt } from "../pil/layer6-output.js";
import { taskTypeToMaxTokens, taskTypeToReasoningEffort, taskTypeToTier } from "../pil/task-tier-map.js";
import { mentionsEcosystemScope } from "../playbook/directives.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import {
  bridgeMcpToolResult,
  getVisionGuidanceForTextOnly,
  listCachedImages,
  scrubImagePayloadsInMessages,
} from "../providers/mcp-vision-bridge.js";
import { captureToolSchemas } from "../providers/patch-zod-schema.js";
import {
  buildTurnProviderOptions,
  detectProviderForModel,
  type ResolvedModelRuntime,
  requireRuntimeProvider,
  resolveModelRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import {
  canHandleImagesForTextOnlyModel,
  needsVisionProxy,
  planImageHandlingForTextOnlyModel,
  proxyVision,
} from "../providers/vision-proxy.js";
import { wireDebug } from "../providers/wire-debug.js";
import { reportRouteOutcome } from "../router/decide.js";
import { decideStepRouting, getStepRouterConfig } from "../router/step-router.js";
import { routerStore } from "../router/store.js";
import { statusBarStore } from "../state/status-bar-store.js";
import { isDebugEnabled, type PipelineStep, recordTurnTrace, type TurnTrace } from "../state/turn-trace.js";
import {
  getLastApprovedPlan,
  getNextMessageSequence,
  logInteraction,
  markMessageErrored,
  markToolCallErrored,
  persistMessageWriteAhead,
  persistToolCallWriteAhead,
  type SessionStore,
} from "../storage/index.js";
import { persistSessionExperience } from "../storage/session-experience-store.js";
import { createBuiltinTools } from "../tools/registry.js";
import { snapshotFromTodoWriteArgs } from "../tools/todo-write-snapshot.js";
import { visionToolsNeeded } from "../tools/vision-gate.js";
import type { SessionInfo, StreamChunk, SubagentStatus, ToolCall } from "../types/index";
import { appendDecisionLog } from "../usage/decision-log.js";
import { logger } from "../utils/logger.js";
import { openUrl } from "../utils/open-url.js";
import { appendAudit, type PermissionMode, toolNeedsApproval } from "../utils/permission-mode.js";
import {
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
  getPrestreamPhaseMaxPingMs,
  getProviderStallRetries,
  getProviderStallTimeoutMs,
  getRoleModels,
  getSteerInjectionEnabled,
  getTopLevelCompactKeepLast,
  getTopLevelCompactThresholdChars,
  getTopLevelToolBudgetChars,
  isAutoCouncilEnabled,
  isModelPinnedByProject,
  isProviderDisabled,
  loadMcpServers,
  loadValidSubAgents,
} from "../utils/settings";
import { resolveShell } from "../utils/shell.js";
import type { AbortContext } from "./abort.js";
import type { LegacyProvider, ProcessMessageObserver } from "./agent-options";
import type { AskUserAskInfo } from "./ask-user.js";
import { beginCompactionTurn } from "./compact-request.js";
import { relaxCompactionSettings } from "./compaction";
import type { CouncilManager } from "./council-manager.js";
import type { CrossTurnDedup } from "./cross-turn-dedup.js";
import { wrapToolSetWithDedup } from "./cross-turn-dedup.js";
import { humanizeApiError, isAuthenticationError, isContextLimitError, summarizeApiErrorForLog } from "./error-utils";
import { buildInterruptedTurnNote } from "./interrupted-turn.js";
import type { PendingCallsLog } from "./pending-calls.js";
import { stableCallId } from "./pending-calls.js";
import { prepareTurnContext } from "./preprocessor.js";
import { applyModelConstraints, buildMcpCapabilityBlock, buildSystemPromptParts } from "./prompts";
import { extractProviderOptionsShape } from "./provider-options-shape.js";
import type { ReadPathBudget } from "./read-path-budget.js";
import { wrapToolSetWithReadBudget } from "./read-path-budget.js";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";
import { repairToolCallHook } from "./repair-tool-call.js";
import {
  buildRepetitionReminder,
  recordAssistantBurst,
  shouldInjectRepetitionReminder,
} from "./repetition-detector.js";
import { classifyStreamError } from "./retry-classifier.js";
import type { SafetyBlockKind, SafetyOverrideAskInfo, SafetyOverrideVerdict } from "./safety-askcard.js";
import {
  forcedFinalize,
  getSessionLastTask,
  incSessionStep,
  parseBudgetOverride,
  recordSessionLastTask,
  resetSessionStep,
  resolveCeiling,
} from "./scope-ceiling.js";
import {
  attachReminderToMessages,
  buildCheckpointReminder,
  buildScopeReminder,
  type ComplexitySize,
  cadenceForSize,
  shouldInjectCeilingCrossing,
  shouldInjectReminder,
  shouldInjectSoftWarn,
  shouldPreWarnCompaction,
} from "./scope-reminder.js";
import {
  formatElisionManifest,
  getSessionExperienceCounts,
  recordCompaction,
  recordElision,
} from "./session-experience.js";
import { refreshSessionGuidance } from "./session-guidance.js";
import { shouldRunGate } from "./should-run-gate.js";
import { attemptStallRescue, pushStallToolResult, type StallToolResult } from "./stall-rescue.js";
import {
  createStallWatchdog,
  STALL_ERROR_MESSAGE,
  shouldContinueAfterMidLoopStall,
  shouldRepromptStall,
  stallRepromptBackoffMs,
} from "./stall-watchdog.js";
import { planSteerInjection } from "./steer-inbox.js";
import { wrapToolSetWithCap } from "./sub-agent-cap.js";
import { applyAnthropicPromptCaching, compactSubAgentMessages, cumulativeMessageChars } from "./subagent-compactor.js";
import { detectTextEmittedToolCall, parseDsmlToolCalls } from "./text-tool-call-detector.js";
import { executeToolEngine } from "./tool-engine.js";
import { createToolLoopCapPredicate, type ToolLoopCapAsk } from "./tool-loop-cap.js";
import {
  buildToolRepetitionAbortMessage,
  recordToolError as recordToolRepetitionError,
  recordToolSuccess as recordToolRepetitionSuccess,
} from "./tool-repetition-detector.js";
import { startPeriodicTurnProgressPing } from "./turn-progress.js";

/**
 * F2 — approximate the char cost of the FIXED prompt envelope (system +
 * tools JSON-Schema) that streamText re-sends on every step. Used to feed
 * the compactor a realistic total-prompt size so it fires when billed input
 * is actually large, not when only `messages[]` is.
 */
function computeEnvelopeChars(system: unknown, tools: unknown): number {
  let n = 0;
  if (typeof system === "string") n += system.length;
  else if (system && typeof system === "object") {
    try {
      n += JSON.stringify(system).length;
    } catch {
      /* ignore — best-effort estimate */
    }
  }
  if (tools && typeof tools === "object") {
    try {
      n += JSON.stringify(tools).length;
    } catch {
      /* ignore */
    }
  }
  return n;
}

import {
  combineAbortSignals,
  getFinishReason,
  getStepNumber,
  getUsage,
  notifyObserver,
  toToolCall,
  toToolResult,
} from "./tool-utils";
import type { TurnRunnerDepsBase } from "./turn-runner-deps.js";

/**
 * Dedup cache for recall-feedback reminders. Current guidance is reconciled
 * against the transcript itself by refreshSessionGuidance.
 */
const _injectedRecallSha = new Map<string, string>();

/**
 * Stable marker prefix for the SessionStart-hook system message (round 2,
 * G1 HIGH). `--resume` rehydrates `deps.messages` from the session's
 * persisted transcript BEFORE this function ever runs, but
 * `getSessionStartHookFired()` is a per-PROCESS flag — it resets on every
 * new process, including a resumed one. Firing the hook again on resume is
 * correct (the `SessionStartHookInput.source: "resume"` already reflects
 * this), but appending ANOTHER copy of this system message on top of the
 * one already sitting in the rehydrated history is not — the model would
 * see the same briefing twice. Tagged so the injection site can find and
 * REPLACE a prior copy instead of appending a second one.
 *
 * Exported (round 3, MEDIUM) so orchestrator.ts's compaction step can carry
 * this ONE message verbatim across a summarization pass — see its own
 * comment at the compaction call site: compaction's kept-tail window has no
 * reason to know about this tag, so a tagged message that fell outside the
 * kept window used to be summarized away like any other old message,
 * leaving nothing for a later --resume to find and replace.
 */
export const SESSION_START_SYSTEM_TAG = "[SessionStart hook output]";

/**
 * Round 12c — hard cap on the RAW input scanned by `sanitizeHookOutput`,
 * applied BEFORE the single linear pass below runs. Independent of, and
 * ahead of, `formatSessionStartHookNotice`'s OWN 16 KB bound on the
 * SANITIZED result: a huge amount of raw escape-sequence noise can
 * sanitize down to well under 16 KB, so that later bound alone cannot cap
 * the scanning cost here. 256 KB keeps even an adversarial multi-MB hook
 * output a sub-millisecond scan.
 */
const HOOK_OUTPUT_RAW_CAP = 256 * 1024;

/**
 * Round 12d — backs a slice-end index off by one when the code unit AT
 * `end - 1` is a HIGH surrogate (0xD800-0xDBFF): cutting there would leave
 * that lone high surrogate as the last kept code unit, which renders as
 * U+FFFD instead of whatever emoji/astral character it was one half of.
 * Used at BOTH truncation points that can slice hook-output text mid-pair
 * — `sanitizeHookOutput`'s raw-input cap below, and
 * `formatSessionStartHookNotice`'s post-sanitize 16 KB bound — so an emoji
 * straddling either boundary is dropped whole rather than split in half.
 */
function unicodeSafeSliceEnd(str: string, end: number): number {
  if (end > 0 && end <= str.length) {
    const last = str.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) return end - 1;
  }
  return end;
}

function isCsiParamOrIntermediate(c: number): boolean {
  return c >= 0x20 && c <= 0x3f;
}

function isCsiFinalByte(c: number): boolean {
  return c >= 0x40 && c <= 0x7e;
}

/**
 * Consumes a CSI body (parameter/intermediate bytes 0x20-0x3F, up to and
 * including a final byte 0x40-0x7E) starting at `start` — the index right
 * AFTER the CSI introducer (`ESC [` or the single 8-bit byte `0x9B`) has
 * already been dropped. Returns the index to resume the main scan at.
 *
 * On ABORT (a byte outside both ranges, or running off the end before a
 * final byte), that byte is NOT consumed here — the caller resumes its own
 * dispatch at the returned index, so an aborted CSI attempt only ever
 * costs the (already-dropped) introducer; the byte that caused the abort
 * gets ordinary treatment (kept if plain text, dropped if a control byte,
 * or the start of a fresh escape attempt if it is itself ESC/a C1 byte).
 */
function consumeCsiBody(src: string, start: number): number {
  const len = src.length;
  let j = start;
  while (j < len) {
    const c = src.charCodeAt(j);
    if (isCsiFinalByte(c)) return j + 1;
    if (isCsiParamOrIntermediate(c)) {
      j++;
      continue;
    }
    return j; // abort — resync here, byte left untouched
  }
  return j; // ran off the end mid-CSI
}

/**
 * Consumes a control-string body (OSC/DCS/SOS/PM/APC) starting at `start`
 * — the index right after the introducer has already been dropped.
 * `bellTerminates` is true only for OSC (a bare BEL also ends it, in
 * addition to ST); DCS/SOS/PM/APC end ONLY at ST.
 *
 * Reaching `\r` or `\n` BEFORE any terminator ends the string right
 * there, WITHOUT consuming the newline — the caller's own `\r`/`\n`
 * handling then applies to it on the next iteration, so damage from an
 * unterminated (or malformed, terminator-free) control string is capped
 * to the ONE line it started on, never anything past it.
 */
function consumeControlStringBody(src: string, start: number, bellTerminates: boolean): number {
  const len = src.length;
  let j = start;
  while (j < len) {
    const c = src.charCodeAt(j);
    if (c === 0x9c) return j + 1; // 8-bit ST
    if (c === 0x1b && src.charCodeAt(j + 1) === 0x5c) return j + 2; // 7-bit ST (ESC \)
    if (bellTerminates && c === 0x07) return j + 1; // BEL — OSC only
    if (c === 0x0a || c === 0x0d) return j; // newline first — resync here, undropped
    j++;
  }
  return j; // ran off the end mid-string
}

/**
 * Round 12b (F2 residual, MED) / Round 12c (rewrite) — strips ANSI escape
 * sequences (CSI, the OSC/DCS/SOS/PM/APC control strings, and other
 * Fe/Fs/Fp/charset-designation forms — both the 7-bit `ESC`-prefixed and
 * 8-bit C1 encodings of each) and C0/C1 control characters (except `\n`
 * and `\t`) from a SessionStart hook's raw stdout before it is ever
 * bounded or rendered. The TUI log is not a terminal emulator: an
 * unsanitized colour code, a cursor-move/clear-screen sequence, an OSC
 * window-title/hyperlink sequence, or a bare `\r` "progress bar" overwrite
 * would corrupt the log's own rendering or hide/replace text already
 * printed above it, and a NUL byte can break assumptions elsewhere in
 * string handling entirely.
 *
 * Rewritten (round 12c) as a SINGLE linear pass over UTF-16 code units —
 * no regex, no backtracking — after the refuter found the original
 * regex-based version's OSC pattern (`\x1B\][\s\S]*?(?:\x07|\x1B\\)`) was
 * O(n²) (a lazy `[\s\S]*?` inside a `.replace` re-scans from every
 * possible OSC-introducer position), hanging for minutes on ~1 MB of
 * repeated introducers in a call this codebase makes SYNCHRONOUSLY in
 * pre-stream — directly blocking the event loop. The state machine below
 * visits each input position a small constant number of times regardless
 * of content (an "abort" always resumes strictly past where the failed
 * attempt's own scan stopped), so it is O(n) even on adversarial input;
 * `HOOK_OUTPUT_RAW_CAP` bounds `n` itself as a second, independent belt.
 *
 * The regex rewrite also closed three smaller gaps the original missed:
 * an unterminated (or BEL-typo'd) OSC no longer eats legitimate text past
 * its own line (`consumeControlStringBody`'s newline-first rule); DCS/PM/
 * APC bodies are now actually stripped, not just their introducer; and
 * the 8-bit C1 CSI introducer (`0x9B`) no longer leaks its own params and
 * final byte once the introducer itself is gone.
 *
 * Because this scans by UTF-16 CODE UNIT, not byte, Unicode text round-
 * trips unchanged: every control/escape byte class checked below sits at
 * or below `0x9F`, while surrogate pairs (emoji, most CJK-supplementary
 * text) start at `0xD800` and precomposed Vietnamese/Latin-Extended text
 * sits at `0xA0` and up — neither can ever be mistaken for a control byte
 * or an escape introducer.
 *
 * `\r\n` is normalised to `\n`; a bare `\r` is dropped (not emulated —
 * this is plain text being rendered into a log, not a terminal).
 */
export function sanitizeHookOutput(raw: string): string {
  const src = raw.length > HOOK_OUTPUT_RAW_CAP ? raw.slice(0, unicodeSafeSliceEnd(raw, HOOK_OUTPUT_RAW_CAP)) : raw;
  const len = src.length;
  let out = "";
  let i = 0;

  while (i < len) {
    const c = src.charCodeAt(i);

    // --- \r / \r\n normalisation ---
    if (c === 0x0d) {
      if (src.charCodeAt(i + 1) === 0x0a) {
        out += "\n";
        i += 2;
      } else {
        i += 1; // bare \r dropped
      }
      continue;
    }
    if (c === 0x0a || c === 0x09) {
      out += src[i];
      i += 1;
      continue;
    }

    // --- 7-bit ESC-prefixed sequences ---
    if (c === 0x1b) {
      const b1 = src.charCodeAt(i + 1);
      if (b1 === 0x5b) {
        // CSI: ESC [
        i = consumeCsiBody(src, i + 2);
        continue;
      }
      if (b1 === 0x5d) {
        // OSC: ESC ]
        i = consumeControlStringBody(src, i + 2, true);
        continue;
      }
      if (b1 === 0x50 || b1 === 0x58 || b1 === 0x5e || b1 === 0x5f) {
        // DCS (ESC P) / SOS (ESC X) / PM (ESC ^) / APC (ESC _)
        i = consumeControlStringBody(src, i + 2, false);
        continue;
      }
      if (b1 >= 0x28 && b1 <= 0x2f) {
        // Charset designation: ESC + intermediate(0x28-0x2F) + one final byte.
        i = i + 2 < len ? i + 3 : i + 2;
        continue;
      }
      if (b1 >= 0x30 && b1 <= 0x7e) {
        // Other 2-byte Fe/Fs/Fp escape sequence (reset, save/restore cursor, etc.).
        i += 2;
        continue;
      }
      // Abort: nothing recognizable follows (end of input, or another
      // control byte) — drop just the lone ESC, resync at b1 untouched.
      i += 1;
      continue;
    }

    // --- 8-bit C1 control codes (single code unit each) ---
    if (c === 0x9b) {
      i = consumeCsiBody(src, i + 1);
      continue;
    }
    if (c === 0x9d) {
      i = consumeControlStringBody(src, i + 1, true);
      continue;
    }
    if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
      i = consumeControlStringBody(src, i + 1, false);
      continue;
    }
    if (c >= 0x80 && c <= 0x9f) {
      // Any other C1 control code, including a lone/out-of-context ST (0x9C).
      i += 1;
      continue;
    }

    // --- remaining C0 (ESC already handled above) — dropped ---
    if (c <= 0x1f) {
      i += 1;
      continue;
    }

    // --- ordinary text: ASCII/Latin/Vietnamese/surrogate pairs/etc. ---
    // Round 12d — a HIGH surrogate is only kept paired with a valid
    // following LOW surrogate; either half showing up alone (a genuinely
    // malformed input, or exposed by `unicodeSafeSliceEnd` backing a cut
    // off by one and leaving the OTHER half dangling) renders as U+FFFD,
    // so a lone surrogate of either kind is dropped rather than emitted.
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = src.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        out += src[i] + src[i + 1];
        i += 2;
      } else {
        i += 1; // lone high surrogate — dropped
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      i += 1; // lone low surrogate — dropped
      continue;
    }

    out += src[i];
    i += 1;
  }

  return out;
}

/**
 * Round 12 (F2/G14) — bound (default 16 KB) on how much of a SessionStart
 * hook's stdout/additionalContext gets rendered into the TUI's content
 * stream, per the FRAMEWORK's own "ON SESSION START" contract ("run the
 * briefing script and print its output as is"). Without a bound, a
 * misbehaving or verbose hook script could flood the very first turn's
 * output with an unbounded amount of text before the model's own answer
 * even starts. Prefixed with `SESSION_START_SYSTEM_TAG` (the SAME marker
 * used for the model-facing tagged system message, message-processor.ts's
 * round-2 G1 fix) so it reads as a distinct notice item in the log, not
 * indistinguishable assistant prose.
 *
 * Round 12b (F2 residual, MED): each context is run through
 * `sanitizeHookOutput` BEFORE trimming/joining/bounding — see that
 * function's doc comment for why the ordering (sanitize, then truncate)
 * is what makes "no dangling ESC survives truncation" true unconditionally.
 *
 * Returns `null` when there is nothing to show (every context was blank).
 * Pure — exported for direct testing without needing to drive a whole turn.
 */
export function formatSessionStartHookNotice(contexts: readonly string[], maxChars = 16_384): string | null {
  const joined = contexts
    .map((ctx) => sanitizeHookOutput(ctx).trim())
    .filter((ctx) => ctx.length > 0)
    .join("\n");
  if (!joined) return null;
  const body =
    joined.length > maxChars
      ? // Round 12d: `unicodeSafeSliceEnd` keeps this cut from landing
        // between the two halves of a surrogate pair (an emoji straddling
        // the boundary) — see its doc comment.
        `${joined.slice(0, unicodeSafeSliceEnd(joined, maxChars))}\n[... truncated: showed ${maxChars} of ${joined.length} chars ...]`
      : joined;
  return `${SESSION_START_SYSTEM_TAG}\n${body}`;
}

function isTaggedSessionStartMessage(m: ModelMessage): boolean {
  return m.role === "system" && typeof m.content === "string" && m.content.startsWith(SESSION_START_SYSTEM_TAG);
}

/**
 * Round 3 (MEDIUM, G1-adjacent): whether orchestrator.ts's compaction
 * rebuild needs to explicitly carry the tagged SessionStart system message
 * across a summarization pass, and the exact message to carry if so.
 *
 * Extracted as a pure function — exported for the test — because the real
 * compaction path (`Agent.compactForContext`) is a private method on a
 * large class that makes real LLM calls, not directly unit-testable.
 *
 * Returns `null` when the kept tail already has one (a short/fresh
 * session's compaction can legitimately keep it naturally — re-adding it
 * would duplicate it), otherwise the tagged message found anywhere in the
 * PRE-compaction history (`null` if there never was one).
 */
export function reinjectTaggedSessionStartAcrossCompaction(
  allMessagesBeforeCompaction: readonly ModelMessage[],
  keptMessages: readonly ModelMessage[],
): ModelMessage | null {
  if (keptMessages.some(isTaggedSessionStartMessage)) return null;
  return allMessagesBeforeCompaction.find(isTaggedSessionStartMessage) ?? null;
}

/**
 * Durable phase breadcrumb for the pre-stream path (everything in `run()`
 * before the first provider request — see `turn-progress.ts`'s
 * `pingTurnProgress`, which only fires once `executeToolEngine` is about to
 * call `streamText`). Nothing in this window emits a chunk, so the top-level
 * turn watchdog's 120s idle budget covers it as one opaque block: session
 * 1e9db4d68da0 hit exactly this — a watchdog kill with ZERO interaction_logs
 * / call_accounting rows anywhere in the window, so no evidence said WHICH
 * pre-stream await hung.
 *
 * Writes a `pre-stream.<name>.start` / `pre-stream.<name>.end` pair via the
 * existing crash-breadcrumb trail (`~/.muonroi-cli/council-breadcrumbs.jsonl`,
 * sync `fs.appendFileSync` — survives a watchdog abort because it is written
 * BEFORE `fn()` settles, not after). If a phase hangs, its `.start` has no
 * matching `.end` — the orchestrator's watchdog catch reads exactly that (see
 * `getLastOpenPhase(this.session?.id)` in orchestrator.ts) to attribute the
 * hang to a phase name in the `error` interaction_log row.
 *
 * `sessionId` is what makes that attribution safe under nesting: it is stamped
 * on every line, and the tracker keeps one open-phase set PER SESSION, so a
 * forked sub-session running its own phases concurrently cannot shadow the
 * parent's. Always pass the session that OWNS the phase, never a child's.
 *
 * Round 5 (G8 HIGH #1): ALSO keeps the top-level turn watchdog alive for the
 * phase's whole duration via `startPeriodicTurnProgressPing` — every phase
 * that runs through this wrapper (hooks, PIL classify, samrGuidance, gsdGate,
 * the G9 relatedness classifier, and any future addition) automatically stops
 * starving the watchdog, without a per-call-site change. This is a
 * DELIBERATE, structural fix over round 4's one-off `compaction.ts` fix,
 * which only pinged ITS OWN caller and left every other phase unpinged.
 *
 * Round 6 (G8 HIGH A): the ping is bounded by `getPrestreamPhaseMaxPingMs()`
 * (default 180s) — round 5's unbounded version pinged forever for a phase
 * that never settles, which regressed the ORIGINAL "a genuinely wedged setup
 * phase still fires" guarantee (see `turn-progress.ts`'s doc comment). Past
 * the ceiling this stops pinging (the phase keeps running; the idle rule
 * applies again) and writes a `pre-stream.<name>.pingCeiling` breadcrumb
 * naming the phase, for the same `getLastOpenPhase` attribution path this
 * function's `.start`/`.end` pair already feeds.
 */
export function preStreamPhase<T>(name: string, sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  breadcrumb(`pre-stream.${name}.start`, { sessionId });
  const maxPingMs = getPrestreamPhaseMaxPingMs();
  const stopPing = startPeriodicTurnProgressPing({
    maxMs: maxPingMs,
    onCeiling: () => {
      breadcrumb(`pre-stream.${name}.pingCeiling`, { sessionId, maxMs: maxPingMs });
    },
  });
  return fn().then(
    (v) => {
      stopPing();
      breadcrumb(`pre-stream.${name}.end`, { sessionId });
      return v;
    },
    (err) => {
      stopPing();
      breadcrumb(`pre-stream.${name}.end`, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    },
  );
}

/**
 * Dependency surface the MessageProcessor needs to reach back into Agent
 * state without holding a circular reference. Properties expose array
 * references (mutating push() must affect the same array the Agent reads on
 * subsequent turns). Method callbacks delegate to Agent private methods.
 */
export interface MessageProcessorDeps extends TurnRunnerDepsBase {
  readonly isSubSession?: boolean;
  // ---- Read/write state references --------------------------------------
  // (messages, bash, mode, maxToolRounds, schedules, sendTelegramFile inherited)
  /** Live messageSeqs array (mutated by push; parallel to messages). */
  readonly messageSeqs: Array<number | null>;
  /** Session bookkeeping. */
  readonly session: SessionInfo | null;
  readonly sessionStore: SessionStore | null;
  readonly modelId: string;
  readonly providerId: ProviderId;
  readonly batchApi: boolean;
  readonly permissionMode: PermissionMode;
  readonly externalAbortContext: AbortContext | null;
  readonly pendingCalls: PendingCallsLog | null;
  readonly councilManager: CouncilManager;
  readonly crossTurnDedup: CrossTurnDedup | null;
  readonly readBudget: ReadPathBudget | null;
  readonly priorWarningIdsInSession: Set<string>;
  readonly sessionEEGuidance: Map<string, { toolName: string; message: string; why: string; confidence: number }>;
  readonly flowReady: Promise<void> | null;

  // ---- Scalar getters / setters -----------------------------------------
  getAbortController(): AbortController | null;
  setAbortController(ctrl: AbortController | null): void;
  getSessionStartHookFired(): boolean;
  setSessionStartHookFired(v: boolean): void;
  getPlanContext(): string | null;
  setPlanContext(v: string | null): void;
  getResumeDigest(): string | null;
  setResumeDigest(v: string | null): void;
  getActiveRunId(): string | null;
  getPendingCwdNote(): string | null;
  setPendingCwdNote(v: string | null): void;
  setPilActive(v: boolean): void;
  setPilEnrichmentDelta(n: number): void;
  setCurrentCallId(id: string): void;
  setLastPromptBreakdown(
    b: {
      systemChars: number;
      staticPrefixChars: number;
      dynamicSuffixChars: number;
      playwrightGuidanceChars: number;
      messagesChars: number;
      messagesCount: number;
      toolsChars: number;
      toolsCount: number;
    } | null,
  ): void;
  setTurnUserGoalExcerpt(v: string): void;
  setTurnAssistantReasoning(v: string): void;
  appendTurnAssistantReasoning(delta: string): void;
  getTurnAssistantReasoning(): string;
  setPriorWarningIdsInSession(s: Set<string>): void;
  setMessages(messages: ModelMessage[]): void;

  // ---- Behavior delegators ----------------------------------------------
  requireProvider(): LegacyProvider;
  emitSubagentStatus(status: SubagentStatus | null): void;
  consultParentSession?: (question: string) => Promise<string>;
  fireHook(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{
    blocked: boolean;
    blockingErrors: Array<{ command: string; stderr: string }>;
    preventContinuation: boolean;
    additionalContexts: string[];
    results: import("../hooks/types.js").HookResult[];
    eeMatches: import("../hooks/types.js").EEMatchEntry[];
  }>;
  consumeBackgroundNotifications(): Promise<string[]>;
  initOAuthProvider(): Promise<void>;
  buildRecentTurnsSummary(): string | null;
  estimateProjectSize(): "small" | "medium" | "large" | null;
  countFilesTouched(): number;
  respondToToolApproval(approvalId: string, approved: boolean): void;
  /**
   * Tool-loop cap askcard hook (Claude-Code-style "continue?" prompt).
   *
   * Fires when the streamText loop reaches `maxToolRounds`. Returning
   * `"continue"` raises the cap by `bumpBy` and lets the loop run; `"stop"`
   * halts gracefully (no error). When undefined the loop hard-stops as before
   * — preserves backward compat for batch / headless paths that have no UI to
   * surface the askcard.
   */
  /**
   * Live-queue steering drain (UI-provided). Returns and CLEARS any messages
   * the user typed while this turn is streaming, so prepareStep can inject them
   * mid-turn. Undefined / returns [] → no steering (legacy deferred queue).
   */
  drainSteerMessages?: () => { text: string }[];
  appendMidTurnMessages?: (msgs: ModelMessage[]) => void;
  askToolLoopContinue?: ToolLoopCapAsk;
  /** Safety override handler — invoked when a tool call is blocked by the safety filter. */
  askSafetyOverride?: (info: SafetyOverrideAskInfo) => Promise<SafetyOverrideVerdict>;
  /** ask_user handler — invoked when the model calls the `ask_user` tool; resolves the human's answer. */
  askUser?: (info: AskUserAskInfo) => Promise<string>;
  /** Feature B2 — enter_ideal handler; records a pending product-loop request on the orchestrator. */
  enterIdeal?: (idea: string) => void;
  runCouncilV2(
    userMessage: string,
    opts: {
      skipClarification: boolean;
      observer?: ProcessMessageObserver;
      userModelMessage: ModelMessage;
      // Agent-driven post-council: suppress the hardcoded post-debate card so the
      // synthesis returns to the agent, which decides the follow-up. Threaded from
      // the auto-council + runDebate call sites in tool-engine.
      suppressPreDebateCards?: boolean;
      suppressPostDebate?: boolean;
      /** Gate A — thread the main turn's already-classified scopeKind so runCouncil skips a redundant self-classify round-trip. */
      externalTopic?: boolean;
    },
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
  ): AsyncGenerator<StreamChunk, void, unknown>;
  processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    userEnrichedMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: LegacyProvider;
    subagents: unknown[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown>;
}

/**
 * MessageProcessor — extracted streaming turn loop.
 *
 * Lifecycle:
 *   const processor = new MessageProcessor(deps);
 *   yield* processor.run(userMessage, observer, images);
 *
 * Constructed per call (heap allocation is negligible against the streamText
 * cost), matching the StreamRunner / CouncilManager pattern.
 */

/**
 * Max response-tool (`respond_*`) calls tolerated within a single turn before
 * the orchestrator finalizes early with the best answer buffered so far. A
 * well-behaved turn emits the response tool ONCE; a hedge-then-answer emits 2.
 * Beyond that is degenerate spam (session 8d8f498268ed: 80× identical
 * respond_general in one generation). Set to 3 so the legitimate ≤2 patterns
 * are never cut short.
 */
const RESPONSE_TOOL_SPAM_CAP = 3;

/**
 * Rewrites tool-result parts in the AI SDK's final response history if the
 * user manually approved a safety-blocked command. This ensures the model sees
 * its own retry context accurately (as a success) rather than a repeated block
 * message, avoiding infinite retry loops or hallucinated failures.
 */
export function rewriteSafetyApprovedToolResults<T extends { role: string; content?: any }>(messages: T[]): T[] {
  const _globalSafety = globalThis as typeof globalThis & {
    __muonroiSafetyApproved?: Map<string, { kind: "once" | "session"; command: string }>;
  };
  const approvedMap = _globalSafety.__muonroiSafetyApproved;
  if (!approvedMap || approvedMap.size === 0) {
    return messages;
  }
  return messages.map((m) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return m;
    let changed = false;
    const newContent = m.content.map((part: any) => {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        const approved = approvedMap.get(part.toolCallId);
        if (approved) {
          changed = true;
          return {
            ...part,
            isError: false,
            result: `Approved (${approved.kind}): blocked command was allowed by user`,
          };
        }
      }
      return part;
    });
    return changed ? ({ ...m, content: newContent } as T) : m;
  });
}

export class MessageProcessor {
  constructor(private deps: MessageProcessorDeps) {}

  async *run(
    userMessage: string,
    observer?: ProcessMessageObserver,
    images?: Array<{ path: string; mediaType: string; base64: string }>,
    options?: { retainModel?: boolean },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const deps = this.deps;
    // A1 fix: mirror the existing `ownsController` pattern (orchestrator.ts
    // runCouncilV2 ~2353, runProductLoopV1 ~2627). If `deps.getAbortController()`
    // already holds a controller, this `run()` call is NESTED inside an
    // already-owned run — e.g. sprint-runner Step 4b's completeness re-check
    // calling `ctx.processMessageFn`, which resolves to `Agent.processMessage`
    // → `new MessageProcessor(...).run()`. Pre-fix, this branch unconditionally
    // created a brand-new AbortController and overwrote the owner's, then the
    // `finally` below nulled it out on completion regardless of ownership —
    // orphaning the owner's captured signal so a later `abort()` (Esc) became
    // a permanent no-op for the rest of the run. Reusing the owner's controller
    // verbatim means aborting the owner also aborts this nested call (same
    // signal object, no extra wiring needed), and this call's own completion
    // never touches the owner's controller.
    const existingController = deps.getAbortController();
    const ownsController = !existingController;
    if (ownsController) {
      // TUI-04: prefer the external AbortContext (from SIGINT handler) so that
      // Ctrl+C mid-tool-call triggers a single, unified abort across all I/O.
      // If no external context, fall back to creating a local AbortController.
      if (deps.externalAbortContext) {
        // Wrap the external signal in a local controller so existing cleanup
        // paths (setAbortController(null)) still work without side-effects.
        const ctrl = new AbortController();
        deps.setAbortController(ctrl);
        // Forward external abort to the local controller.
        deps.externalAbortContext.signal.addEventListener(
          "abort",
          () => {
            deps.getAbortController()?.abort(deps.externalAbortContext?.reason());
          },
          { once: true },
        );
      } else {
        deps.setAbortController(new AbortController());
      }
    }
    const signal = deps.getAbortController()!.signal;
    deps.emitSubagentStatus(null);

    // Phase 5 Fix 1 — reset the per-session step counter at every user-turn
    // boundary. The original Phase 4 design kept the counter per-SESSION so a
    // wandering agent bursting 50 tools across pseudo-turns would still trip
    // the ceiling. In practice that punishes legitimate multi-turn work: turn
    // 1 fills the counter, turn 2 (even a deliberate continuation) is halted
    // almost immediately because the ceiling row may resolve smaller for the
    // continuation's classified task. A new user message is an explicit
    // human-in-the-loop signal — the user has seen results and chose to
    // continue. Reset the counter so each user turn gets the full budget the
    // matrix specifies for its own (taskType, size). Within-turn wandering
    // is still capped by the per-turn ceiling, which is the real concern.
    if (deps.session?.id) {
      resetSessionStep(deps.session.id);
    }

    // Phase C3: advance the cross-turn dedup turn counter so stubs can point
    // back to the correct prior turn.
    deps.crossTurnDedup?.beginTurn();

    // Compaction-consult turn boundary: the preservation focus the agent stated
    // via the `compact` tool is scoped to ONE user turn. Without this a focus
    // from an early turn would keep steering compactions many turns later.
    try {
      beginCompactionTurn();
    } catch (err) {
      logger.warn("orchestrator", "[message-processor] beginCompactionTurn failed", {
        error: (err as Error)?.message,
      });
    }

    // P0 native observation: turn boundary. Capture the prior batch via
    // resetBatch — file-revert detection (in the hook layer) reads it on
    // the first edit of the new turn. No language-based veto matching.
    try {
      getMistakeDetector().resetBatch();
      if (deps.session?.id) {
        fireTrajectoryEvent({
          ts: new Date().toISOString(),
          sessionId: deps.session.id,
          kind: "user_turn",
          excerpt: userMessage.slice(0, 200),
          vetoDetected: false,
        });
      }
    } catch {
      /* fail-open: detector state must never block the turn */
    }

    // P0 native observation: AbortSignal → fire user-veto for any in-flight
    // batch tools that had warnings. Listener self-removes after fire so it
    // can't double-fire on later aborts in the same turn. A1: `aborter` is
    // declared at function scope (not block-scoped) and explicitly removed in
    // the `finally` below — needed because `signal` may now be the OWNER's
    // long-lived controller (nested-call reuse, see above), and without this
    // cleanup every nested `processMessage` call would leak one more listener
    // onto that shared, long-lived signal instead of onto its own short-lived,
    // GC'd controller.
    const aborter = () => {
      try {
        // P1 Item 3 wiring: mark current phase aborted so the next setPhase
        // call drains an "abandoned" outcome.
        phaseTracker.markAborted(
          deps.getAbortController()?.signal.reason ? String(deps.getAbortController()!.signal.reason) : undefined,
        );
      } catch {
        /* fail-open */
      }
      try {
        const det = getMistakeDetector();
        const events = det.detectAbort(
          deps.getAbortController()?.signal.reason ? String(deps.getAbortController()!.signal.reason) : undefined,
        );
        if (events.length === 0) return;
        const cwd = deps.bash.getCwd();
        const tenantId = getTenantIdForVeto();
        void buildScopeForVeto({ cwd })
          .then(async (scope) => {
            const { getDefaultEEClient } = await import("../ee/intercept.js");
            for (const ev of events) {
              void getDefaultEEClient()
                .posttool({
                  toolName: ev.toolName,
                  toolInput: ev.toolInput,
                  outcome: { success: false, mistakeKind: ev.kind, evidence: ev.evidence },
                  cwd,
                  tenantId,
                  scope,
                })
                .catch(() => {
                  /* fire-and-forget */
                });
            }
          })
          .catch(() => {
            /* fire-and-forget */
          });
      } catch {
        /* fail-open */
      }
    };
    signal.addEventListener("abort", aborter, { once: true });

    // Phase 4 Plan 04 (4B) — parse `--budget-rounds N` flag BEFORE PIL so the
    // flag never reaches the model and never biases intent classification.
    // The stashed override is consumed after PIL produces taskType + size.
    const _budgetOverride = parseBudgetOverride(userMessage);
    if (_budgetOverride.override !== undefined) {
      userMessage = _budgetOverride.cleanedPrompt;
    }

    // P0 native observation: cache turn-level intent fields for PreToolUse.
    deps.setTurnUserGoalExcerpt(userMessage.slice(0, 200));
    deps.setTurnAssistantReasoning("");

    const _sessionIdForBreadcrumbs = deps.session?.id;

    // Ensure flow run is ready before processing (fail-open).
    await preStreamPhase(
      "flowReady",
      _sessionIdForBreadcrumbs,
      () => deps.flowReady?.catch(() => {}) ?? Promise.resolve(),
    );

    // Upgrade to OAuth-backed provider on first turn if tokens are available.
    await preStreamPhase("initOAuthProvider", _sessionIdForBreadcrumbs, () => deps.initOAuthProvider().catch(() => {}));

    if (!deps.getSessionStartHookFired()) {
      deps.setSessionStartHookFired(true);
      const isResume = deps.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: deps.session?.id,
        cwd: deps.bash.getCwd(),
      };
      const sessionStartResult = await preStreamPhase("sessionStartHook", _sessionIdForBreadcrumbs, () =>
        deps.fireHook(sessionStartInput, signal).catch(() => ({
          blocked: false,
          blockingErrors: [] as Array<{ command: string; stderr: string }>,
          preventContinuation: false,
          additionalContexts: [] as string[],
          results: [] as import("../hooks/types.js").HookResult[],
        })),
      );
      // Inject the hook's stdout/additionalContext into THIS turn's stream
      // immediately — before PIL/routing decides DIRECT_ANSWER vs a tool
      // turn. A no-tool DIRECT_ANSWER turn never reaches the PreToolUse
      // content-yield path (tool-engine.ts), so without this the very first
      // reply of a session could never show a SessionStart hook's output
      // (e.g. a project's own onboarding briefing script).
      const _sessionStartContexts = (sessionStartResult?.additionalContexts ?? []).filter((ctx) => !!ctx?.trim());
      // Round 12 (F2/G14): rendered as ONE bounded, clearly-tagged notice
      // block (see `formatSessionStartHookNotice`'s doc comment) instead of
      // one bare content chunk per raw context string — a distinct
      // system/notice item in the log, not indistinguishable assistant
      // prose, and never unbounded regardless of what the hook script prints.
      const _sessionStartNotice = formatSessionStartHookNotice(_sessionStartContexts);
      if (_sessionStartNotice) {
        yield { type: "content", content: `${_sessionStartNotice}\n` };
      }
      // Parity fix: the yield-loop above is UI-only — same gap as the
      // EE-guidance/recall-nudge system-message injections elsewhere in this
      // function (search "the model can actually see" in this file). Without
      // also pushing this into `deps.messages`, the MODEL never learns the
      // hook already ran: measured live, the model's own reasoning noted "a
      // system note about session start" and then tried to re-run the hook's
      // command itself on a turn that had no tools, leaking raw tool-call
      // markup as its answer. Claude Code's own SessionStart hooks give the
      // model `additionalContext` worded so it knows the content was already
      // shown — mirrored here as a `system` message, once per session (same
      // guard as the display loop above), ordered before this turn's own
      // user message so it reads as prior context, not a reply to ask about.
      if (_sessionStartNotice) {
        // Round 2 (G1 HIGH): REPLACE, don't append — a `--resume` process
        // rehydrates the persisted transcript first, so a tagged message
        // from a PRIOR process may already be sitting in `deps.messages`.
        // Remove it before pushing the fresh one, keeping `deps.messages`/
        // `deps.messageSeqs` in lockstep (parallel arrays, same index).
        const _priorTaggedIdx = deps.messages.findIndex(
          (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(SESSION_START_SYSTEM_TAG),
        );
        if (_priorTaggedIdx !== -1) {
          deps.messages.splice(_priorTaggedIdx, 1);
          deps.messageSeqs.splice(_priorTaggedIdx, 1);
        }
        deps.messages.push({
          role: "system",
          content: `${SESSION_START_SYSTEM_TAG} — already shown to the user verbatim above; do not re-run it or repeat it\n${_sessionStartNotice.slice(SESSION_START_SYSTEM_TAG.length + 1)}`,
        });
        deps.messageSeqs.push(null);
      }
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: deps.session?.id,
      cwd: deps.bash.getCwd(),
    };
    await preStreamPhase("userPromptSubmitHook", _sessionIdForBreadcrumbs, () =>
      deps.fireHook(promptInput, signal).catch(() => {}),
    );

    await preStreamPhase("consumeBackgroundNotifications", _sessionIdForBreadcrumbs, () =>
      deps.consumeBackgroundNotifications(),
    );

    const _debugOn = isDebugEnabled();
    const _debugSteps: PipelineStep[] = [];
    const _debugTurnId = deps.messages.filter((m) => m.role === "user").length + 1;

    // Start optional background enrichment; the leader receives the original prompt immediately.
    breadcrumb("pre-stream.pilPrep.start", { sessionId: _sessionIdForBreadcrumbs });
    const prepResult = prepareTurnContext(deps, userMessage, _budgetOverride);
    breadcrumb("pre-stream.pilPrep.end", { sessionId: _sessionIdForBreadcrumbs });
    const { pilCtx, pilSupplement, _stepCeiling, _pilStart, _naturalCeiling, _ceilingTaskType, _ceilingSize } =
      prepResult;

    try {
      const cwd = deps.bash.getCwd();
      if (
        isGsdNativeEnabled() &&
        shouldRunGate(pilCtx, () => {
          try {
            return readState(cwd).phase;
          } catch (err) {
            // Missing/corrupt .planning state is the normal "no active run" case, not an error.
            console.error(
              `[pil-gate] readState failed while checking resume phase (treating as no active run): ${(err as Error).message}`,
            );
            return null;
          }
        })
      ) {
        // Local workflow synchronization only. Background PIL cannot change depth or gate state.
        try {
          const sessionModel = deps.session?.model ?? deps.modelId;
          const depth = pilCtx.modelDepthTier ?? "standard";
          getGsdLoopHost().ensureHost(cwd, sessionModel);
          syncWorkflowContext(cwd, sessionModel, depth);
        } catch (err) {
          logger.error("orchestrator", "Local workflow synchronization failed", { error: String(err), cwd });
        }
      }

      // Track whether forced-finalize is needed (set by stopWhen when the
      // ceiling fires). Read AFTER the streamText fullStream finishes.
      const _ceilingHit = false;

      // Cheap signal forwarded from PIL Layer 1 — true when input is greeting /
      // small-talk (≤10 chars + ≤2 words OR brain-classified "none"). Used to
      // skip the MCP tool catalog, which dominates input tokens (~20K) and is
      // useless for "hi" / "ok" / "thanks".
      const isChitchat = pilCtx.intentKind === "chitchat";
      let enrichedMessage = pilCtx.enriched;
      if (pilCtx.fallbackReason) {
        // Surface PIL degradation to the model so it can calibrate trust in
        // routing, taskType, and any injected directives. Without this the
        // agent has no idea the 200ms fast-path or discovery timeout fired.
        enrichedMessage = `[PIL fallback: ${pilCtx.fallbackReason} — classification/routing may be inaccurate or layers skipped; using raw input.]\n\n${enrichedMessage}`;
      }
      deps.setPilActive(pilCtx.taskType !== null);
      deps.setPilEnrichmentDelta(
        pilCtx.metrics?.suffixInstructionTokens ??
          Math.round(((enrichedMessage ?? "").length - userMessage.length) / 4),
      );
      const _pilEnrichmentDeltaSnapshot =
        pilCtx.metrics?.suffixInstructionTokens ??
        Math.round(((enrichedMessage ?? "").length - userMessage.length) / 4);

      // P1 Item 3 wiring: phase-boundary detection. setPhase returns a snapshot
      // of the prior phase iff the phase NAME just changed. We classify the
      // outcome (pass/fail/abandoned/null) and fire phase-outcome to the EE
      // server when there is a high-SNR verdict. Endpoint is feature-flagged
      // server-side; 404 is silently swallowed by the client wrapper.
      try {
        const drained = phaseTracker.setPhase(pilCtx.gsdPhase ?? null);
        if (drained && drained.principleRefs.length > 0 && deps.session?.id) {
          const outcome = phaseTracker.classifyOutcome(drained);
          if (outcome) {
            fireAndForgetPhaseOutcome(
              {
                sessionId: deps.session.id,
                phaseName: drained.phaseName,
                outcome,
                toolEventIds: drained.principleRefs,
                evidence: {
                  durationMs: drained.endedAt - drained.startedAt,
                  toolCount: drained.toolCount,
                  cwd: deps.bash.getCwd(),
                  ...(drained.verifyResult ? { verifyResult: drained.verifyResult } : {}),
                  ...(drained.aborted ? { aborted: true } : {}),
                  ...(drained.abortReason ? { abortReason: drained.abortReason } : {}),
                },
              },
              {
                ...(getCachedServerBaseUrl() ? { baseUrl: getCachedServerBaseUrl()! } : {}),
                ...(getCachedAuthToken() ? { authToken: getCachedAuthToken()! } : {}),
              },
            );
          }
        }
      } catch {
        /* fail-open: phase-outcome must never block a turn */
      }

      if (_debugOn) {
        const appliedLayers = pilCtx.layers?.filter((l) => l.applied).map((l) => l.name) ?? [];
        _debugSteps.push({
          name: "Background PIL preparation",
          duration_ms: Date.now() - _pilStart,
          input_summary: `"${userMessage.slice(0, 60)}${userMessage.length > 60 ? "..." : ""}"`,
          output_summary: `task=${pilCtx.taskType ?? "none"} domain=${pilCtx.domain ?? "none"} layers=[${appliedLayers.join(",")}]`,
          tokens_saved: _pilEnrichmentDeltaSnapshot > 0 ? _pilEnrichmentDeltaSnapshot : undefined,
        });
      }

      // Interaction log: PIL classification
      breadcrumb("pre-stream.pilInteractionLog.start", { sessionId: _sessionIdForBreadcrumbs });
      try {
        if (deps.session) {
          const pilDurationMs = Date.now() - _pilStart;
          // BUG-B telemetry — hash the raw user message so post-hoc queries can
          // detect Layer 1 classifier drift on identical inputs within a session.
          const { createHash } = await import("node:crypto");
          const _userMsgSha8 = createHash("sha1").update(userMessage).digest("hex").slice(0, 8);
          logInteraction(deps.session.id, "pil", {
            eventSubtype: "background-start",
            durationMs: pilDurationMs,
            data: {
              userMsgSha8: _userMsgSha8,
              userMsgPreview: userMessage.slice(0, 60),
              layers: pilCtx.layers?.filter((l) => l.applied).map((l) => l.name) ?? [],
              fullLayers: pilCtx.layers?.map((l) => ({ name: l.name, applied: l.applied, delta: l.delta })) ?? [],
              layerCount: pilCtx.layers?.length ?? 0,
              layerTimings: pilCtx.metrics?.layerTimings ?? null,
              domain: pilCtx.domain,
              confidence: pilCtx.confidence,
              outputStyle: pilCtx.outputStyle,
              intentKind: pilCtx.intentKind ?? null,
              mcpSkipped: isChitchat,
              fallbackReason: pilCtx.fallbackReason ?? null,
              eeMode: (await import("../ee/client-mode.js")).getCachedEEClientMode()?.mode ?? "unknown",
            },
          });
          logInteraction(deps.session.id, "user_message", {
            data: {
              raw_length: userMessage.length,
              enriched_length: enrichedMessage.length,
              taskType: pilCtx.taskType,
              intentKind: pilCtx.intentKind ?? null,
              confidence: pilCtx.confidence,
              pilActive: pilCtx.taskType !== null,
            },
          });
        }
      } catch {
        /* fail-open */
      }
      breadcrumb("pre-stream.pilInteractionLog.end", { sessionId: _sessionIdForBreadcrumbs });

      // ROUTE-11: Per-turn model routing via decide() — picks cheapest capable model
      const turnStartMs = Date.now();
      let turnModelId = deps.modelId;
      let taskHash: string | null = null;
      let routeReason: string | null = null;
      const historyHasImages = deps.messages.some(
        (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image"),
      );
      const turnHasImages = (images?.length ?? 0) > 0;
      let visionUnavailableNotice: string | null = null;
      const _routeStart = Date.now();
      breadcrumb("pre-stream.routerDecide.start", { sessionId: _sessionIdForBreadcrumbs });
      // Gap (d) / round-2 fix: a project-level `.muonroi-cli/settings.json`
      // `{"model": "..."}` pin is an explicit instruction, not a mere default
      // the per-turn router may second-guess for the MAIN conversation turn
      // (see `isModelPinnedByProject`'s doc comment) — but the cap/budget
      // reservation + downgrade-chain/halt check must still run against
      // whatever model actually ends up executing. Passing `forcedModel` makes
      // decide() skip ONLY the free model-choice classifier ladder
      // (role/PIL/hot/warm/cold) while still routing the pinned model through
      // the SAME capCheck any other decision goes through — see
      // `DecideOpts.forcedModel`'s doc comment in router/decide.ts. A prior
      // version of this fix skipped decide() entirely for a pinned turn, which
      // also skipped that cap check (round-2 refuter finding, HIGH). Cheap
      // sub-tasks (tool-loop rounds in tool-engine.ts, council sub-tasks) call
      // decide()/routeModel() through their own, separate paths and are
      // unaffected — they may still downgrade independently of the pin.
      {
        const pinnedModel = options?.retainModel || isModelPinnedByProject() ? deps.modelId : undefined;
        try {
          const { decide } = await import("../router/decide.js");
          const compactionMsg = deps.messages.find(
            (m) => typeof m.content === "string" && m.content.startsWith("[Context checkpoint summary]"),
          );
          const compactionSummary =
            compactionMsg && typeof compactionMsg.content === "string"
              ? compactionMsg.content.slice("[Context checkpoint summary]".length).trim()
              : null;

          const routeDecision = await decide(userMessage, {
            tenantId: "local",
            cwd: deps.bash.getCwd(),
            defaultModel: deps.modelId,
            defaultProvider: deps.providerId,
            ...(pinnedModel ? { forcedModel: pinnedModel } : {}),
            pil: {
              domain: pilCtx.domain,
              taskType: pilCtx.taskType,
              confidence: pilCtx.confidence,
              gsdPhase: pilCtx.gsdPhase ?? null,
              activeRunId: pilCtx.activeRunId ?? null,
              recentTurnsSummary: deps.buildRecentTurnsSummary(),
              projectSize: deps.estimateProjectSize(),
              filesTouched: deps.countFilesTouched(),
              mode: deps.mode,
              turnIndex: deps.messages.filter((m) => m.role === "user").length,
              messageCount: deps.messages.length,
              compactionCount: deps.getCompactionStats().count,
              totalSavedTokens: deps.getCompactionStats().totalSaved,
              compactionSummary,
            },
          });
          if (routeDecision.model && routeDecision.model !== "HALT") {
            // Respect user's default model when it has a vision proxy and the
            // current turn (or history) has images — the proxy will convert
            // images to text, so there's no need to switch to a vision-capable
            // (and usually pricier / rate-limited) model.
            const defaultHasVisionProxy = needsVisionProxy(deps.modelId);
            const imagesOnTurn = turnHasImages || historyHasImages;
            const canHandleImages =
              !defaultHasVisionProxy || !imagesOnTurn || (await canHandleImagesForTextOnlyModel(deps.modelId));
            const skipVisionRoute = defaultHasVisionProxy && imagesOnTurn && canHandleImages;
            if (!skipVisionRoute) {
              turnModelId = routeDecision.model;
            }
          }
          taskHash = routeDecision.taskHash ?? null;
          routeReason = routeDecision.reason ?? null;
          // Update status bar with router switch info. Also reset back to the
          // session default when the router does NOT switch on this turn —
          // otherwise the bar stays "stuck" showing the previously-routed model
          // (e.g. claude-sonnet-4-6) on later turns that actually run on the
          // user's chosen default (e.g. deepseek-v4-flash).
          if (turnModelId !== deps.modelId) {
            statusBarStore.setState({ routed_from: deps.modelId, model: turnModelId });
          } else {
            const prev = statusBarStore.getState();
            if (prev.routed_from || prev.model !== deps.modelId) {
              statusBarStore.setState({ routed_from: null, model: deps.modelId });
            }
          }
          if (_debugOn) {
            _debugSteps.push({
              name: "Router",
              duration_ms: Date.now() - _routeStart,
              input_summary: `default=${deps.modelId}`,
              output_summary: turnModelId !== deps.modelId ? `routed→${turnModelId}` : `kept ${turnModelId}`,
            });
          }
        } catch {
          // Router unavailable — use session default model (skip if provider is disabled)
          if (!isProviderDisabled(deps.providerId as ProviderId)) {
            const eeRoute = await routeModel(userMessage, {}, deps.providerId).catch(() => null);
            taskHash = eeRoute?.taskHash ?? null;
          }
        }
        breadcrumb("pre-stream.routerDecide.end", { sessionId: _sessionIdForBreadcrumbs });
      }

      if (needsVisionProxy(turnModelId) && (turnHasImages || historyHasImages)) {
        breadcrumb("pre-stream.visionPlan.start", { sessionId: _sessionIdForBreadcrumbs });
        const imageCount = turnHasImages ? images!.length : 1;
        const plan = await planImageHandlingForTextOnlyModel({
          primaryModelId: turnModelId,
          imageCount,
        });
        if (plan.strategy === "native_model") {
          turnModelId = plan.fallback.modelId;
          routeReason = routeReason ? `${routeReason}; vision-native-fallback` : "vision-native-fallback";
          yield {
            type: "content",
            content: `[Vision: routed to ${plan.fallback.modelId} — no proxy backend; using native image support]\n`,
          };
        } else if (plan.strategy === "unavailable") {
          visionUnavailableNotice = plan.notice;
        }
        breadcrumb("pre-stream.visionPlan.end", { sessionId: _sessionIdForBreadcrumbs });
      }

      // Interaction log: model routing
      try {
        if (deps.session) {
          const promoted = turnModelId !== deps.modelId;
          logInteraction(deps.session.id, "routing", {
            model: turnModelId,
            eventSubtype: promoted ? "promoted" : "default",
            data: {
              defaultModel: deps.modelId,
              routedModel: turnModelId,
              promoted,
              // promo-cap(...) tag appears here when the promotion ceiling clamped
              // an EE premium pick down to balanced — queryable via event_subtype +
              // data.reason to audit cost-leak prevention (session 89b34ce9a4e8 class).
              reason: routeReason,
              taskHash,
              pilTaskType: pilCtx.taskType ?? null,
              pilIntentKind: pilCtx.intentKind ?? null,
            },
          });
        }
      } catch {
        /* fail-open */
      }

      // Re-detect provider if router picked a model from a different provider
      breadcrumb("pre-stream.providerRedetect.start", { sessionId: _sessionIdForBreadcrumbs });
      const turnProviderId = detectProviderForModel(turnModelId);
      let turnProvider: LegacyProvider;
      if (turnProviderId !== deps.providerId) {
        const disabled = isProviderDisabled(turnProviderId as ProviderId);
        // Even if the key is reachable, skip disabled providers
        const turnKey = !disabled ? await loadKeyForProvider(turnProviderId).catch(() => null) : null;
        // An OAuth-capable provider may be authenticated by subscription tokens
        // (no env API key). Detect that so the turn can still run over OAuth.
        let hasOAuth = false;
        if (!disabled) {
          try {
            const { getOAuthProviderConfig } = await import("../providers/auth/registry.js");
            const cfg = await getOAuthProviderConfig(turnProviderId as ProviderId);
            const tokens = cfg ? await cfg.loadTokensWithRefresh().catch(() => null) : null;
            hasOAuth = !!tokens?.accessToken;
          } catch {
            hasOAuth = false;
          }
        }
        if (turnKey || hasOAuth) {
          // OAuth XOR API key: the ASYNC factory injects OAuth (codex baseURL +
          // Bearer headers) when tokens exist for this provider, otherwise it
          // uses the env key. Using the sync factory here was the cross-provider
          // shadowing bug (it shipped a stale sk-proj key to api.openai.com).
          const { createProviderFactoryAsync } = await import("../providers/runtime.js");
          const built = await createProviderFactoryAsync(turnProviderId, turnKey ? { apiKey: turnKey } : {});
          turnProvider = built.factory;
        } else {
          // Router's provider unreachable or disabled — fall back to a non-disabled provider
          const fallback = await deps.councilManager.resolveNonDisabledFallback();
          turnModelId = fallback.modelId;
          turnProvider = deps.requireProvider();
        }
      } else if (isProviderDisabled(deps.providerId as ProviderId)) {
        // Session provider is disabled — find a non-disabled alternative
        const fallback = await deps.councilManager.resolveNonDisabledFallback();
        turnModelId = fallback.modelId;
        turnProvider = deps.requireProvider();
      } else {
        turnProvider = deps.requireProvider();
      }
      breadcrumb("pre-stream.providerRedetect.end", { sessionId: _sessionIdForBreadcrumbs });

      // E4: prepend one-shot cwd note when setCwd() changed the working directory
      // mid-session. Clears after injection so only the first subsequent turn sees it.
      const cwdNote = deps.getPendingCwdNote();
      deps.setPendingCwdNote(null);
      const messageForDb = cwdNote ? `${cwdNote}\n\n${userMessage}` : userMessage;
      // Append raw input so the model can distinguish system enrichment from user's original text.
      const rawSuffix = pilCtx.raw && pilCtx.raw !== enrichedMessage ? `\n\n[Raw user input]\n${pilCtx.raw}` : "";
      const messageForModel = (cwdNote ? `${cwdNote}\n\n${enrichedMessage}` : enrichedMessage) + rawSuffix;

      let userModelMessage: ModelMessage;
      let userEnrichedMessage: ModelMessage;
      if (images?.length) {
        const partsDb: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [
          { type: "text", text: messageForDb },
        ];
        const partsModel: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> =
          [{ type: "text", text: messageForModel }];
        for (const img of images) {
          partsDb.push({ type: "image", image: img.base64, mediaType: img.mediaType });
          partsModel.push({ type: "image", image: img.base64, mediaType: img.mediaType });
        }
        userModelMessage = { role: "user", content: partsDb };
        userEnrichedMessage = { role: "user", content: partsModel };
      } else {
        userModelMessage = { role: "user", content: messageForDb };
        userEnrichedMessage = { role: "user", content: messageForModel };
      }

      // Vision proxy: convert images to text for models that don't support vision.
      // Process BOTH the current user message and any historical messages that
      // still carry image parts — otherwise sending the conversation back to a
      // text-only provider (e.g. DeepSeek) fails with "unknown variant
      // `image_url`" once history contains an image from a prior turn.
      if (needsVisionProxy(turnModelId) && (turnHasImages || historyHasImages)) {
        breadcrumb("pre-stream.visionProxy.start", { sessionId: _sessionIdForBreadcrumbs });
        const stripImagesFromMessages = (msgs: ModelMessage[]): ModelMessage[] =>
          msgs.map((m) => {
            if (!Array.isArray(m.content)) return m;
            const textParts = (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text");
            const joined = textParts.map((p) => p.text ?? "").join("\n");
            return { ...m, content: joined || "[image removed — vision unavailable]" } as typeof m;
          });

        if (visionUnavailableNotice) {
          yield {
            type: "content",
            content: "[Vision: cannot analyze images — no vision API key or vision model available]\n",
          };
          if (historyHasImages) {
            deps.setMessages(
              stripImagesFromMessages(deps.messages).map((m) => {
                if (m.role !== "user" || typeof m.content !== "string") return m;
                return { ...m, content: `${m.content}\n\n${visionUnavailableNotice}` };
              }),
            );
          }
          if (turnHasImages) {
            userModelMessage = {
              role: "user",
              content: `${messageForDb}\n\n${visionUnavailableNotice}`,
            };
            userEnrichedMessage = {
              role: "user",
              content: `${messageForModel}\n\n${visionUnavailableNotice}`,
            };
          }
        } else {
          try {
            if (historyHasImages) {
              const historyResult = await proxyVision(deps.messages, turnModelId, signal, deps.session?.id);
              if (historyResult.proxied) {
                deps.setMessages(historyResult.messages);
                yield {
                  type: "content",
                  content: `[Vision proxy: ${historyResult.imageCount} historical image(s) → text]\n`,
                };
              }
            }
            if (turnHasImages) {
              const proxyResult = await proxyVision(
                [userModelMessage, userEnrichedMessage],
                turnModelId,
                signal,
                deps.session?.id,
              );
              if (proxyResult.proxied) {
                userModelMessage = proxyResult.messages[0];
                userEnrichedMessage = proxyResult.messages[1];
                yield {
                  type: "content",
                  content: `[Vision proxy: ${proxyResult.imageCount} image(s) analyzed for ${turnModelId}]\n`,
                };
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[vision-proxy] message path failed: ${errMsg}`);
            const notice = visionUnavailableNotice ?? `[vision unavailable: ${errMsg}]`;
            yield { type: "content", content: "[Vision proxy: failed — images not sent to model]\n" };
            if (historyHasImages) {
              deps.setMessages(stripImagesFromMessages(deps.messages));
            }
            if (turnHasImages) {
              userModelMessage = { role: "user", content: `${messageForDb}\n\n${notice}` };
              userEnrichedMessage = { role: "user", content: `${messageForModel}\n\n${notice}` };
            }
          }
        }
        breadcrumb("pre-stream.visionProxy.end", { sessionId: _sessionIdForBreadcrumbs });
      }

      deps.messages.push(userModelMessage);
      // Phase A5 — write-ahead the user row so `recordUsage` mid-stream can
      // attribute usage to a real `message_seq` instead of falling back to
      // NULL (or to the previous turn's assistant seq for a session that has
      // multi-turn history). The post-stream `appendCompletedTurn(...)` path
      // upserts the same row to `status='completed'` via the
      // `ON CONFLICT(session_id, seq) DO UPDATE` clause in `appendMessages`.
      let userWriteAheadSeq: number | null = null;
      if (deps.session) {
        try {
          userWriteAheadSeq = getNextMessageSequence(deps.session.id);
          persistMessageWriteAhead(deps.session.id, userWriteAheadSeq, "user", JSON.stringify(userModelMessage));
        } catch {
          // Fail-open: if seq lookup throws, fall back to the legacy NULL
          // path. The forensics anomaly returns but the turn proceeds.
          userWriteAheadSeq = null;
        }
      }
      deps.messageSeqs.push(userWriteAheadSeq);

      // Inject accumulated EE session guidance as a system message so the model
      // is informed of past warnings before making tool decisions this turn.
      // Keep one current snapshot, including after resume or compaction.
      let guidanceContent: string | undefined;
      if (deps.sessionEEGuidance.size > 0) {
        const lines = Array.from(deps.sessionEEGuidance.entries()).map(([, g]) => {
          const pct = Math.round(g.confidence * 100);
          return `- [${g.toolName}] ${g.message} (Why: ${g.why}) [${pct}%]`;
        });
        guidanceContent = `[EE Session Guidance — avoid these patterns when using tools]\n${lines.join("\n")}`;
      }
      refreshSessionGuidance(deps.messages, deps.messageSeqs, guidanceContent);

      // Fix 3: inject pending recall-feedback nudge as a system message the
      // model can actually see. Previously recall reminders were yield-content
      // (UI-only) — the model never read them. Inject at turn start so the
      // agent can batch-rate hints at the beginning of its next response,
      // before diving into the user's new task. Deduped by sha like guidance.
      try {
        const { sessionRecallLedger, isRecallLedgerEnabled, isRecallNagSuppressed } = await import(
          "../ee/recall-ledger.js"
        );
        // Suppressed when the caller declared this turn MACHINE-READ (see
        // recall-ledger.ts). The nag would otherwise instruct a sub-agent whose
        // only job is to emit a verdict marker to go do EE bookkeeping first.
        if (isRecallLedgerEnabled() && !isRecallNagSuppressed()) {
          const pending = sessionRecallLedger.pending();
          if (pending.length > 0) {
            const hintLines = pending
              .slice(0, 10)
              .map(
                (p) =>
                  `  - ee_feedback(id="${p.id}", collection="${p.collection ?? "?"}", verdict=followed|ignored|noise)`,
              );
            const more = pending.length > 10 ? `\n  ...and ${pending.length - 10} more` : "";
            const recallContent =
              `↳ ${pending.length} earlier EE hint(s) still unrated. Rate the one(s) you actually ` +
              `acted on so the brain keeps what helped — this does NOT block the task; batch the ` +
              `ee_feedback call(s) alongside your work, don't stall the user's request on it.\n` +
              `Verdict: followed (you used it) | ignored (topical, didn't apply) | noise (wrong — needs reason).\n` +
              `${hintLines.join("\n")}${more}\n` +
              `Rate once and move on — a hint you can't judge yet, leave for later; re-rating the same ` +
              `id does not help. If the brain is unreachable the verdict is queued, so never retry-loop on it.`;

            const sid = deps.session?.id ?? "_anon";
            const { createHash: _recallHash } = await import("node:crypto");
            const recallSha = _recallHash("sha256").update(recallContent).digest("hex").slice(0, 16);
            const recallKey = `recall_${sid}`;
            if (_injectedRecallSha.get(recallKey) !== recallSha) {
              _injectedRecallSha.set(recallKey, recallSha);
              deps.messages.push({ role: "system", content: recallContent });
              deps.messageSeqs.push(null);
            }
          }
        }
      } catch {
        /* fail-open — EE unreachable is never a blocker */
      }

      const provider = turnProvider;
      const subagents = loadValidSubAgents();
      const _pilResponseTools = getResponseToolSet(pilCtx, deps.providerId);
      const _hasResponseTools = Object.keys(_pilResponseTools).length > 0;
      const systemParts = buildSystemPromptParts(
        deps.bash.getCwd(),
        deps.mode,
        deps.bash.getSandboxMode(),
        deps.getPlanContext(),
        subagents,
        deps.bash.getSandboxSettings(),
        deps.providerId,
        deps.getResumeDigest(),
        { chitchat: isChitchat },
      );
      // F3c — tool-turn system prompt: same context, but skips native-capabilities
      // and skills sections (~4K tokens) that the model already saw on the first
      // call.  The orchestrator switches to this on the 2nd+ streamText invocation.
      const toolTurnParts = buildSystemPromptParts(
        deps.bash.getCwd(),
        deps.mode,
        deps.bash.getSandboxMode(),
        deps.getPlanContext(),
        subagents,
        deps.bash.getSandboxSettings(),
        deps.providerId,
        deps.getResumeDigest(),
        { chitchat: isChitchat, toolTurn: true },
      );
      if (deps.getResumeDigest()) deps.setResumeDigest(null);
      // Skip vision/playwright guidance unless the user's message has a URL
      // or browser/screenshot vocabulary. ~400 tokens of routing hints
      // the model only needs when it might call a browser MCP.
      const _browserGuidanceNeeded =
        /https?:\/\/\S+|\b(screenshot|browser|playwright|chrome|figma|canva|render|webpage|website|url|hyperlink|navigate|click|scrape)\b/i.test(
          userMessage,
        );
      const playwrightGuidance = isChitchat || !_browserGuidanceNeeded ? "" : getVisionGuidanceForTextOnly(turnModelId);
      const system = applyModelConstraints(
        applyPilSuffix(
          `${systemParts.staticPrefix}${playwrightGuidance}${systemParts.dynamicSuffix}`,
          pilCtx,
          _hasResponseTools,
        ),
        turnModelId,
      );
      // Tool-turn system: same template as system but with toolTurn-prefix
      const toolTurnSystem = applyModelConstraints(
        applyPilSuffix(
          `${toolTurnParts.staticPrefix}${playwrightGuidance}${toolTurnParts.dynamicSuffix}`,
          pilCtx,
          _hasResponseTools,
        ),
        turnModelId,
      );
      const runtime = resolveModelRuntime(turnModelId, { stage: "main", sessionId: deps.session?.id });
      const modelInfo = runtime.modelInfo;

      // Keep the user's static routing choice. Server advice is optional leader information.
      const stepRouterCfg = getStepRouterConfig();
      // Parity fix (G3): same pin the earlier decide()/forcedModel gate uses
      // (see "Gap (d) / round-2 fix" above) — SAMR must not downgrade a
      // pinned orchestrator turn's tool-continuation steps. See
      // decideStepRouting's `opts.pinned` doc comment in router/step-router.ts.
      const stepRouterDecision = decideStepRouting(turnModelId, deps.providerId, stepRouterCfg, {
        pinned: options?.retainModel || isModelPinnedByProject(),
      });
      const stepRouterPhase: "phase1" | "phase2" | "done" = stepRouterDecision.phase2ModelId ? "phase1" : "done";
      const phase2Runtime = stepRouterDecision.phase2ModelId
        ? resolveModelRuntime(stepRouterDecision.phase2ModelId, { stage: "main", sessionId: deps.session?.id })
        : null;
      if (stepRouterDecision.phase2ModelId && _debugOn) {
        _debugSteps.push({
          name: "StepRouter",
          duration_ms: 0,
          input_summary: `phase1=${turnModelId}`,
          output_summary: stepRouterDecision.reason,
        });
      }

      // Phase 5 continuation fix: do not clear planContext on bare "tiếp tục"/"continue".
      // Re-hydrate from persisted approved plan if needed (cross-process or after abort).
      const _isCont = isContinuationPhrase(userMessage);
      if (!_isCont) {
        deps.setPlanContext(null);
      } else if (!deps.getPlanContext()) {
        const _p = getLastApprovedPlan(deps.session?.id ?? "");
        if (_p) deps.setPlanContext(_p);
      }
      const attemptedOverflowRecovery = false;
      // Stream-retry state: track how many transient retries have been attempted
      // for the current turn. Reset to 0 on each new user turn (we're in processMessage).
      const streamRetryCount = 0;
      const MAX_STREAM_RETRIES = 2; // 3 total attempts = 1 first try + 2 retries
      // Re-steer budget for a tool-call emitted as plain text (wrong dialect). One
      // corrective retry: if the model still emits text instead of invoking the
      // tool, we surface the warning and stop rather than loop. Loop-persistent so
      // a model that degrades every step can't burn unbounded re-steers.
      const textToolReSteerCount = 0;
      const MAX_TEXT_TOOL_RESTEER = 2; // DeepSeek often needs 2 re-steers (DSML text → real tool call)
      const patternLoopInjectCount = 0;
      const patternLoopForceHalt = false;
      const agentLoopDecisionCount = 0;
      const MAX_AGENT_LOOP_DECISIONS = 2;
      // Silent-hang guard: set true when the stall watchdog aborts a stuck stream.
      // Reset before each streamText attempt; read in the stream catch to surface a
      // clear toast and SKIP the transient-retry (a stalled provider just stalls
      // again, wasting another full timeout of silence).
      try {
        yield* executeToolEngine({
          deps,
          ownsController,
          stepRouterPhase,
          phase2Runtime,
          runtime,
          modelInfo,
          _debugSteps,
          _ceilingHit,
          userMessage,
          pilCtx,
          pilSupplement,
          turnModelId,
          turnProvider,
          _stepCeiling,
          userModelMessage,
          userEnrichedMessage,
          signal,
          observer,
          taskHash,
          provider,
          system,
          toolTurnSystem,
          routerStore,
          attemptedOverflowRecovery,
          patternLoopForceHalt,
          userWriteAheadSeq,
          streamRetryCount,
          MAX_STREAM_RETRIES,
          subagents,
          systemParts,
          playwrightGuidance,
          _hasResponseTools,
          _pilResponseTools,
          patternLoopInjectCount,
          agentLoopDecisionCount,
          MAX_AGENT_LOOP_DECISIONS,
          _naturalCeiling,
          _ceilingTaskType,
          _ceilingSize,
          textToolReSteerCount,
          MAX_TEXT_TOOL_RESTEER,
          turnStartMs,
          _debugOn,
          _debugTurnId,
          _pilEnrichmentDeltaSnapshot,
          isChitchat,
        });
      } finally {
        // A1: always detach the P0 aborter — see the declaration site above for
        // why this is mandatory now that `signal` can be a long-lived, reused
        // owner signal rather than always a fresh, GC-eligible one.
        signal.removeEventListener("abort", aborter);
        // A1: only the call that OWNS the controller may clear it. A nested
        // call (ownsController === false) reused the owner's controller and
        // must never null it out from under the still-running owner.
        if (ownsController && deps.getAbortController()?.signal === signal) {
          deps.setAbortController(null);
        }
        // Meter the C3 same-turn re-serve cost — the dedup deliberately re-bills
        // full content on same-turn re-reads (avoiding a worse single-read
        // fallback), and that cost was invisible. Emit cumulative per session so
        // cost-leak analysis can attribute it and a future policy fix is
        // falsifiable. Only when there is something to report.
        const dstats = deps.crossTurnDedup?.getStats();
        if (deps.session?.id && dstats && (dstats.sameTurnReservedChars > 0 || dstats.staleReserves > 0)) {
          logInteraction(deps.session.id, "dedup", {
            data: {
              hits: dstats.hits,
              sameTurnReserves: dstats.sameTurnReserves,
              sameTurnReservedChars: dstats.sameTurnReservedChars,
              approxTokens: Math.round(dstats.sameTurnReservedChars / 4),
              // Pointer-reachability repairs. Each staleReserve is a re-serve that
              // replaced a pointer at a payload compaction had already removed —
              // i.e. a nine-call dead-pointer loop that did not happen. Logged so
              // the dedup↔compaction fix stays falsifiable from the DB alone.
              staleReserves: dstats.staleReserves,
              staleReservedChars: dstats.staleReservedChars,
              invalidated: dstats.invalidated,
            },
          });
        }
      }
    } finally {
      pilSupplement.cancel();
    }
  }
}

export function stripDsmlMarkup(text: string): string {
  if (!text) return "";
  // Strip entire <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls> block including content
  let cleaned = text.replace(/<[^>]*｜｜DSML｜｜tool_calls[^>]*>[\s\S]*?<\/?[^>]*｜｜DSML｜｜tool_calls[^>]*>/gi, "");
  // Also strip any individual invoke/parameter tags with U+FF5C bars
  cleaned = cleaned.replace(/<[^>]*｜｜DSML｜｜[^>]*>/gi, "");
  return cleaned.trim();
}

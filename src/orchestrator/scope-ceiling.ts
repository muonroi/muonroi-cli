/**
 * src/orchestrator/scope-ceiling.ts
 *
 * Phase 04 Plan 04 (4B) — per-session step ceiling + forced-finalize.
 *
 * Resolves `(task_type × complexity_size)` into a hard step budget. When the
 * budget is hit, the orchestrator makes ONE final LLM call with
 * `toolChoice: "none"` (forced-finalize) so the cheap model synthesizes a
 * partial answer from accumulated context BEFORE the user sees a silent halt.
 *
 * The matrix is LOCKED verbatim by the Phase 4 CONTEXT (see
 * `.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md` §
 * "Step ceiling + forced-finalize (4B)"). DO NOT alter cells without re-running
 * the baseline regression harness.
 *
 * Session counter lives on `globalThis.__muonroiSessionStepCount: Map<string,
 * number>` — same lifecycle pattern as the 4R bash repeat detector + Phase C3
 * cross-turn dedup. The counter is per-session, NOT per-turn: a wandering
 * agent that bursts 50 tools across 3 user turns still trips the ceiling.
 *
 * Override grammar: `--budget-rounds N` parsed off the raw prompt BEFORE PIL
 * classifies, so the flag never reaches the model and never biases intent
 * classification.
 *
 * Zero Hardcode Rule: NO model / provider IDs in this module. `forcedFinalize`
 * receives the already-resolved model from its caller.
 */

import { withDeadlineRace, withTimeoutSignal } from "../utils/llm-deadline.js";
import { getProviderStallTimeoutMs } from "../utils/settings.js";

export type TaskType = "analyze" | "debug" | "refactor" | "generate" | "plan" | "documentation" | "general";

export type ComplexitySize = "small" | "medium" | "large";

// ---------------------------------------------------------------------------
// Ceiling matrix — LOCKED VERBATIM by Phase 4 CONTEXT.
// ---------------------------------------------------------------------------

const CEILING_MATRIX: Record<TaskType, Record<ComplexitySize, number>> = {
  analyze: { small: 5, medium: 10, large: 15 },
  debug: { small: 6, medium: 12, large: 20 },
  refactor: { small: 8, medium: 14, large: 22 },
  generate: { small: 10, medium: 18, large: 30 },
  plan: { small: 4, medium: 8, large: 12 },
  documentation: { small: 5, medium: 8, large: 12 },
  general: { small: 5, medium: 10, large: 20 },
};

const KNOWN_TASK_TYPES = new Set<string>(Object.keys(CEILING_MATRIX));

/**
 * Resolve the hard step ceiling for a (taskType, size) cell. Unknown task
 * types fall back to the `general` row per the locked spec — keeps the system
 * graceful when PIL emits an out-of-band label or null.
 */
export function resolveCeiling(taskType: string, size: ComplexitySize): number {
  // `build` (greenfield creation, PIL Pass-0) is not a row in the LOCKED matrix.
  // It is the highest-effort task — scaffolding many files — so it borrows the
  // `generate` ceiling (10/18/30) rather than falling back to the tight `general`
  // row (5/10/20), which would force-finalize a greenfield build far too early.
  const normalized = taskType === "build" ? "generate" : taskType;
  const row: TaskType = normalized && KNOWN_TASK_TYPES.has(normalized) ? (normalized as TaskType) : "general";
  return CEILING_MATRIX[row][size];
}

/**
 * Soft-warn step computation. Triggers the scope-reminder (4A handoff) once
 * the orchestrator reaches floor(ceiling × 0.7) — gives the agent a chance to
 * close cleanly before the hard halt.
 */
export function softWarnStep(ceiling: number): number {
  return Math.floor(ceiling * 0.7);
}

// ---------------------------------------------------------------------------
// parseBudgetOverride — `--budget-rounds N` extracted BEFORE PIL.
// ---------------------------------------------------------------------------

// Matches `--budget-rounds 20` anywhere in the prompt. Up to 5 digits is enough
// (max sane override is well below 100k). Surrounding whitespace is consumed so
// stripping the flag does not leave double spaces.
const BUDGET_OVERRIDE_RE = /(^|\s)--budget-rounds\s+(\d{1,5})(\s|$)/;

export interface BudgetOverrideResult {
  override: number | undefined;
  cleanedPrompt: string;
}

export function parseBudgetOverride(raw: string): BudgetOverrideResult {
  if (!raw) return { override: undefined, cleanedPrompt: raw ?? "" };
  const match = raw.match(BUDGET_OVERRIDE_RE);
  if (!match) return { override: undefined, cleanedPrompt: raw };
  const n = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(n) || n <= 0) return { override: undefined, cleanedPrompt: raw };
  // Strip the entire matched segment including its leading/trailing whitespace
  // and re-collapse the surrounding spaces.
  const cleaned = `${raw.slice(0, match.index ?? 0)} ${raw.slice((match.index ?? 0) + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { override: n, cleanedPrompt: cleaned };
}

// ---------------------------------------------------------------------------
// Session counter — globalThis-backed, mirrors 4R bash repeat detector pattern.
// ---------------------------------------------------------------------------

interface GlobalCounterHost {
  __muonroiSessionStepCount?: Map<string, number>;
}

function getCounterMap(): Map<string, number> {
  const host = globalThis as unknown as GlobalCounterHost;
  if (!host.__muonroiSessionStepCount) {
    host.__muonroiSessionStepCount = new Map<string, number>();
  }
  return host.__muonroiSessionStepCount;
}

export function getSessionStepCount(sessionId: string): number {
  return getCounterMap().get(sessionId) ?? 0;
}

export function incSessionStep(sessionId: string): number {
  const map = getCounterMap();
  const next = (map.get(sessionId) ?? 0) + 1;
  map.set(sessionId, next);
  return next;
}

export function resetSessionStep(sessionId: string): void {
  getCounterMap().delete(sessionId);
}

// ---------------------------------------------------------------------------
// Phase 5 — Session last-task ceiling row.
//
// When a user's continuation message ("tiếp tục" / "continue") is classified
// chitchat by PIL Layer 1 Pass 0, the natural ceiling resolution collapses
// from the original task's row (e.g. generate × medium = 18) to general ×
// small = 5. After turn 1 used 18 tools, any continuation would be halted
// almost immediately because the per-session step counter never resets.
//
// Fix part 2: record the (taskType, size) of every NON-chitchat turn so
// continuation turns can inherit it. The lifetime mirrors __muonroiSessionStepCount
// — global Map, cleared at process exit. Memory is bounded (one entry per
// active session).
// ---------------------------------------------------------------------------

interface GlobalLastTaskHost {
  __muonroiSessionLastTask?: Map<string, { taskType: string; size: ComplexitySize }>;
}

function getLastTaskMap(): Map<string, { taskType: string; size: ComplexitySize }> {
  const host = globalThis as unknown as GlobalLastTaskHost;
  if (!host.__muonroiSessionLastTask) {
    host.__muonroiSessionLastTask = new Map<string, { taskType: string; size: ComplexitySize }>();
  }
  return host.__muonroiSessionLastTask;
}

/** Record the most recent NON-chitchat (taskType, size) for this session. */
export function recordSessionLastTask(sessionId: string, taskType: string, size: ComplexitySize): void {
  if (!sessionId || !taskType || taskType === "general") return;
  getLastTaskMap().set(sessionId, { taskType, size });
}

/** Read the most recent non-chitchat task row, or null when none recorded. */
export function getSessionLastTask(sessionId: string): { taskType: string; size: ComplexitySize } | null {
  if (!sessionId) return null;
  return getLastTaskMap().get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// forcedFinalize — single LLM call with toolChoice:"none" after ceiling hit.
// ---------------------------------------------------------------------------

export interface ForcedFinalizeOptions {
  /** AI-SDK language model instance (already resolved by caller). */
  model: unknown;
  /** Accumulated conversation history at the point of halt. */
  messages: unknown[];
  /** Optional system prompt — caller passes the SAME prompt used during the run. */
  system?: string;
  /**
   * Test-only injection. Production callers MUST omit this. When present, the
   * implementation skips the AI SDK call and returns the value verbatim — used
   * in unit tests so we can exercise the signature without spinning up the
   * provider runtime.
   */
  __testInvoke?: () => Promise<{ text: string }>;
}

export interface ForcedFinalizeResult {
  text: string;
}

/**
 * Make one final LLM call with `toolChoice: "none"` to coerce a text-only
 * synthesis from the model. The caller appends `text` to the assistant output,
 * then emits the `halted: step ceiling exceeded ...` toast.
 *
 * NOTE: this helper deliberately keeps its signature minimal. Callers in
 * message-processor and stream-runner adapt their existing streamText
 * scaffolding (system + messages + providerOptions) and pass the same model.
 */
export async function forcedFinalize(opts: ForcedFinalizeOptions): Promise<ForcedFinalizeResult> {
  if (opts.__testInvoke) {
    return opts.__testInvoke();
  }
  // Lazy import keeps test-only paths from paying the AI SDK import cost.
  // Stream + collect (NOT generateText): codex/oauth 400s non-stream requests.
  const { generateTextStreamed } = await import("./../providers/streamed-generate.js");
  // Cast to `any` at the call boundary — the AI SDK's generic Prompt shape
  // requires either `prompt` xor `messages`, and we have already validated
  // `messages` shape at the orchestrator caller. Keeping types loose here
  // keeps this helper provider-agnostic per the Zero Hardcode Rule.
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK generic call boundary
  const callArgs: any = {
    model: opts.model,
    messages: opts.messages,
    toolChoice: "none",
    maxRetries: 0,
  };
  if (opts.system) callArgs.system = opts.system;
  // Bound the forced-finalize call: a wedged provider response must not freeze
  // the orchestrator silently (no streamText stall watchdog covers this call).
  const { signal: timedSignal, cleanup: cleanupTimeout } = withTimeoutSignal(undefined, getProviderStallTimeoutMs());
  callArgs.abortSignal = timedSignal;
  try {
    const result = await withDeadlineRace(
      () => generateTextStreamed(callArgs),
      getProviderStallTimeoutMs() + 5_000,
      "forced_finalize",
    );
    return { text: result.text ?? "" };
  } finally {
    cleanupTimeout();
  }
}

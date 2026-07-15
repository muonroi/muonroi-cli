/**
 * src/pil/llm-classify.ts
 *
 * Layer 1 Pass 4 — LLM classification fallback.
 *
 * Fires only when the EE brain (pilContext) returned null OR confidence < 0.7.
 * Uses the user's currently-configured model via a closure provided by the
 * orchestrator at runPipeline() call site. This keeps PIL ignorant of provider
 * factories — it just receives a `classify(prompt)` callback.
 *
 * Output contract: { taskType, outputStyle, confidence } or null on failure.
 * Cost target: <200 input tokens, <10 output tokens per call (~$0.0001 on
 * DeepSeek Flash). Timeout 2500ms — bails fast if the model stalls.
 */
import { appendFileSync } from "node:fs";
import { streamText } from "ai";
import { getModelInfo, SWITCH_PROVIDER_ORDER } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { getConfiguredProviders, loadKeyForProvider, ProviderKeyMissingError } from "../providers/keychain.js";
import type { ProviderFactory } from "../providers/runtime.js";
import { createProviderFactoryAsync, resolveModelRuntime } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { getRoutedModelByTier } from "../router/peak-hour.js";
import { isProviderDisabled } from "../utils/settings.js";
import type { OutputStyle, TaskType } from "./types.js";

/**
 * What the user wants the turn to PRODUCE — decided by the model (Phase 2b) so
 * the keyword-regex predicates in Layer 4 (`informational`) and Layer 6
 * (`getResponseToolSet` / `applyPilSuffix`) are no longer the authority for
 * output routing.
 *   - "code"   — create/edit files (implement, fix, build, refactor, scaffold).
 *   - "report" — a structured list/plan/audit/roadmap is the deliverable.
 *   - "answer" — an explanation / review / question / meta answer (no edits).
 * `null` when the model omits/garbles the word → Layer 4/6 fall back to their
 * legacy regex predicates for that turn (graceful, never a wrong forced route).
 */
export type DeliverableKind = "answer" | "code" | "report";

/**
 * Model-decided WORK DEPTH for the turn — the agent-first replacement for the
 * old regex `scoreComplexity` tier. Decided by the same single classify call so
 * it costs no extra round-trip. Drives the GSD rubric injected by Layer 4:
 *   - "quick"    — trivial single-shot (typo, one-liner, small lookup/answer). No plan.
 *   - "standard" — ordinary feature/bugfix touching a few files. Short plan + verify.
 *   - "heavy"    — architectural / multi-file / wide / ambiguous. Full
 *                  discuss → research → plan → check-plan → implement → verify.
 * `null` when the model omits/garbles the word → Layer 4 defaults to "standard"
 * (the safe middle) and the injected rubric lets the agent self-select.
 */
export type DepthTier = "quick" | "standard" | "heavy";

export interface LlmClassifyResult {
  taskType: TaskType;
  outputStyle: OutputStyle | null;
  confidence: number;
  /**
   * Whether the prompt is a real request (task) or pure social chitchat
   * (greeting / thanks / ack). Decided by the model so the regex chitchat
   * shortcuts (isSocialPleasantry, ultra-short heuristic) are no longer the
   * authority. Defaults to "task" when the model omits the signal — the
   * keep-tools safe direction (a false "task" wastes ~1.5K tokens of tool
   * schema; a false "chitchat" strips bash/read and BREAKS the turn).
   */
  intentKind: "task" | "chitchat";
  /**
   * Model-decided output deliverable (answer | code | report). null when the
   * model omitted the word — consumers then fall back to their legacy regex.
   */
  deliverableKind: DeliverableKind | null;
  /**
   * Model-decided work depth (quick | standard | heavy). null when the model
   * omitted/garbled the word — Layer 4 then defaults to "standard". This is the
   * agent-first replacement for the regex complexity scorer: depth is judged by
   * what the task actually entails, not by which keywords it happens to contain.
   */
  depthTier: DepthTier | null;
  /**
   * Model-decided clarity: true when the request is UNDERSPECIFIED — missing
   * information the agent would need to proceed without guessing (an unstated
   * target/scope, a vague "make it better", competing interpretations, or an
   * unresolved design choice). Drives the interview gate: a `standard`-depth
   * task that is underspecified earns a clarify/council pass instead of hot-
   * pathing straight to implementation. `false` = well-specified enough to plan
   * directly. null when the model omitted the word → treated as not-
   * underspecified (the don't-over-ask safe direction). Agent-first replacement
   * for the regex `scoreSufficiency` scorer.
   */
  needsClarification: boolean | null;
  /**
   * Model-decided scope: true when the turn is about the Muonroi PLATFORM /
   * ecosystem (BB/.NET packages, building-block, open-core, rule engine,
   * platform setup) — where the muonroi-docs MCP is the authoritative source —
   * as opposed to muonroi-cli's own internals. Agent-first replacement for the
   * `mentionsEcosystemScope` regex. null when the model omitted the word →
   * Layer 4 treats it as not-ecosystem (no docs nudge).
   */
  ecosystemScope: boolean | null;
  /**
   * The language the user wrote in, as a capitalized display name (e.g.
   * "Vietnamese", "Japanese"), or null when the user wrote in English / the
   * model omitted it. Drives Layer 4's language re-anchor nudge. Agent-first
   * replacement for the Vietnamese-only diacritic regex — generalizes to ANY
   * non-English language.
   */
  replyLanguage: string | null;
}

/**
 * Options for a classify call. `recentTurns` is a compact digest of the last
 * few conversation turns; when present the classifier uses it ONLY to resolve
 * back-references in the new message (e.g. "từ các phần đó", "làm tiếp", "this")
 * so a terse follow-up that points at heavy prior work is not mis-scored as a
 * trivial one-liner. Without it the classifier sees the bare prompt and is blind
 * to context — the documented "chấm điểm chỉ dựa only prompt" failure.
 */
export interface LlmClassifyOptions {
  recentTurns?: string | null;
  signal?: AbortSignal;
}

export type LlmClassifyFn = (prompt: string, opts?: LlmClassifyOptions) => Promise<LlmClassifyResult | null>;

/**
 * Factory-level options for `createLlmClassifier` (distinct from the per-call
 * `LlmClassifyOptions`). Chosen once when the closure is built.
 */
export interface CreateClassifierOptions {
  /**
   * Route the throwaway classify to the provider's fast tier when one exists
   * (mirrors `classifySubSessionAction`). Same-provider only, so the already-
   * bound factory/key still works. A no-op when the provider exposes no
   * routable fast model (e.g. xai). Zero-hardcode: the fast id comes from
   * `getRoutedModelByTier`, not a literal. Cheap — safe on every turn.
   */
  routeFastTier?: boolean;
  /**
   * When the session provider has NO same-provider fast tier (e.g. xai, whose
   * session model may be an agentic model that ignores the terse classify
   * contract — measured 2026-07-15 for grok-composer), also try keyed fast
   * models from OTHER configured providers, in catalog switch order, until one
   * parses. Bounded by CLASSIFY_TOTAL_BUDGET_MS so a chain of dead/slow keys
   * can't stall the turn. This adds latency ONLY on that fallback path, so it is
   * opt-in per call-site: enable it for the high-value /ideal routing classify,
   * NOT for the per-turn PIL classify (there a fast fail-open "standard" is fine
   * and cheaper than chaining providers on every message).
   */
  crossProviderFallback?: boolean;
}

// Single flat classify ceiling for EVERY model. Harness-measured latency
// (2026-07-15, grok-composer via OAuth, 7 samples) is 1045–1277ms — no tested
// model (agentic balanced OR fast flash) approaches even the legacy 2.5s cap,
// so a tier-scaled timeout was solving a non-existent latency problem: the
// /ideal over-engineering root cause was NOT a timeout abort but grok-composer
// ignoring the terse contract (it emits task-planning prose, never the 8-word
// line → null → fail-open). The ceiling is a pure safety net: a healthy model
// returns in <1.5s, so the headroom only bites a genuinely stuck call. Data-
// driven off measurement, not an identity/tier proxy string.
const CLASSIFY_TIMEOUT_MS = 8000;
// Absolute wall-clock cap for the WHOLE classify (every candidate AND its
// self-repair). Enforced via a shared deadline passed into attemptClassify, so
// a run of dead/hanging keys — or one legitimately slow reasoning model —
// degrades to fail-open in bounded time. Sized to fit a healthy reasoning fast
// model twice over: deepseek-v4-flash measured 2026-07-15 answers a classify in
// ~2–5s (with a valid key), so 10s leaves room for one candidate + a self-repair
// before the deadline. A dead key ahead of it (auth-fails in ~0.2s) barely eats
// the budget; only a genuinely hanging candidate consumes it.
const CLASSIFY_TOTAL_BUDGET_MS = 10_000;
// Floor for any single streamText attempt's own timeout, so a nearly-exhausted
// deadline still gives a final candidate a real (if short) chance rather than an
// instant abort.
const CLASSIFY_MIN_ATTEMPT_MS = 1200;
// Eight comma-separated words now (added <clarity>) — ~20-30 tokens worst case
// ("documentation,balanced,task,report,standard,ecosystem,vietnamese,underspecified").
// 56 keeps headroom without padding (the model still stops after eight words).
const NONREASONING_MAX_OUTPUT_TOKENS = 56;
const REASONING_MAX_OUTPUT_TOKENS = 2048;

/**
 * Compute the classify call budget from the resolved model's catalog metadata.
 *
 * TIMEOUT is a flat safety-net ceiling for all models — see CLASSIFY_TIMEOUT_MS.
 * Measurement showed classify latency is provider-independent and well under
 * the ceiling, so keying the timeout off `tier`/`reasoning` added no value and
 * amounted to an identity-proxy soft-hardcode.
 *
 * MAX-OUTPUT scales with REASONING only: a reasoning model burns its output
 * budget on reasoning tokens before any visible text, so it needs the room in
 * tokens; a non-reasoning model emits the 8 words directly. This knob is real —
 * it is the fix for reasoning models routing the verdict into the reasoning
 * channel — and stays decoupled from the (now flat) timeout.
 */
export function classifierBudget(modelInfo: { reasoning?: boolean; tier?: string } | undefined): {
  isReasoning: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
} {
  const isReasoning = modelInfo?.reasoning === true;
  return {
    isReasoning,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    maxOutputTokens: isReasoning ? REASONING_MAX_OUTPUT_TOKENS : NONREASONING_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Session-scoped cache of cross-provider factories built for the throwaway
 * classify. Keyed by provider so the OAuth-aware build (keychain read + token
 * refresh) happens at most once per provider per process, not per turn.
 */
const crossFactoryCache = new Map<ProviderId, ProviderFactory>();

/** Test seam — clear the cross-provider factory cache between specs. */
export function __resetClassifyFactoryCache(): void {
  crossFactoryCache.clear();
}

/**
 * Build (or reuse) a real factory for a DIFFERENT provider than the session's,
 * so the throwaway classify can run on a keyed instruction-following model when
 * the session provider has none. Mirrors the council's `resolveCouncilFactory`:
 * `loadKeyForProvider` for API-key providers, falling back to
 * `createProviderFactoryAsync` for OAuth-only providers (injects the bearer
 * token). Failures degrade gracefully (logged, returns undefined → caller keeps
 * the session model). Never throws.
 */
async function resolveCrossProviderClassifyFactory(providerId: ProviderId): Promise<ProviderFactory | undefined> {
  const cached = crossFactoryCache.get(providerId);
  if (cached) return cached;
  try {
    let apiKey: string | undefined;
    try {
      apiKey = await loadKeyForProvider(providerId);
    } catch (err) {
      if (!(err instanceof ProviderKeyMissingError)) throw err;
      // OAuth-only provider — createProviderFactoryAsync injects the bearer token.
    }
    const { factory } = await createProviderFactoryAsync(providerId, apiKey ? { apiKey } : {});
    crossFactoryCache.set(providerId, factory);
    return factory;
  } catch (err) {
    console.error(
      `[pil.llm-classify] cross-provider classify factory build failed for ${providerId}: ${(err as Error)?.message}`,
    );
    return undefined;
  }
}

/**
 * Ordered list of keyed fast-tier models from providers OTHER than the session's,
 * for the throwaway classify. Candidate order is the catalog's vendor-defined
 * `switch_provider_order` (zero-hardcode), gated by `getConfiguredProviders`
 * (the authoritative credential check — unifies API key / env / OAuth) and the
 * user's disabled-provider setting. The caller tries them in order and falls
 * through to the next on an auth/stream failure — so a configured-but-DEAD key
 * (e.g. an expired deepseek key) doesn't strand the classify at fail-open.
 * Empty when no other provider is configured with a fast tier → caller keeps the
 * session model (status quo).
 */
async function pickCrossProviderClassifyModels(
  excludeProvider: ProviderId | undefined,
): Promise<Array<{ modelId: string; providerId: ProviderId }>> {
  let configured: Set<ProviderId>;
  try {
    configured = new Set(await getConfiguredProviders());
  } catch (err) {
    console.error(`[pil.llm-classify] getConfiguredProviders failed for classify route: ${(err as Error)?.message}`);
    return [];
  }
  const out: Array<{ modelId: string; providerId: ProviderId }> = [];
  for (const p of SWITCH_PROVIDER_ORDER as readonly ProviderId[]) {
    if (p === excludeProvider) continue;
    if (isProviderDisabled(p)) continue;
    if (!configured.has(p)) continue;
    const m = getRoutedModelByTier("fast", p);
    if (m && m.provider === p) out.push({ modelId: m.id, providerId: p });
  }
  return out;
}

/**
 * Per-namespace shallow merge of providerOptions. The base already carries
 * factory-level defaults folded into the provider namespace (e.g. OAuth
 * `store:false`); the overlay only overrides specific keys (reasoningEffort)
 * within the same namespace, so defaults survive.
 */
function mergeProviderOptions(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!overlay) return base;
  if (!base) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [ns, val] of Object.entries(overlay)) {
    const baseNs = (base[ns] as Record<string, unknown> | undefined) ?? {};
    out[ns] = { ...baseNs, ...(val as Record<string, unknown>) };
  }
  return out;
}

const VALID_TASK_TYPES = new Set<TaskType>([
  "refactor",
  "debug",
  "plan",
  "analyze",
  "documentation",
  "generate",
  "general",
]);

const VALID_STYLES = new Set<OutputStyle>(["concise", "balanced", "detailed"]);

const VALID_DEPTHS = new Set<DepthTier>(["quick", "standard", "heavy"]);

// Every token the classifier can legitimately emit for the first six fields.
// Used to isolate the 7th field (language), which is open-vocabulary: the lang
// word is the one alphabetic token that is NOT a known enum value.
const KNOWN_CLASSIFY_WORDS = new Set<string>([
  "refactor",
  "debug",
  "plan",
  "analyze",
  "documentation",
  "generate",
  "general",
  "concise",
  "balanced",
  "detailed",
  "task",
  "chat",
  "chitchat",
  "answer",
  "code",
  "report",
  "quick",
  "standard",
  "heavy",
  "ecosystem",
  "local",
  "clear",
  "underspecified",
]);

const SYSTEM_PROMPT =
  "You classify user prompts for a coding assistant. Reply with ONE line of EIGHT lowercase words separated by commas: <taskType>,<style>,<intent>,<deliverable>,<depth>,<scope>,<lang>,<clarity>\n\n" +
  "The message may be preceded by a '[RECENT CONVERSATION]' block. Use it ONLY to resolve what a terse follow-up refers to (e.g. 'từ các phần đó', 'làm tiếp', 'debate mode đi', 'this one'); then classify the NEW message. Crucially, if the new message points back at heavy prior work, its depth is the depth of THAT work — a short sentence like 'ok debate these parts and plan improvements' is NOT quick just because it is short. Never classify the conversation block itself.\n\n" +
  "taskType ∈ { refactor | debug | plan | analyze | documentation | generate | general }\n" +
  "style ∈ { concise | balanced | detailed }\n" +
  "intent ∈ { task | chat } — 'chat' ONLY for a pure greeting, thanks, or acknowledgement with NO work request (e.g. 'hi', 'cảm ơn nhé', 'ok great'). EVERYTHING else is 'task', including questions about code or the CLI, 'are you done?', and requests to call a tool. When unsure, choose 'task'.\n" +
  "deliverable ∈ { answer | code | report } — what the user wants you to PRODUCE this turn:\n" +
  "- code — CREATE or EDIT files: implement, fix, build, scaffold, refactor, wire, rename, apply a patch. The deliverable is changed code.\n" +
  "- report — a STRUCTURED list / plan / audit / roadmap / checklist is the deliverable (its value IS the structure).\n" +
  "- answer — everything else: explain, review, investigate, compare, a question about code or the CLI, a yes/no question, a meta/self-eval. The deliverable is a written answer, NO file edits.\n" +
  "  Pick by the PRIMARY thing the user asked you to produce. A question that merely mentions code is 'answer'. When unsure between answer and report, choose answer.\n" +
  "depth ∈ { quick | standard | heavy } — how much work the task ACTUALLY entails (judge the work, NOT the wording; a plainly-phrased request can still be heavy):\n" +
  "- quick — a trivial single-shot change or a small direct answer: typo, rename one symbol, one-line edit, a quick lookup, 'what does X do'. No plan needed.\n" +
  "- standard — ordinary feature or bugfix touching a handful of files/functions; needs a short plan + a verify step, but no upfront research or user discussion.\n" +
  "- heavy — architectural, cross-cutting, multi-file/multi-module, a migration, 'redo/rebuild', a vague 'make it better', or a request with real unresolved design choices. Needs discussion + research + a checked plan before any code.\n" +
  "  BREADTH decides heavy, NOT how clearly the steps are spelled out. A migration, vendoring an external dependency's code in-tree, or a rename/restructure that spans MANY files or modules is ALWAYS heavy — even when the plan is fully specified and it 'just' has to keep tests green. Do not downgrade a wide change to standard because it sounds mechanical.\n" +
  "  For a pure question/answer (deliverable=answer), depth reflects how much investigation the answer needs: 'quick' for a simple fact, 'standard' for a normal explanation, 'heavy' for a deep architectural review.\n" +
  "  When unsure between quick and standard, choose standard. When the task is genuinely wide or ambiguous, choose heavy.\n" +
  "clarity ∈ { clear | underspecified } — whether the request gives enough to proceed WITHOUT guessing:\n" +
  "- underspecified — missing information the agent would need: an unstated target/scope ('add auth' — which flow?), a vague 'make it better' with no direction, competing interpretations, or an unresolved design choice. Such a task should be clarified with the user before code.\n" +
  "- clear — well-specified enough to plan and execute directly, even if large. A fully-spelled-out migration is 'clear'. When unsure, choose 'clear' (do NOT over-ask on ordinary work).\n" +
  "scope ∈ { ecosystem | local }:\n" +
  "- ecosystem — the turn is about the Muonroi PLATFORM as a whole: the building-block / .NET packages, open-core boundary, the rule engine / decision tables, NuGet packages, or platform setup/install. These are documented in an authoritative docs source.\n" +
  "- local — EVERYTHING else, including questions about this CLI's own internals (even when they mention the word 'muonroi'). When unsure, choose local.\n" +
  "lang — the language the user's message is written in, as ONE lowercase English word: english, vietnamese, japanese, french, etc. Use 'english' for English or when unsure.\n\n" +
  "Rules (read carefully — Phase 4 4P-2 disambiguation):\n" +
  "- debug — fix a bug, CI/build/test failure, error, exception, crash, or any 'why is X broken' question.\n" +
  "- generate — create new code, scaffold, write a new file, add a feature from scratch, ADD A NEW TEST, CHANGE A DEFAULT VALUE, modify configuration, improve coverage.\n" +
  "- refactor — ONLY when the user explicitly says rename, restructure, reorganize, extract, inline, move, migrate, or reshape existing code WITHOUT adding new behavior. Words like 'improve', 'change', 'update', 'fix', 'modify' are NOT refactor — pick the closest specific category instead.\n" +
  "- plan — architecture, roadmap, multi-step design, strategy.\n" +
  "- analyze — explain, review, inspect, audit, compare, find-out-why existing code/data.\n" +
  "- documentation — write docs, comments, JSDoc, README.\n" +
  "- general — chitchat or unclear intent. Prefer 'general' over guessing refactor.\n\n" +
  "Negative examples (these are NOT refactor):\n" +
  "- 'đổi default --max-tool-rounds từ 8 sang 12' → generate (changes a default value)\n" +
  "- 'improve test coverage' → generate (adds new tests)\n" +
  "- 'tại sao bash_output_get trả empty' → analyze (investigate behavior)\n" +
  "- 'fix CI failing on Windows' → debug\n" +
  "Positive refactor examples:\n" +
  "- 'rename function shouldInjectReminder to needsReminderAt' → refactor\n" +
  "- 'extract this into a helper' → refactor\n" +
  "- 'migrate from class component to hooks' → refactor\n\n" +
  "Style picking — MANDATORY mapping (do NOT deviate):\n" +
  "- debug, refactor, generate → concise (action tasks; the diff is the answer)\n" +
  "- analyze → concise (bullet findings, no narrative)\n" +
  "- plan → balanced (steps need brief rationale)\n" +
  "- documentation → balanced (examples + explanation)\n" +
  "- general → concise\n" +
  "Only output 'detailed' if the user prompt LITERALLY contains words like 'explain in detail', 'thorough analysis', 'walk me through', 'giải thích chi tiết', 'phân tích kỹ'.\n\n" +
  "Full examples (taskType,style,intent,deliverable,depth,scope,lang,clarity):\n" +
  "- 'hi' → general,concise,chat,answer,quick,local,english,clear\n" +
  "- 'cảm ơn bạn nhé' → general,concise,chat,answer,quick,local,vietnamese,clear\n" +
  "- 'bạn xong chưa' → general,concise,task,answer,quick,local,vietnamese,clear (a question — NOT chat)\n" +
  "- 'fix the typo in the README title' → generate,concise,task,code,quick,local,english,clear\n" +
  "- 'fix CI failing on Windows' → debug,concise,task,code,standard,local,english,clear\n" +
  "- 'rename function shouldInject to needsReminder' → refactor,concise,task,code,quick,local,english,clear\n" +
  "- 'thêm caching cho provider layer và update tests' → generate,concise,task,code,standard,local,vietnamese,clear\n" +
  "- 'tại sao bash_output_get trả empty' → analyze,concise,task,answer,standard,local,vietnamese,clear\n" +
  "- 'liệt kê tất cả env var CLI đọc' → analyze,concise,task,report,standard,local,vietnamese,clear\n" +
  "- 'refactor the entire auth system to use OAuth' → refactor,concise,task,code,heavy,local,english,clear\n" +
  "- 'vendor the used subset of the gsd package natively into src and rename gsd to workflow, keep tests green' → refactor,concise,task,code,heavy,local,english,clear (a migration spanning many files — heavy even though fully specified)\n" +
  "- 'add auth' → generate,concise,task,code,standard,local,english,underspecified (which flow/provider? unstated)\n" +
  "- 'làm cho CLI tốt hơn' → generate,concise,task,code,heavy,local,vietnamese,underspecified (vague 'make it better', no target)\n" +
  "- 'how does the building-block rule engine work' → analyze,concise,task,answer,standard,ecosystem,english,clear\n" +
  "- 'hệ sinh thái muonroi gồm những gì' → analyze,balanced,task,answer,standard,ecosystem,vietnamese,clear\n" +
  "- 'plan the migration to hooks' → plan,balanced,task,report,heavy,local,english,clear\n\n" +
  "Prompts may be Vietnamese, English, or mixed. Reply with exactly eight words separated by commas. No other text.";

// Appended to SYSTEM_PROMPT on the self-repair retry (see createLlmClassifier).
// The first attempt produced an unparseable reply; this reminder + the full
// (untrimmed) prompt is the agent-first recovery the design mandates INSTEAD of
// a keyword-regex fallback.
const CLASSIFY_REPAIR_INSTRUCTION =
  "REPAIR MODE: your previous reply could NOT be parsed. Output NOTHING except the single line of eight lowercase words separated by commas — no prose, no explanation, no code fences, no quotes. If you are unsure of a field, pick the safe default (task, standard, clear, local).";

function parseResponse(raw: string): LlmClassifyResult | null {
  const cleaned = raw.trim().toLowerCase().replace(/[`*"]/g, "");
  const firstLine = cleaned.split(/\r?\n/)[0] ?? "";
  const parts = firstLine
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const taskWord = parts[0] as TaskType;
  if (!VALID_TASK_TYPES.has(taskWord)) return null;
  const styleWord = parts[1] as OutputStyle | undefined;
  const style = styleWord && VALID_STYLES.has(styleWord) ? styleWord : null;
  // Third word is the chitchat-vs-task intent. Only an explicit "chat" marks
  // chitchat; anything else (including a missing/garbled word) defaults to
  // "task" — the keep-tools safe direction.
  const intentWord = parts.find((p) => p === "chat" || p === "chitchat" || p === "task");
  const intentKind: "task" | "chitchat" = intentWord === "chat" || intentWord === "chitchat" ? "chitchat" : "task";
  // Fourth word is the output deliverable. Parsed position-independently so a
  // reordered/garbled reply still recovers it; null when absent → Layer 4/6 use
  // their legacy regex predicates for this turn (never a wrong forced route).
  const deliverableWord = parts.find((p) => p === "answer" || p === "code" || p === "report");
  const deliverableKind: DeliverableKind | null = (deliverableWord as DeliverableKind | undefined) ?? null;
  // Fifth word is the model-decided work depth. Parsed position-independently so
  // a reordered/garbled reply still recovers it; null when absent → Layer 4
  // defaults to "standard" and the injected rubric lets the agent self-select.
  const depthWord = parts.find((p) => VALID_DEPTHS.has(p as DepthTier));
  const depthTier: DepthTier | null = (depthWord as DepthTier | undefined) ?? null;
  // Sixth word is the scope. "ecosystem" → platform/docs-authoritative turn;
  // anything else (incl. absent) → not ecosystem. Position-independent.
  const scopeWord = parts.find((p) => p === "ecosystem" || p === "local");
  const ecosystemScope: boolean | null = scopeWord ? scopeWord === "ecosystem" : null;
  // Eighth word is the clarity signal. "underspecified" → the request is missing
  // information the agent needs → earn a clarify/council pass. Anything else
  // (incl. absent) → not underspecified (don't-over-ask safe direction).
  // Position-independent so a reordered/garbled reply still recovers it.
  const clarityWord = parts.find((p) => p === "clear" || p === "underspecified");
  const needsClarification: boolean | null = clarityWord ? clarityWord === "underspecified" : null;
  // Seventh word is the user's language. It is the one alphabetic token that is
  // NOT a known enum value (open vocabulary). null when English / absent so
  // Layer 4 skips the language re-anchor for English turns.
  const langWord = parts.find((p) => /^[a-z][a-z-]+$/.test(p) && !KNOWN_CLASSIFY_WORDS.has(p));
  const replyLanguage: string | null =
    langWord && langWord !== "english" && langWord !== "en"
      ? langWord.charAt(0).toUpperCase() + langWord.slice(1)
      : null;
  return {
    taskType: taskWord,
    outputStyle: style,
    confidence: 0.75,
    intentKind,
    deliverableKind,
    depthTier,
    needsClarification,
    ecosystemScope,
    replyLanguage,
  };
}

/**
 * Build a closure the PIL pipeline can call. Reuses the orchestrator's already-
 * constructed providerFactory + modelId so we don't pay key-loading cost twice.
 *
 * Returns null if the call fails / times out / parses to garbage. Callers must
 * fail-open (keep prior taskType, do not block the turn).
 */
export function createLlmClassifier(
  factory: ProviderFactory,
  modelId: string,
  classifyOpts?: CreateClassifierOptions,
): LlmClassifyFn {
  return async function classify(prompt: string, opts?: LlmClassifyOptions): Promise<LlmClassifyResult | null> {
    const signal = opts?.signal;
    const recentTurns = opts?.recentTurns;
    const debug = process.env.MUONROI_DEBUG_PIL_CLASSIFY === "1";

    // Bounded recent-conversation block so the classifier can resolve back-
    // references in a terse follow-up ("từ các phần đó", "làm tiếp", "this")
    // instead of scoring the isolated sentence. Same for every candidate.
    const trimmedRecent = recentTurns?.trim();
    const promptWithContext = trimmedRecent
      ? `[RECENT CONVERSATION — reference only, do NOT classify this]\n${trimmedRecent.slice(0, 800)}\n\n` +
        `[NEW USER MESSAGE — classify THIS; if it refers back to the conversation above, judge the depth of the work it actually entails]\n${prompt.slice(0, 600)}`
      : prompt.slice(0, 600);
    const fullRecent = recentTurns?.trim();
    const repairPrompt =
      (fullRecent
        ? `[RECENT CONVERSATION — reference only, do NOT classify this]\n${fullRecent.slice(0, 1500)}\n\n`
        : "") + `[NEW USER MESSAGE — classify THIS]\n${prompt.slice(0, 1500)}`;

    // One classify attempt against a single resolved model, including the
    // self-repair retry on that same model. Returns the parsed verdict, or null
    // (unparseable OR provider/stream error) so the caller can fall through to
    // the next candidate. Each attempt owns its AbortController/timer.
    const attemptClassify = async (
      runtime: ReturnType<typeof resolveModelRuntime>,
      cmId: string,
      deadlineMs: number,
    ): Promise<LlmClassifyResult | null> => {
      // Max-output scales with reasoning; each streamText timeout is bounded by
      // the shared deadline (min of the flat ceiling and the time left), so the
      // whole classify — this attempt AND its repair — never overruns the budget.
      const { isReasoning } = classifierBudget(runtime.modelInfo);
      const timeoutMs = Math.max(CLASSIFY_MIN_ATTEMPT_MS, Math.min(CLASSIFY_TIMEOUT_MS, deadlineMs - Date.now()));
      const dropMaxTokens = runtime.unsupportedParams?.includes("maxOutputTokens") === true;
      const maxOut = isReasoning ? REASONING_MAX_OUTPUT_TOKENS : NONREASONING_MAX_OUTPUT_TOKENS;

      // Minimize reasoning cost: force the lowest effort the provider exposes.
      let providerOptions = runtime.providerOptions;
      if (isReasoning && runtime.modelInfo?.supportsReasoningEffort && runtime.modelInfo.provider) {
        const lowEffort = getProviderCapabilities(runtime.modelInfo.provider).buildProviderOptions({
          model: runtime.modelInfo,
          reasoningEffort: "low",
        });
        providerOptions = mergeProviderOptions(runtime.providerOptions, lowEffort);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const combinedSignal = signal
        ? (AbortSignal.any?.([signal, controller.signal]) ?? controller.signal)
        : controller.signal;
      try {
        const t0 = Date.now();
        const result = streamText({
          model: runtime.model,
          abortSignal: combinedSignal,
          system: SYSTEM_PROMPT,
          prompt: promptWithContext,
          ...(dropMaxTokens ? {} : { maxOutputTokens: maxOut }),
          ...(providerOptions ? { providerOptions } : {}),
        });
        let text = "";
        let reasoningText = "";
        let streamError = "";
        const partCounts: Record<string, number> = {};
        for await (const part of result.fullStream) {
          if (debug) partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
          if (part.type === "text-delta") text += (part as any).textDelta ?? (part as any).text ?? "";
          else if (part.type === "reasoning-delta")
            reasoningText += (part as any).textDelta ?? (part as any).text ?? "";
          else if (part.type === "error") {
            const e = (part as any).error;
            streamError = e instanceof Error ? e.message : String(e ?? "unknown");
          }
        }
        const elapsedMs = Date.now() - t0;
        if (debug) {
          console.error(
            `[pil.llm-classify] raw(${cmId}${cmId !== modelId ? `←${modelId}` : ""}) ` +
              `maxOut=${dropMaxTokens ? "dropped" : maxOut} streamError=${JSON.stringify(streamError)} ` +
              `parts=${JSON.stringify(partCounts)} text<<<${text}>>> reasoning<<<${reasoningText.slice(0, 200)}>>>`,
          );
        }
        // Reasoning models occasionally route the entire answer into reasoning
        // parts (no committed text). Fall back to the reasoning channel.
        let parsed = parseResponse(text) ?? (reasoningText ? parseResponse(reasoningText) : null);

        // Metrics-only probe sink (env-gated): latency + parsed depth + any
        // stream error. NO prompt/response content — safe to leave wired.
        const probeLog = process.env.MUONROI_CLASSIFY_LATENCY_LOG;
        if (probeLog) {
          try {
            appendFileSync(
              probeLog,
              `${JSON.stringify({
                model: cmId,
                from: modelId === cmId ? undefined : modelId,
                tier: runtime.modelInfo?.tier,
                reasoning: isReasoning,
                timeoutMs,
                elapsedMs,
                textLen: text.length,
                reasoningLen: reasoningText.length,
                parsed: parsed != null,
                depth: parsed?.depthTier ?? null,
                streamError: streamError || undefined,
              })}\n`,
            );
          } catch (e) {
            console.error(`[pil.llm-classify] probe-log write failed: ${(e as Error)?.message}`);
          }
        }

        if (parsed) return parsed;

        // Surface a swallowed provider/transport error (No-Silent-Catch): a
        // stream `error` part means the call FAILED (auth/key/rate-limit), which
        // is categorically different from unparseable text. Before this fix such
        // errors vanished into a silent null → fail-open "standard". On error we
        // skip the same-model self-repair (it would fail identically) and let the
        // caller fall through to the next provider candidate.
        if (streamError) {
          console.error(
            `[pil.llm-classify] stream error on ${cmId} (from ${modelId}): ${streamError} — trying next candidate`,
          );
          return null;
        }

        // Self-repair (agent-first recovery — NOT a regex fallback): the reply
        // did not parse. Call the SAME model once more with the full prompt + an
        // explicit format-repair instruction on a doubled budget. Skip it when
        // too little of the shared deadline remains (the caller then falls
        // through to the next candidate / fails open).
        clearTimeout(timer);
        const repairBudget = deadlineMs - Date.now();
        if (repairBudget < 1500) return null;
        const repairTimeout = Math.max(CLASSIFY_MIN_ATTEMPT_MS, Math.min(CLASSIFY_TIMEOUT_MS, repairBudget));
        const repairController = new AbortController();
        const repairTimer = setTimeout(() => repairController.abort(), repairTimeout);
        const repairSignal = signal
          ? (AbortSignal.any?.([signal, repairController.signal]) ?? repairController.signal)
          : repairController.signal;
        try {
          const repairRun = streamText({
            model: runtime.model,
            abortSignal: repairSignal,
            system: `${SYSTEM_PROMPT}\n\n${CLASSIFY_REPAIR_INSTRUCTION}`,
            prompt: repairPrompt,
            ...(dropMaxTokens ? {} : { maxOutputTokens: maxOut * 2 }),
            ...(providerOptions ? { providerOptions } : {}),
          });
          let rt = "";
          let rr = "";
          for await (const part of repairRun.fullStream) {
            if (part.type === "text-delta") rt += (part as any).textDelta ?? (part as any).text ?? "";
            else if (part.type === "reasoning-delta") rr += (part as any).textDelta ?? (part as any).text ?? "";
          }
          parsed = parseResponse(rt) ?? (rr ? parseResponse(rr) : null);
          if (parsed) console.error(`[pil.llm-classify] self-repair recovered classification (${cmId})`);
          return parsed;
        } finally {
          clearTimeout(repairTimer);
        }
      } catch (err) {
        console.error(`[pil.llm-classify] classify attempt failed on ${cmId}: ${(err as Error)?.message}`, {
          stack: (err as Error)?.stack?.split("\n").slice(0, 3),
        });
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      // Build the ordered candidate list. Primary = same-provider fast tier (or
      // the session model); on NO same-provider fast tier (e.g. xai) append keyed
      // cross-provider fast models. Measured 2026-07-15: an agentic session model
      // (grok-composer) ignores the terse contract and emits task-planning prose
      // → null → fail-open "standard" (the /ideal over-engineering root cause);
      // and a configured-but-dead key (expired deepseek) errors. Trying
      // candidates in order until one parses fixes both.
      const candidates: Array<{ modelId: string; providerId: ProviderId | null }> = [];
      const provider = getModelInfo(modelId)?.provider as ProviderId | undefined;
      let primaryModelId = modelId;
      if (classifyOpts?.routeFastTier) {
        const sameFast = provider ? getRoutedModelByTier("fast", provider) : undefined;
        if (sameFast && sameFast.id !== modelId) primaryModelId = sameFast.id;
        if (classifyOpts?.crossProviderFallback && !sameFast && provider) {
          // No same-provider fast tier → the session model is presumed unsuited
          // to the terse classify (e.g. an agentic xai model that plans instead
          // of answering — measured 2026-07-15). Try keyed cross-provider FAST
          // instruction-followers FIRST (same principle as routeFastTier: prefer
          // a fast-tier model over a no-fast-tier session model), and keep the
          // session model only as the last-resort candidate.
          for (const c of await pickCrossProviderClassifyModels(provider)) {
            candidates.push({ modelId: c.modelId, providerId: c.providerId });
          }
          candidates.push({ modelId: primaryModelId, providerId: null });
        } else {
          candidates.push({ modelId: primaryModelId, providerId: null });
        }
      } else {
        candidates.push({ modelId: primaryModelId, providerId: null });
      }

      // Shared absolute deadline bounds the whole chain (each attempt + its
      // repair). A lone same-provider candidate (the common case) simply gets
      // the full flat ceiling within it.
      const chainDeadline = Date.now() + CLASSIFY_TOTAL_BUDGET_MS;
      for (const cand of candidates) {
        if (chainDeadline - Date.now() < 750) break; // too little left → fail-open
        const f = cand.providerId ? await resolveCrossProviderClassifyFactory(cand.providerId) : factory;
        if (!f) continue;
        let runtime: ReturnType<typeof resolveModelRuntime>;
        try {
          runtime = resolveModelRuntime(f, cand.modelId);
        } catch (e) {
          console.error(`[pil.llm-classify] resolveModelRuntime failed for ${cand.modelId}: ${(e as Error)?.message}`);
          continue;
        }
        const res = await attemptClassify(runtime, cand.modelId, chainDeadline);
        if (res) return res;
      }
      console.error(
        `[pil.llm-classify] all ${candidates.length} candidate(s) failed — surfacing UNKNOWN, NO regex fallback. ` +
          `rawPreview=${JSON.stringify(prompt.slice(0, 120))}`,
      );
      return null;
    } catch (err) {
      console.error(`[pil.llm-classify] classify failed: ${(err as Error)?.message}`, {
        modelId,
        stack: (err as Error)?.stack?.split("\n").slice(0, 3),
      });
      return null;
    }
  };
}

export type SubSessionAction = "DIRECT_ANSWER" | "ROTATE_SESSION" | "SPAWN_SUB_SESSION";

export interface SubSessionRouteResult {
  action: SubSessionAction;
  confidence: number;
  reason: string;
}

const ROUTER_SYSTEM_PROMPT =
  "You are a routing controller for an AI coding agent. Your goal is to decide the execution strategy for the user's prompt based on the conversation history and metadata.\n\n" +
  "Analyze the user's prompt and select one of the following ACTIONS:\n" +
  '- "DIRECT_ANSWER": The prompt is informational, a quick question, a code review, an explanation, greeting, or thanks. No file creation/modification, test execution, or multi-turn tool runs are needed.\n' +
  '- "ROTATE_SESSION": The user is starting a completely new topic or task unrelated to the active discussion (e.g. "let\'s switch to writing a python script", "forget the previous bug, show me how to..."). OR, if the session size (metadata) exceeds the rotation threshold and the active task is completed or the prompt starts a new focus, choose ROTATE_SESSION to prune/summarize the context.\n' +
  '- "SPAWN_SUB_SESSION": The user wants to execute a multi-step task (e.g. "write tests for X and debug it", "refactor the storage layer", "implement feature Y", "fix all compile errors"). This requires running multiple tools (file edits, bash commands, searches).\n\n' +
  "Response format: Reply with exactly one comma-separated line containing:\n" +
  "<ACTION>,<CONFIDENCE>,<REASON>\n\n" +
  "Examples:\n" +
  '- "DIRECT_ANSWER,0.95,Simple explanation of how the DB migration works."\n' +
  '- "ROTATE_SESSION,0.90,Complete shift to a different project/language."\n' +
  '- "ROTATE_SESSION,0.95,Session size exceeds threshold and current request starts a new task."\n' +
  '- "SPAWN_SUB_SESSION,0.98,Requires writing a test suite and fixing multiple files to get it green."\n' +
  "No other text, only the comma-separated line.";

export async function classifySubSessionAction(
  factory: ProviderFactory,
  modelId: string,
  prompt: string,
  contextInfo?: {
    currentChars: number;
    threshold: number;
    /**
     * Compact digest of recent conversation turns. The router's system prompt
     * says it decides "based on the conversation history" — without this the
     * history was never actually supplied and the router judged the prompt in
     * isolation, so a follow-up like "ok làm phần đó đi" could not be told apart
     * from a fresh unrelated task. Supplying it makes the claim true.
     */
    recentTurns?: string | null;
  },
  signal?: AbortSignal,
): Promise<SubSessionRouteResult | null> {
  // No regex pre-filter: the model decides the route for EVERY prompt, including
  // greetings/acks (which it routes to DIRECT_ANSWER). The old keyword/list
  // heuristic was removed (2026-07-07, no-regex rule) — a hardcoded whitelist
  // mis-handles the long tail of natural-language inputs the whole design moved
  // off of. On a null/failed model result the caller keeps the conservative
  // DIRECT_ANSWER default (a semantic default, not a regex guess).
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Zero-hardcode: query models catalog for a cheap fast-tier model under the same provider.
    const info = getModelInfo(modelId);
    const provider = info?.provider;
    const fastModel = provider
      ? getRoutedModelByTier("fast", provider) || getRoutedModelByTier("balanced", provider)
      : undefined;
    const classificationModelId = fastModel?.id ?? modelId;

    const runtime = resolveModelRuntime(factory, classificationModelId);
    const isReasoning = runtime.modelInfo?.reasoning === true;
    // Same flat safety-net ceiling as the main classifier (see CLASSIFY_TIMEOUT_MS).
    timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    const combinedSignal = signal
      ? (AbortSignal.any?.([signal, controller.signal]) ?? controller.signal)
      : controller.signal;

    const dropMaxTokens = runtime.unsupportedParams?.includes("maxOutputTokens") === true;
    const maxOut = isReasoning ? REASONING_MAX_OUTPUT_TOKENS : NONREASONING_MAX_OUTPUT_TOKENS;

    let providerOptions = runtime.providerOptions;
    if (isReasoning && runtime.modelInfo?.supportsReasoningEffort && runtime.modelInfo.provider) {
      const lowEffort = getProviderCapabilities(runtime.modelInfo.provider).buildProviderOptions({
        model: runtime.model,
        reasoningEffort: "low",
      });
      providerOptions = mergeProviderOptions(runtime.providerOptions, lowEffort);
    }

    let promptWithContext = prompt.slice(0, 1000);
    if (contextInfo) {
      const recent = contextInfo.recentTurns?.trim();
      const historyBlock = recent
        ? `[CONVERSATION HISTORY — for context; the prompt may continue or reference it]\n${recent.slice(0, 800)}\n\n`
        : "";
      promptWithContext =
        `[SESSION METADATA]\n` +
        `Current session size: ${contextInfo.currentChars} characters.\n` +
        `Rotation threshold: ${contextInfo.threshold} characters.\n\n` +
        `${historyBlock}` +
        `[USER PROMPT]\n${promptWithContext}`;
    }

    const result = streamText({
      model: runtime.model,
      abortSignal: combinedSignal,
      system: ROUTER_SYSTEM_PROMPT,
      prompt: promptWithContext,
      ...(dropMaxTokens ? {} : { maxOutputTokens: maxOut }),
      ...(providerOptions ? { providerOptions } : {}),
    });

    let text = "";
    let reasoningText = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += (part as any).textDelta ?? (part as any).text ?? "";
      else if (part.type === "reasoning-delta") reasoningText += (part as any).textDelta ?? (part as any).text ?? "";
    }

    const rawResult = text.trim() || reasoningText.trim();
    if (!rawResult) return null;

    const clean = rawResult.replace(/[`*"]/g, "").trim();
    const firstLine = clean.split(/\r?\n/)[0] ?? "";
    const parts = firstLine.split(",");
    if (parts.length < 2) return null;

    const action = parts[0].trim().toUpperCase() as SubSessionAction;
    const confidence = Number(parts[1].trim()) || 0.8;
    const reason = parts.slice(2).join(",").trim() || "No reason given";

    if (action === "DIRECT_ANSWER" || action === "ROTATE_SESSION" || action === "SPAWN_SUB_SESSION") {
      return { action, confidence, reason };
    }
    return null;
  } catch (err) {
    console.error(`[pil.llm-classify] classifySubSessionAction failed: ${(err as Error)?.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

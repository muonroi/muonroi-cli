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
import { streamText } from "ai";
import { getModelInfo } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import type { ProviderFactory } from "../providers/runtime.js";
import { resolveModelRuntime } from "../providers/runtime.js";
import { getRoutedModelByTier } from "../router/peak-hour.js";
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
   * routable fast model (e.g. xai) — the tier-scaled timeout inside the closure
   * covers that case, so a heavy session model never starves the verdict.
   * Zero-hardcode: the fast id comes from `getRoutedModelByTier`, not a literal.
   */
  routeFastTier?: boolean;
}

const LLM_CLASSIFY_TIMEOUT_MS = 2500;

// Reasoning models (grok-4.5, deepseek-v4-flash, gpt-5.x) spend their output
// budget on reasoning tokens BEFORE any visible text. The legacy 16-token cap
// was consumed entirely by reasoning → zero text-delta → parseResponse("") →
// null → `llm=fail` on every borderline turn (observed 5/5 live grok sessions).
// Give reasoning models a real ceiling so the 2-word answer streams back, and a
// longer timeout because reasoning round-trips take seconds, not ~200ms.
// The ceiling is a cap, not padding: the model still stops after two words, so a
// generous headroom costs nothing when reasoning is short.
const REASONING_CLASSIFY_TIMEOUT_MS = 8000;
// Eight comma-separated words now (added <clarity>) — ~20-30 tokens worst case
// ("documentation,balanced,task,report,standard,ecosystem,vietnamese,underspecified").
// 56 keeps headroom without padding (the model still stops after eight words).
const NONREASONING_MAX_OUTPUT_TOKENS = 56;
const REASONING_MAX_OUTPUT_TOKENS = 2048;

/**
 * Compute the classify call budget from the resolved model's catalog metadata.
 *
 * TIMEOUT scales with model WEIGHT, not just the reasoning flag: a balanced/
 * premium agentic model (e.g. grok-composer — balanced, reasoning:false)
 * answers far slower than a fast-tier flash model, so the tight 2.5s ceiling
 * aborted before its 8-word verdict streamed back — collapsing every classify
 * to the null→"standard" fail-open (the /ideal over-engineering root cause
 * observed 2026-07-14). `tier` comes from the catalog, so this is data-driven,
 * NOT a per-model literal. The generous ceiling is a cap not padding: a healthy
 * fast model still returns in <1s, so there is no added latency — only a
 * genuinely slow model uses the headroom.
 *
 * MAX-OUTPUT scales with REASONING only: a reasoning model burns its output
 * budget on reasoning tokens before any visible text, so it needs the room in
 * tokens; a non-reasoning model (even a heavy one) emits the 8 words directly.
 * The two knobs are intentionally decoupled.
 */
export function classifierBudget(modelInfo: { reasoning?: boolean; tier?: string } | undefined): {
  isReasoning: boolean;
  heavyweight: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
} {
  const isReasoning = modelInfo?.reasoning === true;
  const tier = modelInfo?.tier;
  const heavyweight = isReasoning || (tier !== undefined && tier !== "fast");
  return {
    isReasoning,
    heavyweight,
    timeoutMs: heavyweight ? REASONING_CLASSIFY_TIMEOUT_MS : LLM_CLASSIFY_TIMEOUT_MS,
    maxOutputTokens: isReasoning ? REASONING_MAX_OUTPUT_TOKENS : NONREASONING_MAX_OUTPUT_TOKENS,
  };
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
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Optional fast-tier route (same provider): a 2-word verdict does not need
      // the (possibly heavy, agentic) session model. No-op when the provider has
      // no routable fast tier — the tier-scaled timeout below then covers it.
      let classifyModelId = modelId;
      if (classifyOpts?.routeFastTier) {
        const provider = getModelInfo(modelId)?.provider;
        const fast = provider ? getRoutedModelByTier("fast", provider) : undefined;
        if (fast && fast.id !== modelId) classifyModelId = fast.id;
      }
      const runtime = resolveModelRuntime(factory, classifyModelId);
      // Timeout scales with model WEIGHT; max-output with reasoning. See
      // classifierBudget() for the rationale (grok-composer starvation fix).
      const { isReasoning, heavyweight, timeoutMs } = classifierBudget(runtime.modelInfo);

      timer = setTimeout(() => controller.abort(), timeoutMs);
      const combinedSignal = signal
        ? (AbortSignal.any?.([signal, controller.signal]) ?? controller.signal)
        : controller.signal;

      const dropMaxTokens = runtime.unsupportedParams?.includes("maxOutputTokens") === true;
      const maxOut = isReasoning ? REASONING_MAX_OUTPUT_TOKENS : NONREASONING_MAX_OUTPUT_TOKENS;

      // Minimize reasoning cost: force the lowest effort the provider exposes for
      // this throwaway 2-word classification. Only providers with
      // `supportsReasoningEffort` (openai, xai) honor it; deepseek has no per-call
      // knob (disable via MUONROI_DEEPSEEK_DISABLE_THINKING at the factory).
      let providerOptions = runtime.providerOptions;
      if (isReasoning && runtime.modelInfo?.supportsReasoningEffort && runtime.modelInfo.provider) {
        const lowEffort = getProviderCapabilities(runtime.modelInfo.provider).buildProviderOptions({
          model: runtime.modelInfo,
          reasoningEffort: "low",
        });
        providerOptions = mergeProviderOptions(runtime.providerOptions, lowEffort);
      }
      // Prepend a bounded recent-conversation block so the classifier can
      // resolve back-references in a terse follow-up ("từ các phần đó",
      // "làm tiếp", "this") instead of scoring the isolated sentence. The
      // framing makes clear the depth still reflects the NEW message's actual
      // work — including work it points back at — not the whole transcript.
      const trimmedRecent = recentTurns?.trim();
      const promptWithContext = trimmedRecent
        ? `[RECENT CONVERSATION — reference only, do NOT classify this]\n${trimmedRecent.slice(0, 800)}\n\n` +
          `[NEW USER MESSAGE — classify THIS; if it refers back to the conversation above, judge the depth of the work it actually entails]\n${prompt.slice(0, 600)}`
        : prompt.slice(0, 600);
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
      const partCounts: Record<string, number> = {};
      const debug = process.env.MUONROI_DEBUG_PIL_CLASSIFY === "1";
      for await (const part of result.fullStream) {
        if (debug) partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
        if (part.type === "text-delta") text += (part as any).textDelta ?? (part as any).text ?? "";
        else if (part.type === "reasoning-delta") reasoningText += (part as any).textDelta ?? (part as any).text ?? "";
      }
      if (debug) {
        console.error(
          `[pil.llm-classify] raw(${classifyModelId}${classifyModelId !== modelId ? `←${modelId}` : ""}) ` +
            `heavyweight=${heavyweight} maxOut=${dropMaxTokens ? "dropped" : maxOut} ` +
            `parts=${JSON.stringify(partCounts)} text<<<${text}>>> reasoning<<<${reasoningText.slice(0, 200)}>>>`,
        );
      }
      // Reasoning models occasionally route the entire answer into reasoning
      // parts (no committed text). Fall back to the reasoning channel so the
      // 2-word verdict is still recoverable.
      const primary = parseResponse(text) ?? (reasoningText ? parseResponse(reasoningText) : null);
      if (primary) return primary;

      // Self-repair (agent-first recovery — NOT a regex fallback): the model's
      // first reply did not parse into the eight-word contract. Call the model
      // ONCE more with the FULL prompt + recent context (no 600-char trim) and
      // an explicit format-repair instruction on a doubled budget. Only if this
      // ALSO fails do we return null — and the caller then surfaces an honest
      // UNKNOWN classification, never a keyword-regex guess.
      if (timer) clearTimeout(timer);
      const repairController = new AbortController();
      const repairTimer = setTimeout(() => repairController.abort(), timeoutMs);
      const repairSignal = signal
        ? (AbortSignal.any?.([signal, repairController.signal]) ?? repairController.signal)
        : repairController.signal;
      try {
        const fullRecent = recentTurns?.trim();
        const repairPrompt =
          (fullRecent
            ? `[RECENT CONVERSATION — reference only, do NOT classify this]\n${fullRecent.slice(0, 1500)}\n\n`
            : "") + `[NEW USER MESSAGE — classify THIS]\n${prompt.slice(0, 1500)}`;
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
        const repaired = parseResponse(rt) ?? (rr ? parseResponse(rr) : null);
        if (repaired) {
          console.error(`[pil.llm-classify] self-repair recovered classification (${modelId})`);
        } else {
          console.error(
            `[pil.llm-classify] self-repair FAILED (${modelId}) — surfacing UNKNOWN, NO regex fallback. ` +
              `rawPreview=${JSON.stringify(prompt.slice(0, 120))}`,
          );
        }
        return repaired;
      } finally {
        clearTimeout(repairTimer);
      }
    } catch (err) {
      console.error(`[pil.llm-classify] classify failed: ${(err as Error)?.message}`, {
        modelId,
        stack: (err as Error)?.stack?.split("\n").slice(0, 3),
      });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
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
    timer = setTimeout(() => controller.abort(), isReasoning ? REASONING_CLASSIFY_TIMEOUT_MS : LLM_CLASSIFY_TIMEOUT_MS);
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

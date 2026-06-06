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
import { getProviderCapabilities } from "../providers/capabilities.js";
import type { ProviderFactory } from "../providers/runtime.js";
import { resolveModelRuntime } from "../providers/runtime.js";
import type { OutputStyle, TaskType } from "./types.js";

export interface LlmClassifyResult {
  taskType: TaskType;
  outputStyle: OutputStyle | null;
  confidence: number;
}

export type LlmClassifyFn = (prompt: string, signal?: AbortSignal) => Promise<LlmClassifyResult | null>;

const LLM_CLASSIFY_TIMEOUT_MS = 2500;

// Reasoning models (grok-4.3, deepseek-v4-flash, gpt-5.x) spend their output
// budget on reasoning tokens BEFORE any visible text. The legacy 16-token cap
// was consumed entirely by reasoning → zero text-delta → parseResponse("") →
// null → `llm=fail` on every borderline turn (observed 5/5 live grok sessions).
// Give reasoning models a real ceiling so the 2-word answer streams back, and a
// longer timeout because reasoning round-trips take seconds, not ~200ms.
// The ceiling is a cap, not padding: the model still stops after two words, so a
// generous headroom costs nothing when reasoning is short.
const REASONING_CLASSIFY_TIMEOUT_MS = 8000;
const NONREASONING_MAX_OUTPUT_TOKENS = 16;
const REASONING_MAX_OUTPUT_TOKENS = 2048;

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

const SYSTEM_PROMPT =
  "You classify user prompts for a coding assistant. Reply with ONE line of two lowercase words separated by a comma: <taskType>,<style>\n\n" +
  "taskType ∈ { refactor | debug | plan | analyze | documentation | generate | general }\n" +
  "style ∈ { concise | balanced | detailed }\n\n" +
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
  "Prompts may be Vietnamese, English, or mixed. Reply with exactly two words separated by one comma. No other text.";

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
  return { taskType: taskWord, outputStyle: style, confidence: 0.75 };
}

/**
 * Build a closure the PIL pipeline can call. Reuses the orchestrator's already-
 * constructed providerFactory + modelId so we don't pay key-loading cost twice.
 *
 * Returns null if the call fails / times out / parses to garbage. Callers must
 * fail-open (keep prior taskType, do not block the turn).
 */
export function createLlmClassifier(factory: ProviderFactory, modelId: string): LlmClassifyFn {
  return async function classify(prompt: string, signal?: AbortSignal): Promise<LlmClassifyResult | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const runtime = resolveModelRuntime(factory, modelId);
      const isReasoning = runtime.modelInfo?.reasoning === true;

      // Budget + timeout scale with reasoning: a reasoning model needs room and
      // time to emit reasoning THEN the answer; a plain model answers in <16
      // tokens almost instantly.
      timer = setTimeout(
        () => controller.abort(),
        isReasoning ? REASONING_CLASSIFY_TIMEOUT_MS : LLM_CLASSIFY_TIMEOUT_MS,
      );
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

      const result = streamText({
        model: runtime.model,
        abortSignal: combinedSignal,
        system: SYSTEM_PROMPT,
        prompt: prompt.slice(0, 600),
        ...(dropMaxTokens ? {} : { maxOutputTokens: maxOut }),
        ...(providerOptions ? { providerOptions } : {}),
      });
      let text = "";
      let reasoningText = "";
      const partCounts: Record<string, number> = {};
      const debug = process.env["MUONROI_DEBUG_PIL_CLASSIFY"] === "1";
      for await (const part of result.fullStream) {
        if (debug) partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
        if (part.type === "text-delta") text += part.text ?? "";
        else if (part.type === "reasoning-delta") reasoningText += (part as { text?: string }).text ?? "";
      }
      if (debug) {
        console.error(
          `[pil.llm-classify] raw(${modelId}) maxOut=${dropMaxTokens ? "dropped" : maxOut} ` +
            `parts=${JSON.stringify(partCounts)} text<<<${text}>>> reasoning<<<${reasoningText.slice(0, 200)}>>>`,
        );
      }
      // Reasoning models occasionally route the entire answer into reasoning
      // parts (no committed text). Fall back to the reasoning channel so the
      // 2-word verdict is still recoverable.
      return parseResponse(text) ?? (reasoningText ? parseResponse(reasoningText) : null);
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

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
  "Rules:\n" +
  "- debug — fix a bug, CI/build/test failure, error, exception, crash, or any 'why is X broken' question.\n" +
  "- generate — create new code, scaffold, write a new file, add a feature from scratch.\n" +
  "- refactor — restructure existing code without changing behavior.\n" +
  "- plan — architecture, roadmap, multi-step design, strategy.\n" +
  "- analyze — explain, review, inspect, audit, compare existing code.\n" +
  "- documentation — write docs, comments, JSDoc, README.\n" +
  "- general — chitchat or unclear intent.\n" +
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
    const timer = setTimeout(() => controller.abort(), LLM_CLASSIFY_TIMEOUT_MS);
    const combinedSignal = signal
      ? (AbortSignal.any?.([signal, controller.signal]) ?? controller.signal)
      : controller.signal;
    try {
      const runtime = resolveModelRuntime(factory, modelId);
      const dropMaxTokens = runtime.unsupportedParams?.includes("maxOutputTokens") === true;
      const result = streamText({
        model: runtime.model,
        abortSignal: combinedSignal,
        system: SYSTEM_PROMPT,
        prompt: prompt.slice(0, 600),
        ...(dropMaxTokens ? {} : { maxOutputTokens: 16 }),
        ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
      });
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") text += part.text ?? "";
      }
      return parseResponse(text);
    } catch (err) {
      console.error(`[pil.llm-classify] classify failed: ${(err as Error)?.message}`, {
        modelId,
        stack: (err as Error)?.stack?.split("\n").slice(0, 3),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

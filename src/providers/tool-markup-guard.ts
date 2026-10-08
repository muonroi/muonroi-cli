/**
 * src/providers/tool-markup-guard.ts
 *
 * P0-5b — provider-boundary guard against native tool-call markup leaking into
 * a user-visible answer.
 *
 * MEASURED PROBLEM (2026-09-04, `https://api.stepfun.ai/step_plan/v1`, see
 * docs/agent-first/SELF-IMPROVEMENT-PLAN.md §4.1): `step-3.7-flash` and
 * `step-3.5-flash` emit their NATIVE tool-call markup as plain-text `content`
 * whenever the request carries no tool schemas but the message history still
 * contains prior tool usage. `finish_reason: "stop"`, `tool_calls: false` — so
 * the AI SDK never parses it back out and the markup reaches the TUI verbatim
 * as the final answer:
 *
 *     <tool_call>
 *     <function=read_file>
 *     <parameter=path>
 *     src/config.js
 *     </parameter>
 *     </function>
 *     </tool_call>
 *
 * Ruled out by measurement, do NOT re-propose:
 *   - `tool_choice: "none"` (cases a/b/c are identical — the flag is inert here)
 *   - a system-prompt instruction forbidding the markup (case f still leaked)
 *
 * WHY THIS SEAM. `resolveModelRuntime` is the single factory every LLM call
 * resolves its model through, and `wrapLanguageModel` middleware is the last
 * point the provider's own bytes pass before the AI SDK hands them to a caller.
 * Guarding here covers `forcedFinalize` (`scope-ceiling.ts:222`), stall-rescue
 * (which delegates to `forcedFinalize`) and the empty-tool-set chitchat
 * continuation (`tool-engine.ts:1889-1903`) with one implementation, and cannot
 * be bypassed by a new call site.
 *
 * STRIP, NOT PARSE-BACK. Resurrecting the markup into a tool call is wrong on
 * every affected path: the tool set is empty ON PURPOSE (the caller is coercing
 * a text-only synthesis after a step ceiling or a stall), so there is no tool
 * registry to execute against and honoring the call would defeat the caller's
 * intent.
 *
 * EMPTY-AFTER-STRIP IS A TYPED FAILURE, NOT AN EMPTY ANSWER. The measured leak
 * is the WHOLE content, so stripping leaves "" — and returning "" silently would
 * trade a visible-garbage bug for an invisible-empty-answer bug. Instead the
 * guard raises `ToolCallMarkupLeakError`: on `doGenerate` it throws, on
 * `doStream` it emits an `error` stream part. Both land in paths that already
 * exist — `forcedFinalize`'s callers record `f6_synthesis outcome:"error"`
 * (tool-engine.ts:3953) and the stream loop routes `error` parts through
 * `classifyStreamError` (tool-engine.ts:3212) — so the failure is observable
 * instead of being laundered into a blank reply.
 *
 * FALSE POSITIVES. Legitimate prose can quote this markup (a user asking about
 * it, documentation, this repo's own plan file). Two conditions must BOTH hold
 * before anything is suppressed:
 *   1. the request carried NO tool schemas — the measured leak precondition;
 *      a request with real tools is clean (case e) and streams untouched;
 *   2. the ENTIRE response content is one or more well-formed
 *      `<tool_call>…</tool_call>` blocks and nothing but whitespace besides.
 * Prose that merely mentions or fences the markup keeps its surrounding text, so
 * condition 2 fails and the content is passed through byte-for-byte.
 *
 * The stream transform holds back only the leading run of bytes that is still
 * consistent with condition 2; the moment any other text arrives it flushes
 * everything verbatim and stops inspecting for the rest of the call. Normal
 * prose therefore streams with at most a few characters of delay.
 */

import { wrapLanguageModel } from "ai";
import { logInteraction } from "../storage/interaction-log.js";

/** Opening delimiter of the native block, as measured. */
const OPEN_TAG = "<tool_call>";
/** One complete, well-formed block. Non-greedy so adjacent blocks stay distinct. */
const COMPLETE_BLOCK_RE = /<tool_call>[\s\S]*?<\/tool_call>/g;

/**
 * Upper bound on held-back bytes. The measured leak is ~101 chars; anything that
 * is still "consistent with a whole-content leak" past this size is pathological,
 * so the guard fails OPEN (flushes verbatim) rather than buffering unboundedly.
 */
const MAX_HELD_CHARS = 32_768;

/**
 * Raised when a response's entire content was native tool-call markup on a turn
 * that offered no tools. Carries the suppressed text so a caller (or a log) can
 * show what the provider actually returned.
 */
export class ToolCallMarkupLeakError extends Error {
  readonly suppressed: string;
  readonly modelId: string | undefined;
  constructor(suppressed: string, modelId?: string) {
    super(
      `Provider returned native tool-call markup as its entire answer on a turn with no tools` +
        `${modelId ? ` (model=${modelId})` : ""}; ${suppressed.length} chars suppressed`,
    );
    this.name = "ToolCallMarkupLeakError";
    this.suppressed = suppressed;
    this.modelId = modelId;
  }
}

/**
 * True when `text` is ENTIRELY native tool-call markup: at least one well-formed
 * block, and nothing but whitespace once every complete block is removed.
 *
 * This is the false-positive firewall. `"see <tool_call>…</tool_call> above"`
 * leaves `"see  above"` and returns false; a fenced quotation leaves its
 * backticks and returns false.
 */
export function isWholeContentToolCallMarkup(text: string): boolean {
  if (!text.trim()) return false;
  COMPLETE_BLOCK_RE.lastIndex = 0;
  if (!COMPLETE_BLOCK_RE.test(text)) return false;
  COMPLETE_BLOCK_RE.lastIndex = 0;
  return text.replace(COMPLETE_BLOCK_RE, "").trim().length === 0;
}

/**
 * Can `buffered` still turn into a whole-content leak if more text arrives?
 *
 * Remove every complete block; whatever is left must be whitespace, a partial
 * opening tag (`"<too"`), or the start of an unterminated block. Anything else
 * is real prose — the answer can never satisfy `isWholeContentToolCallMarkup`,
 * so the caller must flush and stop holding bytes back.
 */
export function couldStillBeWholeMarkup(buffered: string): boolean {
  COMPLETE_BLOCK_RE.lastIndex = 0;
  const leftover = buffered.replace(COMPLETE_BLOCK_RE, "").trim();
  if (leftover.length === 0) return true;
  if (leftover.startsWith(OPEN_TAG)) return true; // unterminated block, still streaming
  return OPEN_TAG.startsWith(leftover); // partial opening tag, e.g. "<tool_c"
}

/** Concatenate the text of a `doGenerate` content array. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content as Array<{ type?: string; text?: unknown }>) {
    if (part?.type === "text" && typeof part.text === "string") out += part.text;
  }
  return out;
}

/** True when the call offered the model no tool schemas — the leak precondition. */
function callHasNoTools(params: unknown): boolean {
  const tools = (params as { tools?: unknown } | undefined)?.tools;
  if (tools === undefined || tools === null) return true;
  return Array.isArray(tools) && tools.length === 0;
}

interface GuardContext {
  modelId: string | undefined;
  sessionId?: string;
}

/** Record the suppression so it is forensically visible, never silently dropped. */
function reportLeak(ctx: GuardContext, op: "stream" | "generate", suppressed: string): void {
  console.warn(
    `[tool-markup-guard] suppressed native tool-call markup as whole answer: op=${op} model=${ctx.modelId ?? "unknown"} chars=${suppressed.length}`,
  );
  if (!ctx.sessionId) return;
  try {
    logInteraction(ctx.sessionId, "error", {
      eventSubtype: "tool_markup_leak",
      model: ctx.modelId,
      data: { op, chars: suppressed.length, suppressed: suppressed.slice(0, 500) },
    });
  } catch (err) {
    console.error(`[tool-markup-guard] failed to log suppressed leak: ${(err as Error)?.message ?? String(err)}`, {
      op,
      model: ctx.modelId,
    });
  }
}

/**
 * Transform a provider stream so a whole-content markup leak never reaches the
 * caller. See the module header for the hold-back rule.
 *
 * Exported for direct testing — production wiring goes through
 * `wrapModelWithToolMarkupGuard`.
 */
export function guardStream(source: ReadableStream<unknown>, ctx: GuardContext): ReadableStream<unknown> {
  // `held` accumulates the raw parts we are withholding; `buffered` is their
  // concatenated text. `inspecting` goes false permanently the first time the
  // content proves it is not a whole-content leak.
  let inspecting = true;
  let held: unknown[] = [];
  let buffered = "";

  const flush = (controller: TransformStreamDefaultController<unknown>): void => {
    for (const part of held) controller.enqueue(part);
    held = [];
    buffered = "";
    inspecting = false;
  };

  /** End of content: either the buffer is a leak (suppress + error) or it is prose (flush). */
  const settle = (controller: TransformStreamDefaultController<unknown>): void => {
    if (!inspecting) return;
    if (isWholeContentToolCallMarkup(buffered)) {
      const suppressed = buffered;
      held = [];
      buffered = "";
      inspecting = false;
      reportLeak(ctx, "stream", suppressed);
      controller.enqueue({ type: "error", error: new ToolCallMarkupLeakError(suppressed, ctx.modelId) });
      return;
    }
    flush(controller);
  };

  return source.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(part, controller) {
        const type = (part as { type?: string })?.type;

        if (!inspecting) {
          controller.enqueue(part);
          return;
        }

        // Text parts are the only thing we hold back.
        if (type === "text-start" || type === "text-end") {
          held.push(part);
          return;
        }
        if (type === "text-delta") {
          const delta = (part as { delta?: unknown }).delta;
          held.push(part);
          buffered += typeof delta === "string" ? delta : "";
          if (buffered.length > MAX_HELD_CHARS || !couldStillBeWholeMarkup(buffered)) {
            flush(controller);
          }
          return;
        }

        // A real tool call means the model did NOT fall back to markup — nothing
        // to guard against on this call.
        if (type === "tool-call" || type === "tool-input-start") {
          flush(controller);
          controller.enqueue(part);
          return;
        }

        // `finish` closes the content: decide before forwarding it.
        if (type === "finish") {
          settle(controller);
          controller.enqueue(part);
          return;
        }

        // Everything else (stream-start, reasoning-*, response-metadata, raw,
        // error, …) is not answer content — forward it untouched, in order.
        controller.enqueue(part);
      },
      flush(controller) {
        // Stream ended without a `finish` part (abort, provider close).
        settle(controller);
      },
    }),
  );
}

export interface ToolMarkupGuardOptions {
  /**
   * Whether this model is known to emit native tool-call markup as text. Comes
   * from the capability layer (`ProviderCapabilities.emitsNativeToolCallMarkup`)
   * — NEVER from a provider-id comparison at the call site (Zero Hardcode Rule).
   */
  enabled: boolean;
  modelId: string | undefined;
  sessionId?: string;
}

/**
 * Wrap a resolved model so a whole-content native-markup answer can never reach
 * the caller. Returns the model untouched when the capability says this model
 * does not have the quirk, so every other provider pays exactly nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: AI SDK model handle is provider-shaped (any) across the codebase
export function wrapModelWithToolMarkupGuard(model: any, opts: ToolMarkupGuardOptions): any {
  if (!model || !opts.enabled) return model;
  const ctx: GuardContext = { modelId: opts.modelId, sessionId: opts.sessionId };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        if (!callHasNoTools(params)) return result;
        const stream = (result as { stream?: unknown }).stream;
        if (!stream || typeof (stream as ReadableStream<unknown>).pipeThrough !== "function") {
          return result;
        }
        // Cast at the AI SDK boundary: the guard transform is part-shape-agnostic
        // (it only reads `type`/`delta`), so it is typed over `unknown` parts.
        return {
          ...(result as object),
          stream: guardStream(stream as ReadableStream<unknown>, ctx),
        } as unknown as Awaited<ReturnType<typeof doStream>>;
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        if (!callHasNoTools(params)) return result;
        const text = textOfContent((result as { content?: unknown }).content);
        if (!isWholeContentToolCallMarkup(text)) return result;
        reportLeak(ctx, "generate", text);
        throw new ToolCallMarkupLeakError(text, ctx.modelId);
      },
    },
  });
}

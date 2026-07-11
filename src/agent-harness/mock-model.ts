/**
 * src/agent-harness/mock-model.ts
 *
 * AI-SDK-level mock model for cost-leak verification.
 *
 * Background: src/providers/adapter.ts has a `globalThis.__muonroiMockLlm`
 * hook, but the orchestrator does NOT use that legacy Adapter path. It calls
 * AI SDK v6 `streamText({ model, ... })` with a model produced by
 * `createProviderFactory()` → `factory(canonicalId)`. To verify cost leaks
 * that live in the provider call (G1: dropped params, F1: providerOptions,
 * B3/B4: messages compaction across rounds), the mock must sit AT the
 * LanguageModelV3 layer where `streamText` does its work.
 *
 * AI SDK ships `MockLanguageModelV3` in `ai/test` for exactly this purpose.
 * It auto-records every `doStream` call into `.doStreamCalls` and accepts a
 * function OR an array of stream results (sequential per round).
 *
 * Usage (test code):
 *   const handle = createMockModel({ stream: [[<round-1 chunks>], [<round-2 chunks>]] });
 *   (globalThis as any).__muonroiMockModel = handle.model;
 *   ... drive the TUI ...
 *   const calls = handle.calls; // LanguageModelV3CallOptions[]
 *   expect(calls[0].maxOutputTokens).toBeUndefined();
 */

import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

export type StreamChunks = LanguageModelV3StreamPart[];

export interface MockModelFixture {
  /**
   * Stream parts emitted per `doStream` call.
   * - Single array → same chunks on every call (rare, mostly for control tests).
   * - Array of arrays → one entry consumed per call. When exhausted, the last
   *   entry repeats (so multi-round loops don't crash if the fixture is short).
   */
  stream: StreamChunks | StreamChunks[];
  /**
   * JSON text returned per `doGenerate` call — the path `generateObject` uses
   * (council `debate-planner` plans the debate via `generateObject`, research
   * classifiers via `generateText`, etc.). Without this the mock's `doGenerate`
   * returns `"{}"`, which `generateObject` schema-validates → throws → the
   * caller's retry/fallback path runs. Supply the exact object JSON to exercise
   * the happy path.
   * - Single string → same JSON on every call.
   * - Array → one entry consumed per call; last entry repeats when exhausted.
   */
  generate?: string | string[];
  /** Reported provider id. Default "mock". */
  provider?: string;
  /** Reported model id. Default "mock-model". */
  modelId?: string;
  /**
   * Response for PIL's model-first intent classifier (src/pil/llm-classify.ts).
   * Since the no-regex refactor (2026-07-07) PIL classifies EVERY turn by
   * calling the model with a distinctive system prompt ("Reply with ONE line of
   * EIGHT lowercase words…") and parses a comma-separated line. The generic
   * fixture stream ("Hello back!" / arbitrary chunks) does not parse → the turn
   * degrades to intentKind=UNKNOWN, which skips the gsd gate and breaks routing
   * in E2E specs. The mock detects that classify call by its system prompt and
   * returns THIS line instead of consuming the turn fixture — so every spec gets
   * a sane classification for free. Override per-fixture when a spec needs a
   * specific taskType/intent/depth. Format:
   *   <taskType>,<style>,<intent>,<deliverable>,<depth>,<scope>,<lang>,<clarity>
   */
  classify?: string;
  /**
   * Opt in to the PIL-classifier intercept described on `classify`. When true,
   * a `doStream` call carrying the classifier's system prompt is answered with
   * `classify` (or DEFAULT_CLASSIFY_LINE) WITHOUT consuming a turn fixture.
   *
   * This is a convenience for the file-based E2E harness (`loadMockModelFromDir`
   * sets it true by default) whose fixtures supply agent turn-rounds and must
   * not spend a round on the classify call. Direct in-memory callers
   * (`createMockModel`/`installMockModel`, e.g. llm-classify.test.ts) leave it
   * OFF so the fixture stream they configure IS delivered to the classifier —
   * otherwise every classification would collapse to DEFAULT_CLASSIFY_LINE.
   * Setting `classify` implies opting in.
   */
  autoClassify?: boolean;
}

/**
 * System-prompt substring that uniquely identifies PIL's model-first intent
 * classifier call (see SYSTEM_PROMPT in src/pil/llm-classify.ts). Kept in sync
 * with that constant's opening line.
 */
const CLASSIFY_SIGNATURE = "Reply with ONE line of EIGHT lowercase words";

/**
 * Safe default classification: a non-chitchat coding task of standard depth.
 * `intent=task` keeps the toolset + gsd gate active; `standard` depth avoids
 * forcing heavy-only paths. First word MUST be a valid taskType.
 */
const DEFAULT_CLASSIFY_LINE = "generate, balanced, task, code, standard, local, english, clear";

/** Concatenated text of every `system` message in a doStream call's prompt. */
function systemPromptText(options: LanguageModelV3CallOptions): string {
  const prompt = (options as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const msg of prompt) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "system") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const t = (c as { text?: string }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
  }
  return parts.join("\n");
}

export interface MockModelHandle {
  /** The mock model instance — assign to `globalThis.__muonroiMockModel`. */
  model: MockLanguageModelV3;
  /**
   * Read-only view of every `doStream` invocation, in call order.
   * AI SDK populates this automatically on each call.
   */
  readonly calls: ReadonlyArray<LanguageModelV3CallOptions>;
  /** Clear call history between specs. */
  reset(): void;
}

function isNestedArray(v: StreamChunks | StreamChunks[]): v is StreamChunks[] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

/**
 * Build a MockLanguageModelV3 with sequenced or fixed responses.
 *
 * The mock's `doStream` returns a `simulateReadableStream` that emits the
 * configured chunks. AI SDK's `streamText` consumes them, runs the tool loop,
 * and (when chunks request tool-calls) calls `doStream` again with the
 * accumulated messages — giving us multi-round verification with no real
 * provider.
 */
export function createMockModel(fx: MockModelFixture): MockModelHandle {
  const streams: StreamChunks[] = isNestedArray(fx.stream) ? fx.stream : [fx.stream];
  const generates: string[] = fx.generate === undefined ? [] : Array.isArray(fx.generate) ? fx.generate : [fx.generate];
  let callIdx = 0;
  let genIdx = 0;
  const provider = fx.provider ?? "mock";
  const modelId = fx.modelId ?? "mock-model";
  const classifyLine = fx.classify ?? DEFAULT_CLASSIFY_LINE;
  // Intercept the PIL classifier call ONLY when the fixture opts in (E2E
  // harness fixtures do, via loadMockModelFromDir). Direct in-memory callers
  // (llm-classify.test.ts) leave it off so the stream they configure IS
  // delivered to the classifier — intercepting would override their reply with
  // DEFAULT_CLASSIFY_LINE and make every classification collapse to "generate".
  const interceptClassify = fx.autoClassify === true || fx.classify !== undefined;

  const model = new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async (options: LanguageModelV3CallOptions) => {
      // PIL model-first classifier call — answer with the parseable eight-word
      // line and DO NOT advance the turn-fixture cursor, so the classify call
      // (which fires on every turn) never steals the round chunks meant for the
      // agent's actual reply. Without this the generic fixture text fails
      // parseResponse → intentKind=UNKNOWN → gsd gate/routing break in E2E.
      if (interceptClassify && systemPromptText(options).includes(CLASSIFY_SIGNATURE)) {
        if (process.env.MUONROI_DEBUG_MOCK_MODEL === "1") {
          process.stderr.write(`[mock-model] doStream classify → "${classifyLine}"\n`);
        }
        return {
          stream: simulateReadableStream<LanguageModelV3StreamPart>({
            chunks: textOnlyStream(classifyLine),
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      }
      const chunks = streams[Math.min(callIdx, streams.length - 1)]!;
      callIdx += 1;
      if (process.env.MUONROI_DEBUG_MOCK_MODEL === "1") {
        // Useful when diagnosing harness specs that stall before streamText —
        // a missing log line means doStream was never invoked.
        process.stderr.write(
          `[mock-model] doStream #${callIdx} → ${chunks.length} parts, types=${chunks.map((c) => c.type).join(",")}\n`,
        );
      }
      return {
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
    // doGenerate backs `generateObject` / non-streaming `generateText`. The AI
    // SDK reads the first text content part as the object JSON (generateObject)
    // or the completion text (generateText). Default "{}" keeps the mock from
    // throwing "Not implemented" — generateObject then schema-rejects it and the
    // caller's retry/fallback runs. Supply `generate` to drive the happy path.
    doGenerate: async () => {
      const text = generates.length > 0 ? generates[Math.min(genIdx, generates.length - 1)]! : "{}";
      genIdx += 1;
      if (process.env.MUONROI_DEBUG_MOCK_MODEL === "1") {
        process.stderr.write(
          `[mock-model] doGenerate #${genIdx} → ${text.length} chars\nCALLER:\n${new Error().stack}\n`,
        );
      }
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: buildUsage(10, text.length),
        warnings: [],
      };
    },
  });

  return {
    model,
    get calls() {
      return model.doStreamCalls;
    },
    reset() {
      model.doStreamCalls.length = 0;
      callIdx = 0;
      genIdx = 0;
    },
  };
}

function buildUsage(
  inputTotal: number,
  outputTotal: number,
): {
  inputTokens: { total: number; noCache: number; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number; text: number; reasoning: number | undefined };
} {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  };
}

/**
 * Convenience: emit a single-step text response.
 * Common for control tests that don't need multi-round behavior.
 */
export function textOnlyStream(text: string, usage?: { inputTokens: number; outputTokens: number }): StreamChunks {
  const id = "t1";
  const inputTotal = usage?.inputTokens ?? 10;
  const outputTotal = usage?.outputTokens ?? text.length;
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    {
      type: "finish",
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: buildUsage(inputTotal, outputTotal),
    },
  ];
}

/**
 * Convenience: emit a deterministic error stream-part.
 *
 * Used by harness specs that need to verify the orchestrator's error-handling
 * path (and the resulting `toast` LiveEvent emitted by app.tsx). The
 * `LanguageModelV3StreamPart` of type `error` is what real providers emit when
 * the API rejects or fails mid-stream; orchestrator.ts handles it by yielding
 * a `type:"error"` StreamChunk, which app.tsx maps to a `toast` event.
 *
 * Unlike `mock-llm.ts` error injection (which depends on prompt-substring
 * matching surviving the system-prompt prefix), this emits unconditionally on
 * every `doStream` call, making it deterministic in CI.
 */
export function errorStream(opts?: { message?: string; injectStreamStart?: boolean }): StreamChunks {
  const message = opts?.message ?? "mock LLM error: simulated provider failure";
  const parts: StreamChunks = [];
  if (opts?.injectStreamStart !== false) {
    parts.push({ type: "stream-start", warnings: [] });
  }
  parts.push({ type: "error", error: new Error(message) });
  parts.push({
    type: "finish",
    finishReason: { unified: "error" as const, raw: undefined },
    usage: buildUsage(0, 0),
  });
  return parts;
}

/**
 * Convenience: emit a tool-call step. The next `doStream` call will receive
 * the tool result appended to the message history (AI SDK handles this).
 */
export function toolCallStream(opts: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
}): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      input: JSON.stringify(opts.input),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: buildUsage(opts.usage?.inputTokens ?? 50, opts.usage?.outputTokens ?? 20),
    },
  ];
}

/**
 * Loaded fixture handle. Extends the basic MockModelHandle with the optional
 * provider-quirk simulation fields parsed out of the fixture file. The caller
 * (e.g. src/index.ts mock-llm wiring) is expected to assign these to the
 * `__muonroiMock*` globals atomically so `resolveModelRuntime` sees a
 * consistent picture.
 */
export interface LoadedMockModelHandle extends MockModelHandle {
  unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
  defaultProviderOptions?: Record<string, unknown>;
}

/**
 * Fixture-file loader. Reads JSON files in `dir` looking for `{model: ...}`
 * blocks. The first file with a `model` block is used; remaining files are
 * inspected by mock-llm (text-only fallback) without conflict.
 *
 * Returns `null` if no fixture in the directory declares a `model` block —
 * caller decides whether to fall back to mock-llm or fail.
 *
 * Fixture file schema:
 *
 *   {
 *     "model": {
 *       "provider": "mock",
 *       "modelId": "mock-gpt",
 *       "stream": [/* StreamChunks (single round) OR StreamChunks[] (multi-round) *\/],
 *       "unsupportedParams": ["maxOutputTokens"],
 *       "defaultProviderOptions": { "openai": { "store": false } }
 *     }
 *   }
 *
 * `unsupportedParams` and `defaultProviderOptions` mirror the OAuth-registry
 * fields exposed by `resolveModelRuntime` so TUI E2E specs can verify G1
 * (param-drop) and F1 (provider-options injection) end-to-end.
 */
/**
 * Normalize fixture-JSON stream parts: when an `{ type: "error" }` part is
 * loaded from JSON, its `error` field arrives as a plain string. The
 * orchestrator's `humanizeApiError` accepts non-Error inputs, but the AI SDK
 * stream-loop (and downstream serializers) prefer `Error` instances. Wrap
 * string payloads here so the rest of the pipeline sees a uniform shape.
 */
function normalizeStreamChunks(chunks: StreamChunks): StreamChunks {
  const normalized = chunks.map((c) => {
    if (!c) return c;
    const part = c as any;
    if (part.type === "error") {
      const raw = part.error;
      return { ...part, error: buildFixtureError(raw) } as typeof c;
    }
    if (part.type === "text-delta") {
      const delta = part.delta ?? part.textDelta ?? part.text ?? "";
      const id = part.id ?? "txt-0";
      return { ...part, id, delta } as typeof c;
    }
    if (part.type === "reasoning-delta") {
      const delta = part.delta ?? part.textDelta ?? part.text ?? "";
      const id = part.id ?? "reasoning-0";
      return { ...part, id, delta } as typeof c;
    }
    return c;
  });

  const result: StreamChunks = [];
  const textIds = new Set<string>();
  const reasoningIds = new Set<string>();

  for (const part of normalized) {
    if (!part) continue;
    const p = part as any;
    if (p.type === "text-delta") {
      textIds.add(p.id ?? "txt-0");
    } else if (p.type === "reasoning-delta") {
      reasoningIds.add(p.id ?? "reasoning-0");
    }
  }

  const seenTextStart = new Set<string>();
  const seenTextEnd = new Set<string>();
  const seenReasoningStart = new Set<string>();
  const seenReasoningEnd = new Set<string>();

  for (const part of normalized) {
    if (!part) continue;
    const p = part as any;
    if (p.type === "text-start") {
      seenTextStart.add(p.id);
    } else if (p.type === "text-end") {
      seenTextEnd.add(p.id);
    } else if (p.type === "reasoning-start") {
      seenReasoningStart.add(p.id);
    } else if (p.type === "reasoning-end") {
      seenReasoningEnd.add(p.id);
    }
  }

  const firstTextDeltaIdx = new Map<string, number>();
  const lastTextDeltaIdx = new Map<string, number>();
  const firstReasoningDeltaIdx = new Map<string, number>();
  const lastReasoningDeltaIdx = new Map<string, number>();

  for (let i = 0; i < normalized.length; i++) {
    const p = normalized[i] as any;
    if (!p) continue;
    if (p.type === "text-delta") {
      const id = p.id ?? "txt-0";
      if (!firstTextDeltaIdx.has(id)) firstTextDeltaIdx.set(id, i);
      lastTextDeltaIdx.set(id, i);
    } else if (p.type === "reasoning-delta") {
      const id = p.id ?? "reasoning-0";
      if (!firstReasoningDeltaIdx.has(id)) firstReasoningDeltaIdx.set(id, i);
      lastReasoningDeltaIdx.set(id, i);
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    const p = normalized[i] as any;
    if (!p) {
      result.push(p);
      continue;
    }

    if (p.type === "text-delta") {
      const id = p.id ?? "txt-0";
      if (firstTextDeltaIdx.get(id) === i && !seenTextStart.has(id)) {
        result.push({ type: "text-start", id });
      }
    } else if (p.type === "reasoning-delta") {
      const id = p.id ?? "reasoning-0";
      if (firstReasoningDeltaIdx.get(id) === i && !seenReasoningStart.has(id)) {
        result.push({ type: "reasoning-start", id });
      }
    }

    if (p.type === "finish") {
      const usage = p.usage ?? buildUsage(10, 10);
      result.push({ ...p, usage });
    } else {
      result.push(p);
    }

    if (p.type === "text-delta") {
      const id = p.id ?? "txt-0";
      if (lastTextDeltaIdx.get(id) === i && !seenTextEnd.has(id)) {
        result.push({ type: "text-end", id });
      }
    } else if (p.type === "reasoning-delta") {
      const id = p.id ?? "reasoning-0";
      if (lastReasoningDeltaIdx.get(id) === i && !seenReasoningEnd.has(id)) {
        result.push({ type: "reasoning-end", id });
      }
    }
  }

  return result;
}

/**
 * Turn a fixture `error` payload into the right runtime shape:
 * - an `APICallError` when the payload is an object carrying a `statusCode`
 *   (or `apiCallError: true`), so harness specs can exercise the orchestrator's
 *   status-aware paths (humanizeApiError 5xx canned text, summarizeApiErrorForLog
 *   forensics, retry classifier). `APICallError.isInstance` duck-types on a
 *   shared marker, so constructing it here satisfies the `isInstance` checks in
 *   error-utils.ts. A pure JSON fixture cannot otherwise build one (it would
 *   arrive as a plain string).
 * - a plain `Error` for string payloads (the common transient-message case).
 */
function buildFixtureError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as {
      apiCallError?: boolean;
      statusCode?: number;
      message?: string;
      responseBody?: string;
      url?: string;
      isRetryable?: boolean;
    };
    if (o.apiCallError === true || typeof o.statusCode === "number") {
      return new APICallError({
        message: o.message ?? `mock API error${o.statusCode ? ` (HTTP ${o.statusCode})` : ""}`,
        url: o.url ?? "https://mock.invalid/v1/chat/completions",
        requestBodyValues: {},
        statusCode: o.statusCode,
        responseBody: o.responseBody,
        isRetryable: o.isRetryable,
      });
    }
  }
  return new Error(typeof raw === "string" ? raw : "mock LLM error");
}

export async function loadMockModelFromDir(dir: string): Promise<LoadedMockModelHandle | null> {
  // Diagnostic logging path. Without these messages, every failure mode
  // (directory missing, no .json files, malformed JSON, no `model` block)
  // returns `null` silently — and the caller in src/index.ts used to swallow
  // it, leaving the orchestrator to fall back to the real provider with a
  // fake API key. Result: dump file contains `[]`, cost-leak specs fail
  // with "expected 0 to be greater than or equal to 3" with no clue why.
  // (Evidence: harness CI run 26431994835.)
  const log = (msg: string): void => {
    process.stderr.write(`[mock-model] ${msg}\n`);
  };
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (!existsSync(dir)) {
    log(`loadMockModelFromDir: dir does not exist: ${dir}`);
    return null;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    log(`loadMockModelFromDir: readdirSync(${dir}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (files.length === 0) {
    log(`loadMockModelFromDir: no .json files in ${dir}`);
    return null;
  }
  for (const f of files) {
    const full = join(dir, f);
    let raw: {
      model?: MockModelFixture & {
        unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
        defaultProviderOptions?: Record<string, unknown>;
      };
    };
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      log(`loadMockModelFromDir: JSON parse failed for ${full}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (raw.model === undefined) {
      // Not fatal — caller iterates further. But log so the test author
      // knows why their fixture was ignored.
      log(`loadMockModelFromDir: ${full} has no "model" top-level key — skipping`);
      continue;
    }
    if (raw.model.stream === undefined) {
      log(`loadMockModelFromDir: ${full} has "model" but no "stream" — skipping`);
      continue;
    }
    // Wrap plain-string `error` payloads in Error instances before passing
    // to createMockModel, so the AI SDK stream-loop and orchestrator see a
    // consistent Error shape regardless of fixture serialization.
    const normalized: MockModelFixture = {
      // File-based E2E fixtures supply agent turn-rounds; auto-answer the PIL
      // classifier call so it never consumes a round (a fixture may still set
      // autoClassify:false to opt out, or classify:"…" to force a line).
      autoClassify: true,
      ...raw.model,
      stream: isNestedArray(raw.model.stream)
        ? raw.model.stream.map(normalizeStreamChunks)
        : normalizeStreamChunks(raw.model.stream),
    };
    const base = createMockModel(normalized);
    log(
      `loadMockModelFromDir: installed mock from ${full} (provider=${raw.model.provider ?? "mock"}, modelId=${raw.model.modelId ?? "mock-model"})`,
    );
    return {
      model: base.model,
      get calls() {
        return base.calls;
      },
      reset: base.reset,
      unsupportedParams: raw.model.unsupportedParams,
      defaultProviderOptions: raw.model.defaultProviderOptions,
    };
  }
  log(`loadMockModelFromDir: scanned ${files.length} file(s) in ${dir} but none declared a {model:...} block`);
  return null;
}

// ---------------------------------------------------------------------------
// Install / uninstall helpers — wire a mock into `globalThis` so the runtime
// (src/providers/runtime.ts) picks it up in place of the real provider model.
// ---------------------------------------------------------------------------

interface MockGlobals {
  __muonroiMockModel?: unknown;
  __muonroiMockUnsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
  __muonroiMockDefaultProviderOptions?: Record<string, unknown>;
  __muonroiMockModelInfo?: unknown;
}

export interface MockInstallOptions {
  fixture: MockModelFixture;
  /**
   * Simulate `factory.unsupportedParams` (set by OAuth registry in production).
   * Use this to verify G1: backend rejects `maxOutputTokens`/`temperature`.
   */
  unsupportedParams?: ReadonlyArray<"maxOutputTokens" | "temperature" | "topP">;
  /**
   * Simulate `factory.defaultProviderOptions` (set by OAuth registry — e.g.
   * the OpenAI Codex backend injects `{store: false, instructions: ...}`).
   */
  defaultProviderOptions?: Record<string, unknown>;
  /**
   * Synthetic ModelInfo for non-catalog models. Set `reasoning: true` for
   * reasoning models so `shouldDropParam("temperature")` works correctly.
   */
  modelInfo?: Record<string, unknown>;
}

export interface InstalledMockHandle extends MockModelHandle {
  /** Remove the mock from globalThis. Idempotent. */
  uninstall(): void;
}

/**
 * Install a mock model on `globalThis` so `resolveModelRuntime` returns it
 * in place of the real provider model. Returns a handle with the recording
 * and an `uninstall()` to clear globals — call in `afterEach` to keep specs
 * isolated.
 */
/**
 * Phase H3 — exfiltrate mock-model recordings from a child process.
 *
 * Serializes `model.doStreamCalls` as JSON to `path`. Writes atomically via
 * `<path>.tmp` + `renameSync` so a parent spec never reads a half-written
 * file. Strict input shape — throws if `model.doStreamCalls` is missing.
 *
 * The serializer falls back to a hand-written shape when `JSON.stringify`
 * throws (e.g. circular tool refs). Each fallback entry preserves the fields
 * cost-leak specs actually assert against.
 */
export function dumpRecordings(
  path: string,
  model: MockLanguageModelV3 | { doStreamCalls: ReadonlyArray<unknown> },
): void {
  if (!model || !Array.isArray((model as { doStreamCalls?: unknown }).doStreamCalls)) {
    throw new Error("dumpRecordings: expected model with doStreamCalls array");
  }
  const calls = (model as { doStreamCalls: ReadonlyArray<unknown> }).doStreamCalls;
  let payload: string;
  try {
    payload = JSON.stringify(calls, null, 2);
  } catch {
    // Hand-written fallback for circular refs.
    const safe = calls.map((c) => {
      const opts = c as LanguageModelV3CallOptions & { headers?: unknown; tools?: Array<{ name?: string }> };
      return {
        prompt: opts.prompt,
        maxOutputTokens: opts.maxOutputTokens,
        temperature: opts.temperature,
        tools: Array.isArray(opts.tools) ? opts.tools.map((t) => ({ name: t.name })) : null,
        providerOptions: opts.providerOptions,
        headers: opts.headers,
      };
    });
    payload = JSON.stringify(safe, null, 2);
  }
  // Atomic write: temp file + rename. fs imports kept sync to stay safe in
  // process.on("exit") handlers where async work is silently dropped.
  // biome-ignore lint/style/noNonNullAssertion: node built-ins always present
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, path);
}

export function installMockModel(opts: MockInstallOptions): InstalledMockHandle {
  const handle = createMockModel(opts.fixture);
  const g = globalThis as MockGlobals;
  g.__muonroiMockModel = handle.model;
  g.__muonroiMockUnsupportedParams = opts.unsupportedParams;
  g.__muonroiMockDefaultProviderOptions = opts.defaultProviderOptions;
  g.__muonroiMockModelInfo = opts.modelInfo;
  return {
    ...handle,
    get calls() {
      return handle.calls;
    },
    reset: handle.reset,
    uninstall() {
      const cur = globalThis as MockGlobals;
      if (cur.__muonroiMockModel === handle.model) {
        delete cur.__muonroiMockModel;
        delete cur.__muonroiMockUnsupportedParams;
        delete cur.__muonroiMockDefaultProviderOptions;
        delete cur.__muonroiMockModelInfo;
      }
    },
  };
}

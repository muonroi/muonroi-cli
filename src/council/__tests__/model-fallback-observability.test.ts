/**
 * Council model-fallback observability.
 *
 * MEASURED EVIDENCE (operator's /ideal run, 2026-09-05, StepFun-only policy,
 * event stream captured as run3.jsonl + the run's own DB at
 * `<temp-home>/.muonroi-cli/muonroi.db`):
 *
 *   - The policy was violated by exactly TWO fallback calls (NOT 67 — the 67
 *     lines were the per-second heartbeat ticks of one 63s call; grouping the
 *     `council-speaker` events by `correlationId` gives 2 distinct calls).
 *   - The chain STARTED on an empty completion, not an error: the primary
 *     `step-3.5-flash` call succeeded, was billed (usage_events row id 4:
 *     361 in / 1024 out — output capped at the 1024 maxTokens budget), and
 *     returned "" after think-block stripping. That branch had NO diagnostic
 *     at all: not a throw, not a log, not an event.
 *   - Both fallbacks then FAILED with rich, actionable, and opposite-handling
 *     errors — interaction_logs id 19: glm-5.2, HTTP 429 "Insufficient balance
 *     or no resource package"; id 21: opencode/kimi-k2.7-code, HTTP 401
 *     "Insufficient balance" — and the bare `catch {}` swallowed both, so the
 *     terminal reason could only say "check provider reachability and API keys".
 *   - The ONLY trace of the switch on the wire was the display label
 *     `"<label> (fallback: glm-5.2)"` inside a council-speaker event.
 *
 * These tests pin all three behaviours as structured data.
 */
import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage/index.js", () => ({
  logInteraction: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../state/status-bar-store.js", () => ({
  statusBarStore: {
    getState: () => ({ in_tokens: 0, out_tokens: 0, cache_read_tokens: 0, session_usd: 0 }),
    setState: vi.fn(),
  },
}));

vi.mock("../../models/registry.js", () => ({
  getModelInfo: () => ({ inputPrice: 1, outputPrice: 2, cachedInputPrice: 0.1 }),
}));

import { LIFECYCLE_PRESET } from "@muonroi/agent-harness-core/event-filter";
import { redactEvent } from "@muonroi/agent-harness-core/event-redact";
import { LIVE_EVENT_KINDS, type LiveEvent } from "@muonroi/agent-harness-core/protocol";
import type { StreamChunk } from "../../types/index.js";
import { logger } from "../../utils/logger.js";
import { type CouncilCandidateFailure, summarizeCandidateFailures, tracedGenerateWithFallback } from "../llm.js";
import type { CouncilLLM } from "../types.js";

const mockLoggerError = logger.error as unknown as ReturnType<typeof vi.fn>;

/** Events captured off the SAME channel the orchestrator uses for stream-retry. */
let emitted: Array<Record<string, unknown>>;

beforeEach(() => {
  mockLoggerError.mockReset();
  emitted = [];
  (globalThis as Record<string, unknown>).__muonroiAgentRuntime = {
    emitEvent: (e: unknown) => emitted.push(e as Record<string, unknown>),
  };
});

function fallbackEvents(): Array<Record<string, unknown>> {
  return emitted.filter((e) => e.kind === "model-fallback");
}

function makeLlm(generateImpl: (modelId: string) => Promise<string>): CouncilLLM {
  return {
    generate: async (modelId: string) => generateImpl(modelId),
    debate: async () => ({ text: "", toolCalls: [] }),
    research: async () => "",
  };
}

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<{ chunks: StreamChunk[]; result: T }> {
  const chunks: StreamChunk[] = [];
  let r: IteratorResult<StreamChunk, T>;
  do {
    r = await gen.next();
    if (!r.done) chunks.push(r.value);
  } while (!r.done);
  return { chunks, result: r.value };
}

const BASE = { phase: "synthesis" as const, system: "sys", prompt: "p", tickIntervalMs: 0 };

// ---------------------------------------------------------------------------
// 1. The exact run3 trigger: a billed, successful, EMPTY completion.
// ---------------------------------------------------------------------------

describe("empty completion — the silent trigger that started the run3 chain", () => {
  it("advances to the next model and says so as structured data, not a label", async () => {
    const tried: string[] = [];
    const failures: CouncilCandidateFailure[] = [];
    const llm = makeLlm(async (m) => {
      tried.push(m);
      // Reproduces stripThinkBlocks() returning "" after the whole output budget
      // was spent inside <think> — a SUCCESS that yields nothing usable.
      return m === "primary-model" ? "   " : "real spec";
    });

    const { result } = await drain(
      tracedGenerateWithFallback(llm, {
        ...BASE,
        label: "Inferring spec from topic",
        models: ["primary-model", "second-model"],
        onCandidateFailure: (f) => failures.push(f),
      }),
    );

    expect(tried).toEqual(["primary-model", "second-model"]);
    expect(result).toBe("real spec");

    // The switch is observable WITHOUT parsing any display label.
    const ev = fallbackEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      t: "event",
      kind: "model-fallback",
      fromModel: "primary-model",
      toModel: "second-model",
      reason: "empty-completion",
      attempt: 1,
      totalCandidates: 2,
      label: "Inferring spec from topic",
    });

    // …and it survives to the caller.
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("empty-completion");

    // …and it is no longer silent in the log.
    expect(mockLoggerError).toHaveBeenCalled();
    const logged = JSON.stringify(mockLoggerError.mock.calls);
    expect(logged).toContain("primary-model");
    expect(logged).toContain("empty-completion");
  });
});

// ---------------------------------------------------------------------------
// 2. The swallowed reason: 429 vs 401 must stay distinguishable.
// ---------------------------------------------------------------------------

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://api.example.test/v1/chat",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { code: "1113", message } }),
    isRetryable: false,
  });
}

describe("thrown candidate — the reason the bare catch destroyed", () => {
  it("captures HTTP status + provider message instead of discarding them", async () => {
    const failures: CouncilCandidateFailure[] = [];
    const llm = makeLlm(async (m) => {
      if (m === "primary-model") throw apiError(429, "Insufficient balance or no resource package. Please recharge.");
      return "recovered";
    });

    const { result } = await drain(
      tracedGenerateWithFallback(llm, {
        ...BASE,
        label: "Inferring spec from topic",
        models: ["primary-model", "second-model"],
        onCandidateFailure: (f) => failures.push(f),
      }),
    );

    expect(result).toBe("recovered");
    const ev = fallbackEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ reason: "error", statusCode: 429, fromModel: "primary-model" });
    expect(String(ev[0].errorMessage)).toContain("Insufficient balance");

    // A 429 and a 401 want opposite responses — the status must reach the caller.
    expect(failures[0].statusCode).toBe(429);
    expect(failures[0].responseBodyTrunc).toContain("1113");
  });

  it("names every distinct failure when the whole chain is exhausted", async () => {
    const failures: CouncilCandidateFailure[] = [];
    const llm = makeLlm(async (m) => {
      if (m === "model-a") throw apiError(429, "Insufficient balance or no resource package.");
      if (m === "model-b") throw apiError(401, "Insufficient balance. Manage your billing here");
      return "";
    });

    const { result } = await drain(
      tracedGenerateWithFallback(llm, {
        ...BASE,
        label: "Inferring spec from topic",
        models: ["model-a", "model-b"],
        onCandidateFailure: (f) => failures.push(f),
      }),
    );

    expect(result).toBeNull();

    // The terminal record is filterable by `exhausted`, NOT by toModel:null —
    // the last candidate's own record also has toModel:null (no next model).
    const terminal = fallbackEvents().filter((e) => e.exhausted === true);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ toModel: null, statusCode: 401 });

    // The summary is what a run-finished / sprint-halt reason should carry
    // INSTEAD of "check provider reachability and API keys".
    const summary = summarizeCandidateFailures(failures);
    expect(summary).toContain("model-a: HTTP 429");
    expect(summary).toContain("model-b: HTTP 401");
    expect(summary).not.toContain("check provider reachability");
  });
});

// ---------------------------------------------------------------------------
// 3. Wire safety — the 160KB-body shape must not reach the transport.
// ---------------------------------------------------------------------------

describe("model-fallback wire payload", () => {
  it("is a registered kind, in the default preset, and fully redacted", () => {
    expect(LIVE_EVENT_KINDS).toContain("model-fallback");
    // A driver on the DEFAULT env must receive it, or the kind is decorative.
    expect(LIFECYCLE_PRESET.has("model-fallback")).toBe(true);
  });

  it("caps a hostile provider body and scrubs credentials", async () => {
    const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const llm = makeLlm(async (m) => {
      if (m === "model-a") throw apiError(400, `boom key=${KEY} body=${"X".repeat(200_000)}`);
      return "ok";
    });

    await drain(tracedGenerateWithFallback(llm, { ...BASE, label: "L", models: ["model-a", "model-b"] }));

    const raw = fallbackEvents()[0];
    const out = redactEvent(raw as unknown as LiveEvent) as unknown as Record<string, unknown>;

    // Not {t, kind}: the kind carries real content (the bug fixed for six kinds).
    expect(Object.keys(out).length).toBeGreaterThan(2);
    expect(String(out.errorMessage).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.statusCode).toBe(400);
  });
});

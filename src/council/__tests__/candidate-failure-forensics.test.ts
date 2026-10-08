/**
 * G2 — make an "empty completion" interpretable.
 *
 * MEASURED EVIDENCE (`~/.muonroi-cli/debug.log`, 2026-09-09, the run that then
 * killed the process): three candidates were recorded as
 * `reason:"empty-completion"` at 02:46:21.448 / .451 / .453 — three "successful"
 * provider calls in five milliseconds. `tracedGenerate` throws when the call
 * errors, so those really were `llm.generate` returning "" without throwing.
 * No real network call completes in under 2ms, but nothing in the record could
 * say so: it carried no duration, no evidence a request had been issued, and no
 * abort state. "The provider returned nothing" and "we never called the
 * provider" produced the identical log line.
 *
 * These tests pin the fields that separate those two cases.
 */
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

import { logger } from "../../utils/logger.js";
import { type CouncilCandidateFailure, tracedGenerateWithFallback } from "../llm.js";
import type { CouncilGenerateDiagnostics, CouncilLLM } from "../types.js";

const mockLoggerError = logger.error as unknown as ReturnType<typeof vi.fn>;

const BASE = { phase: "synthesis", tickIntervalMs: 0, system: "sys", prompt: "prompt" } as const;

/**
 * A CouncilLLM that returns "" and reports whatever diagnostics the scenario
 * wants — standing in for the two indistinguishable real-world cases.
 */
function makeLlm(
  diagFor: (modelId: string) => Partial<CouncilGenerateDiagnostics>,
  textFor: (modelId: string) => string = () => "",
  delayMs = 0,
): CouncilLLM {
  return {
    generate: async (modelId, _system, _prompt, _maxTokens, _onUsage, _signal, onDiagnostics) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      onDiagnostics?.({
        durationMs: delayMs,
        viaMock: false,
        requestIssued: true,
        sdkAttempts: 1,
        streamedChars: 0,
        rawTextChars: 0,
        textChars: 0,
        signalAbortedAtStart: false,
        signalAbortedAtEnd: false,
        ...diagFor(modelId),
      });
      return textFor(modelId);
    },
    debate: async () => ({ text: "", toolCalls: [] }),
    research: async () => "",
  };
}

async function drainFailures(
  llm: CouncilLLM,
  models: string[],
): Promise<{ failures: CouncilCandidateFailure[]; result: string | null }> {
  const failures: CouncilCandidateFailure[] = [];
  const gen = tracedGenerateWithFallback(llm, {
    ...BASE,
    label: "Synthesizing clarified spec",
    models,
    onCandidateFailure: (f) => failures.push(f),
  });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return { failures, result: step.value as string | null };
}

function fallbackLogCalls(): Array<Record<string, unknown>> {
  return mockLoggerError.mock.calls
    .filter((c) => String(c[1]).includes("candidate did not produce a completion"))
    .map((c) => c[2] as Record<string, unknown>);
}

beforeEach(() => {
  mockLoggerError.mockReset();
  (globalThis as Record<string, unknown>).__muonroiAgentRuntime = undefined;
  // The breadcrumb writer is inert under vitest unless a file override is set
  // (see crash-breadcrumb.ts) — these tests assert the record, not the trail.
  delete process.env.MUONROI_COUNCIL_BREADCRUMB_FILE;
});

describe("empty-completion forensics", () => {
  it("times every candidate, so a 2ms 'empty completion' is visibly impossible for a network call", async () => {
    const llm = makeLlm(
      () => ({ requestIssued: true }),
      () => "",
      25,
    );
    const { failures } = await drainFailures(llm, ["fixture-model-a", "fixture-model-b"]);

    const perCandidate = failures.filter((f) => !f.exhausted);
    expect(perCandidate).toHaveLength(2);
    for (const f of perCandidate) {
      expect(f.reason).toBe("empty-completion");
      expect(typeof f.elapsedMs).toBe("number");
      expect(f.elapsedMs as number).toBeGreaterThanOrEqual(20);
    }
  });

  it("records requestIssued:true + streamedChars, i.e. the provider genuinely answered with nothing", async () => {
    const llm = makeLlm(() => ({ requestIssued: true, sdkAttempts: 1, streamedChars: 512, rawTextChars: 512 }));
    const { failures } = await drainFailures(llm, ["fixture-model-a"]);

    const first = failures[0];
    expect(first.diagnostics?.requestIssued).toBe(true);
    expect(first.diagnostics?.streamedChars).toBe(512);
    // 512 raw chars stripped to 0 usable — the reasoning-budget case.
    expect(first.diagnostics?.rawTextChars).toBe(512);
    expect(first.diagnostics?.textChars).toBe(0);
  });

  it("records requestIssued:false, i.e. the empty string never reached the network", async () => {
    const llm = makeLlm(() => ({ requestIssued: false, sdkAttempts: 0, streamedChars: 0 }));
    const { failures } = await drainFailures(llm, ["fixture-model-a"]);

    const first = failures[0];
    expect(first.reason).toBe("empty-completion");
    expect(first.diagnostics?.requestIssued).toBe(false);
    expect(first.diagnostics?.sdkAttempts).toBe(0);
  });

  it("carries the abort state sampled at the start of the attempt", async () => {
    const llm = makeLlm(() => ({ signalAbortedAtStart: true }));
    const { failures } = await drainFailures(llm, ["fixture-model-a"]);
    expect(failures[0].signalAbortedAtStart).toBe(true);
  });

  it("flags a mock-LLM answer so a fixture run is never mistaken for a provider run", async () => {
    const llm = makeLlm(() => ({ viaMock: true, requestIssued: false }));
    const { failures } = await drainFailures(llm, ["fixture-model-a"]);
    expect(failures[0].diagnostics?.viaMock).toBe(true);
  });

  it("puts the new fields on the log line, not just the callback record", async () => {
    const llm = makeLlm(
      () => ({ requestIssued: true, streamedChars: 7, sdkAttempts: 2 }),
      () => "",
      10,
    );
    await drainFailures(llm, ["fixture-model-a"]);

    const ctx = fallbackLogCalls()[0];
    expect(ctx.reason).toBe("empty-completion");
    expect(ctx.requestIssued).toBe(true);
    expect(ctx.streamedChars).toBe(7);
    expect(ctx.sdkAttempts).toBe(2);
    expect(typeof ctx.elapsedMs).toBe("number");
  });

  it("gives the terminal exhausted record the whole-chain elapsed and the last diagnostics", async () => {
    const llm = makeLlm(
      () => ({ requestIssued: true }),
      () => "",
      10,
    );
    const { failures, result } = await drainFailures(llm, ["fixture-model-a", "fixture-model-b"]);

    expect(result).toBeNull();
    const exhausted = failures.find((f) => f.exhausted);
    expect(exhausted).toBeDefined();
    expect(typeof exhausted?.elapsedMs).toBe("number");
    expect(exhausted?.elapsedMs as number).toBeGreaterThanOrEqual(20);
    expect(exhausted?.diagnostics?.requestIssued).toBe(true);
  });

  it("still reports a successful candidate without touching the failure path", async () => {
    const llm = makeLlm(
      () => ({ requestIssued: true }),
      (m) => (m === "fixture-model-b" ? "a real answer" : ""),
    );
    const { failures, result } = await drainFailures(llm, ["fixture-model-a", "fixture-model-b"]);

    expect(result).toBe("a real answer");
    expect(failures.filter((f) => !f.exhausted)).toHaveLength(1);
    expect(failures.some((f) => f.exhausted)).toBe(false);
  });

  it("marks a blocked candidate with elapsedMs 0 and no diagnostics — it never ran", async () => {
    const llm = makeLlm(
      () => ({ requestIssued: true }),
      () => "answer",
    );
    llm.isModelBlocked = (m) => m === "fixture-model-a";
    const { failures, result } = await drainFailures(llm, ["fixture-model-a", "fixture-model-b"]);

    expect(result).toBe("answer");
    const blocked = failures.find((f) => f.reason === "blocked");
    expect(blocked?.elapsedMs).toBe(0);
    expect(blocked?.diagnostics).toBeUndefined();
  });
});

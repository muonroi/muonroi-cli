/**
 * Abort-signal threading contract for the council subsystem.
 *
 * Bug this guards: a user-abort signal that reaches `runCouncil(options.signal)`
 * was never forwarded to the `generate`-based call path (clarify, research-need,
 * leader-eval, opening statements, round summary, synthesis, debate planning).
 * `llm.generate` had no `signal` parameter at all and `withTimeoutSignal(undefined,…)`
 * was hard-coded — so pressing Esc/Ctrl-C mid-council did nothing and the run
 * continued making LLM calls to completion.
 *
 * The fix:
 *  1. `CouncilLLM.generate` accepts a trailing `signal?` and threads it into the
 *     SDK call via `withTimeoutSignal(signal, …)`.
 *  2. `runCouncil` wraps the injected `llm` with `withCouncilSignal(llm, signal)`
 *     so EVERY generate call site (none of which pass a signal) inherits it.
 *  3. `planDebate` forwards the signal to its direct `generateObject` attempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCouncilSignal } from "../index.js";
import type { CouncilCallUsage, CouncilLLM } from "../types.js";

/** Recording fake — captures the `signal` argument each method received. */
function recordingLlm(generateReply: (prompt: string) => string = () => "{}") {
  const calls: Array<{ kind: "generate" | "debate" | "research"; signal?: AbortSignal }> = [];
  const llm: CouncilLLM = {
    generate: async (_modelId, _system, prompt, _maxTokens, _onUsage, signal) => {
      calls.push({ kind: "generate", signal });
      return generateReply(prompt);
    },
    debate: async (_modelId, _system, _prompt, signal) => {
      calls.push({ kind: "debate", signal });
      return { text: "ok", toolCalls: [] };
    },
    research: async (_modelId, _topic, _ctx, signal) => {
      calls.push({ kind: "research", signal });
      return "findings";
    },
  };
  return { llm, calls };
}

describe("withCouncilSignal — injects the council abort signal into generate", () => {
  it("forwards the wrapper signal when the caller passes none", async () => {
    const { llm, calls } = recordingLlm();
    const ac = new AbortController();
    const wrapped = withCouncilSignal(llm, ac.signal);

    // tracedGenerate / openingWithRetry / judgeReadiness all call generate with
    // <= 4 positional args — i.e. no signal. The wrapper must inject ours.
    await wrapped.generate("m", "sys", "prompt", 256);

    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBe(ac.signal);
  });

  it("lets an explicit caller signal win over the injected one", async () => {
    const { llm, calls } = recordingLlm();
    const injected = new AbortController().signal;
    const explicit = new AbortController().signal;
    const wrapped = withCouncilSignal(llm, injected);

    await wrapped.generate("m", "sys", "prompt", 256, undefined, explicit);

    expect(calls[0].signal).toBe(explicit);
  });

  it("is a no-op passthrough when no signal is configured (sprint path)", () => {
    const { llm } = recordingLlm();
    expect(withCouncilSignal(llm, undefined)).toBe(llm);
  });
});

describe("createCouncilLLM.generate — honours the parent abort signal", () => {
  beforeEach(() => vi.resetModules());

  it("propagates an already-aborted parent into the SDK abortSignal", async () => {
    const captured: Array<Record<string, unknown>> = [];
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
        captured.push(args);
        return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
      }),
      stepCountIs: vi.fn().mockReturnValue({ __step: 1 }),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as never, "agent" as never, undefined, stats);

    const ac = new AbortController();
    ac.abort(new Error("user pressed Esc"));
    await llm.generate("gpt-4o", "sys", "prompt", 256, undefined, ac.signal);

    expect(captured).toHaveLength(1);
    const sig = captured[0].abortSignal as AbortSignal | undefined;
    expect(sig).toBeDefined();
    expect(sig?.aborted).toBe(true);
  });

  it("does NOT abort the SDK call when the parent is live", async () => {
    const captured: Array<Record<string, unknown>> = [];
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
        captured.push(args);
        return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
      }),
      stepCountIs: vi.fn().mockReturnValue({ __step: 1 }),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));

    const { createCouncilLLM } = await import("../llm.js");
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM({} as never, "agent" as never, undefined, stats);

    const ac = new AbortController();
    await llm.generate("gpt-4o", "sys", "prompt", 256, undefined, ac.signal);

    const sig = captured[0].abortSignal as AbortSignal | undefined;
    expect(sig?.aborted).toBe(false);
  });
});

describe("evaluateResearchNeed — generate call inherits the wrapped signal", () => {
  it("records the council signal on the underlying generate call", async () => {
    const { evaluateResearchNeed } = await import("../debate.js");
    const { llm, calls } = recordingLlm(() => '{"needsResearch": false}');
    const ac = new AbortController();
    const wrapped = withCouncilSignal(llm, ac.signal);

    const spec = {
      problemStatement: "x",
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: [],
    };
    const gen = evaluateResearchNeed(spec, "leader-model", "ctx", wrapped, false);
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    const genCalls = calls.filter((c) => c.kind === "generate");
    expect(genCalls.length).toBeGreaterThan(0);
    for (const c of genCalls) expect(c.signal).toBe(ac.signal);
  });
});

describe("planDebate — forwards signal to the direct generateObject attempt", () => {
  beforeEach(() => vi.resetModules());

  it("passes an abort-linked signal to generateObject", async () => {
    const captured: Array<Record<string, unknown>> = [];
    vi.doMock("ai", () => ({
      generateObject: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
        captured.push(args);
        return {
          object: {
            intentSummary: "s",
            stances: [
              { name: "A", lens: "l1" },
              { name: "B", lens: "l2" },
            ],
            outputShape: { kind: "decision", sections: [{ key: "k", heading: "H", shape: "list" }], guardrails: [] },
          },
        };
      }),
    }));
    vi.doMock("../../providers/keychain.js", () => ({
      loadKeyForProvider: vi.fn().mockResolvedValue("test-key"),
    }));
    vi.doMock("../../providers/runtime.js", () => ({
      detectProviderForModel: vi.fn().mockReturnValue("openai"),
      createProviderFactory: vi.fn().mockReturnValue({ factory: {} }),
      createProviderFactoryAsync: vi.fn().mockResolvedValue({ factory: {} }),
      resolveModelRuntime: vi.fn().mockReturnValue({ model: {}, providerOptions: undefined }),
    }));

    const { planDebate } = await import("../debate-planner.js");
    const spec = {
      problemStatement: "x",
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: [],
    };
    const ac = new AbortController();
    ac.abort(new Error("user pressed Esc"));

    const { llm } = recordingLlm();
    const gen = planDebate(spec, "leader-model", llm, undefined, undefined, undefined, undefined, ac.signal);
    let step = await gen.next();
    while (!step.done) step = await gen.next();

    expect(captured).toHaveLength(1);
    const sig = captured[0].abortSignal as AbortSignal | undefined;
    expect(sig).toBeDefined();
    expect(sig?.aborted).toBe(true);
  });
});

/**
 * Bước 2 metered gate — meter-only skeleton unit tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mockLog = vi.fn();
vi.mock("../storage/interaction-log.js", () => ({ logInteraction: mockLog }));

const {
  analyzePrompt,
  ceilingForCall,
  ceilingMode,
  enforceCeiling,
  InputCeilingExceededError,
  meterCall,
  throwCeilingTokens,
  wrapModelWithGate,
} = await import("./model-gate.js");

afterEach(() => {
  mockLog.mockReset();
  delete process.env.MUONROI_GATE;
  delete process.env.MUONROI_GATE_CEILING;
  delete process.env.MUONROI_GATE_CEILING_RATIO;
  delete process.env.MUONROI_GATE_THROW_MAX_TOKENS;
});

describe("analyzePrompt segment attribution", () => {
  it("attributes system string vs history vs tool-results", () => {
    const prompt = [
      { role: "system", content: "you are helpful" }, // 15 chars → system
      { role: "user", content: [{ type: "text", text: "hello world" }] }, // 11 → history
      {
        role: "tool",
        content: [{ type: "tool-result", output: { value: "AAAA" } }], // JSON.stringify → toolResults
      },
    ];
    const comp = analyzePrompt(prompt);
    expect(comp.bySegment.system).toBe(15);
    expect(comp.bySegment.history).toBe(11);
    expect(comp.bySegment.toolResults).toBe(JSON.stringify({ value: "AAAA" }).length);
    expect(comp.estInputTokens).toBe(Math.round(comp.chars / 4));
  });

  it("counts file parts as bytes, NOT chars/4 (H9)", () => {
    const prompt = [{ role: "user", content: [{ type: "file", data: "ZmFrZS1iYXNlNjQ=", mediaType: "image/png" }] }];
    const comp = analyzePrompt(prompt);
    expect(comp.fileParts).toBe(1);
    expect(comp.fileBytes).toBe("ZmFrZS1iYXNlNjQ=".length);
    // base64 must not inflate the text-token estimate
    expect(comp.estInputTokens).toBe(0);
  });

  it("returns an empty composition for a non-array prompt", () => {
    const comp = analyzePrompt(undefined);
    expect(comp.estInputTokens).toBe(0);
    expect(comp.chars).toBe(0);
  });
});

describe("meterCall", () => {
  it("writes a call_accounting row with the stage + segment breakdown", () => {
    meterCall(
      [{ role: "system", content: "hi" }],
      { stage: "main", modelId: "m1", sessionId: "s1", ceiling: 1000 },
      "stream",
    );
    expect(mockLog).toHaveBeenCalledTimes(1);
    const [sessionId, type, meta] = mockLog.mock.calls[0];
    expect(sessionId).toBe("s1");
    expect(type).toBe("call_accounting");
    expect(meta.eventSubtype).toBe("main");
    expect(meta.data.stage).toBe("main");
    expect(meta.data.ceilingHit).toBe(false);
  });

  it("no-ops without a sessionId (nowhere to attribute — H8)", () => {
    meterCall([{ role: "system", content: "hi" }], { stage: "unattributed", modelId: "m1" }, "stream");
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("flags ceilingHit when est exceeds the ceiling", () => {
    const big = "x".repeat(8000); // ~2000 est tokens
    meterCall(
      [{ role: "user", content: big }],
      { stage: "main", modelId: "m1", sessionId: "s1", ceiling: 100 },
      "generate",
    );
    expect(mockLog.mock.calls[0][2].data.ceilingHit).toBe(true);
  });
});

describe("wrapModelWithGate", () => {
  const ctx = { stage: "main" as const, modelId: "m1", sessionId: "s1" };

  it("returns the model untouched when MUONROI_GATE=0", () => {
    process.env.MUONROI_GATE = "0";
    const model = { specificationVersion: "v3", doStream: async () => ({}) };
    expect(wrapModelWithGate(model, ctx)).toBe(model);
  });

  it("returns a NEW object, not a mutation of the input (H6)", () => {
    const model = {
      specificationVersion: "v3" as const,
      provider: "x",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    const wrapped = wrapModelWithGate(model as any, ctx);
    expect(wrapped).not.toBe(model);
    expect(model.doStream).toBe(model.doStream); // input method not swapped
  });

  it("meters then delegates to the inner doStream transparently", async () => {
    const inner = vi.fn(async () => ({ stream: "S" }));
    const model = {
      specificationVersion: "v3" as const,
      provider: "x",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: async () => ({}),
      doStream: inner,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    const wrapped = wrapModelWithGate(model as any, ctx);
    const res = await wrapped.doStream({ prompt: [{ role: "system", content: "hi" }] });
    expect(res).toEqual({ stream: "S" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][1]).toBe("call_accounting");
  });
});

describe("ceilingMode", () => {
  it("defaults to warn for normal stages, throw for subagent/vision (per-stage default)", () => {
    expect(ceilingMode()).toBe("warn"); // no stage → warn
    expect(ceilingMode("main")).toBe("warn");
    expect(ceilingMode("council")).toBe("warn");
    expect(ceilingMode("subagent")).toBe("throw"); // runaway-prone → armed by default
    expect(ceilingMode("vision")).toBe("throw");
  });

  it("explicit MUONROI_GATE_CEILING overrides every stage", () => {
    process.env.MUONROI_GATE_CEILING = "off";
    expect(ceilingMode("subagent")).toBe("off");
    process.env.MUONROI_GATE_CEILING = "warn";
    expect(ceilingMode("subagent")).toBe("warn"); // force subagent back to warn-only
    process.env.MUONROI_GATE_CEILING = "THROW";
    expect(ceilingMode("main")).toBe("throw");
    process.env.MUONROI_GATE_CEILING = "nonsense";
    expect(ceilingMode("main")).toBe("warn");
  });
});

describe("enforceCeiling", () => {
  // est over the (low, for-test) absolute throw cap
  const overThrow = {
    estInputTokens: 5000,
    bySegment: { system: 0, history: 20000, toolResults: 0 },
    fileParts: 0,
    fileBytes: 0,
    chars: 20000,
  };
  const underThrow = { ...overThrow, estInputTokens: 500 };

  it("throws for subagent when est exceeds the ABSOLUTE throw cap (default-armed)", () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "1000";
    // no MUONROI_GATE_CEILING → subagent defaults to throw
    expect(() => enforceCeiling(overThrow, { stage: "subagent", modelId: "m", ceiling: 999999 })).toThrow(
      InputCeilingExceededError,
    );
  });

  it("does NOT throw for a non-eligible stage even over the throw cap (main stays advisory)", () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "1000";
    process.env.MUONROI_GATE_CEILING = "throw";
    expect(() => enforceCeiling(overThrow, { stage: "main", modelId: "m", ceiling: 999999 })).not.toThrow();
  });

  it("does NOT throw when under the throw cap (normal capped subagent work is safe)", () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "1000";
    expect(() => enforceCeiling(underThrow, { stage: "subagent", modelId: "m", ceiling: 999999 })).not.toThrow();
  });

  it("off mode never throws", () => {
    process.env.MUONROI_GATE_CEILING = "off";
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "1000";
    expect(() => enforceCeiling(overThrow, { stage: "subagent", modelId: "m", ceiling: 100 })).not.toThrow();
  });

  it("warn line (window×ratio ceiling) never throws, only logs", () => {
    process.env.MUONROI_GATE_CEILING = "warn";
    // est over the soft ceiling but warn mode → no throw
    expect(() => enforceCeiling(overThrow, { stage: "subagent", modelId: "m", ceiling: 100 })).not.toThrow();
  });
});

describe("throwCeilingTokens", () => {
  it("defaults to 100000, honors MUONROI_GATE_THROW_MAX_TOKENS", () => {
    expect(throwCeilingTokens()).toBe(100000);
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "50000";
    expect(throwCeilingTokens()).toBe(50000);
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "bad";
    expect(throwCeilingTokens()).toBe(100000);
  });
});

describe("wrapModelWithGate ceiling enforcement", () => {
  it("throws before delegating when a subagent call exceeds the absolute throw cap", async () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "50"; // ~200 chars
    const inner = vi.fn(async () => ({ stream: "S" }));
    const model = {
      specificationVersion: "v3" as const,
      provider: "x",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: async () => ({}),
      doStream: inner,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    const wrapped = wrapModelWithGate(model as any, {
      stage: "subagent",
      modelId: "m1",
      sessionId: "s1",
      ceiling: 999999,
    });
    const big = "x".repeat(400); // ~100 est tokens > 50 throw cap
    await expect(wrapped.doStream({ prompt: [{ role: "user", content: big }] })).rejects.toBeInstanceOf(
      InputCeilingExceededError,
    );
    expect(inner).not.toHaveBeenCalled(); // fail BEFORE the expensive call
  });

  it("does NOT throw for a main call over the same cap (only subagent/vision armed)", async () => {
    process.env.MUONROI_GATE_THROW_MAX_TOKENS = "50";
    const inner = vi.fn(async () => ({ stream: "S" }));
    const model = {
      specificationVersion: "v3" as const,
      provider: "x",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: async () => ({}),
      doStream: inner,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    const wrapped = wrapModelWithGate(model as any, { stage: "main", modelId: "m1", sessionId: "s1", ceiling: 999999 });
    await wrapped.doStream({ prompt: [{ role: "user", content: "x".repeat(400) }] });
    expect(inner).toHaveBeenCalledTimes(1); // main proceeds
  });
});

describe("ceilingForCall", () => {
  it("derives from catalog contextWindow (ratio 1.0 default)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({ contextWindow: 128000 } as any)).toBe(128000);
  });
  it("scales by MUONROI_GATE_CEILING_RATIO (H7 stage budget policy)", () => {
    process.env.MUONROI_GATE_CEILING_RATIO = "0.6";
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({ contextWindow: 200000 } as any)).toBe(120000);
    process.env.MUONROI_GATE_CEILING_RATIO = "2"; // out of range → no scaling
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({ contextWindow: 200000 } as any)).toBe(200000);
    delete process.env.MUONROI_GATE_CEILING_RATIO;
  });
  it("returns undefined without a context window", () => {
    expect(ceilingForCall(undefined)).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({} as any)).toBeUndefined();
  });
});

// ─── Request pacing (declared catalog rate limits, enforced at the gate) ─────

const { __resetRateLimiterForTests, RATE_LIMIT_WINDOW_MS } = await import("./rate-limiter.js");

/** Minimal LanguageModelV3-shaped stub whose doStream returns a real stream. */
function streamModel(inner = vi.fn(async () => ({ stream: new ReadableStream({ start: (c) => c.close() }) }))) {
  return {
    model: {
      specificationVersion: "v3" as const,
      provider: "x",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: vi.fn(async () => ({})),
      doStream: inner,
    },
    inner,
  };
}

describe("wrapModelWithGate request pacing", () => {
  const PACED = { concurrency: 5, requestsPerMinute: 2 };

  afterEach(() => {
    __resetRateLimiterForTests();
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_RATE_LIMIT;
  });

  it("does not wrap or pace a model whose catalog declares no rate limits", async () => {
    const { model, inner } = streamModel();
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    const wrapped = wrapModelWithGate(model as any, { stage: "main", modelId: "m1", sessionId: "s1" });
    await wrapped.doStream({ prompt: [{ role: "user", content: "hi" }] });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("still paces when the METER is disabled — MUONROI_GATE=0 must not disarm rate limiting", () => {
    process.env.MUONROI_GATE = "0";
    const { model } = streamModel();
    const paced = wrapModelWithGate(
      // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
      model as any,
      { stage: "main", modelId: "m1", providerId: "stepfun", rateLimits: PACED },
    );
    expect(paced).not.toBe(model); // wrapped for pacing even with the meter off
    // ...whereas an unpaced model with the meter off is returned untouched.
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(wrapModelWithGate(model as any, { stage: "main", modelId: "m1" })).toBe(model);
  });

  it("emits rate-limit-wait so a driver can tell a deliberate hold from a hang", async () => {
    // Fake timers: the held call really would sleep a full window otherwise.
    vi.useFakeTimers();
    try {
      const events: Array<Record<string, unknown>> = [];
      (globalThis as Record<string, unknown>).__muonroiAgentRuntime = {
        emitEvent: (e: unknown) => events.push(e as Record<string, unknown>),
      };
      const { model, inner } = streamModel();
      const ctx = { stage: "main" as const, modelId: "m1", providerId: "stepfun", rateLimits: PACED };
      // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
      const wrapped = wrapModelWithGate(model as any, ctx);
      const p = [{ role: "user" as const, content: "hi" }];
      await wrapped.doStream({ prompt: p });
      await wrapped.doStream({ prompt: p });
      expect(events).toHaveLength(0); // the first two fit the declared budget of 2
      expect(inner).toHaveBeenCalledTimes(2);

      const third = wrapped.doStream({ prompt: p });
      // Let the pacer reach its sleep without advancing the clock.
      await Promise.resolve();
      await Promise.resolve();

      // The hold is announced IMMEDIATELY — before the call completes. If it were
      // announced on release, the wait would be invisible for its whole duration,
      // which is the "paced looks exactly like hung" failure this event exists to
      // remove. And the request must NOT have been dispatched yet.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "rate-limit-wait",
        provider: "stepfun",
        modelId: "m1",
        stage: "main",
        limitKind: "requests-per-minute",
        limit: 2,
        waitMs: RATE_LIMIT_WINDOW_MS,
      });
      expect(inner).toHaveBeenCalledTimes(2); // held, not sent

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS);
      await third;
      expect(inner).toHaveBeenCalledTimes(3); // released and dispatched
    } finally {
      vi.useRealTimers();
    }
  });

  it("MUONROI_RATE_LIMIT=0 disables pacing", async () => {
    process.env.MUONROI_RATE_LIMIT = "0";
    const events: unknown[] = [];
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent: (e: unknown) => events.push(e) };
    const { model, inner } = streamModel();
    const wrapped = wrapModelWithGate(
      // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
      model as any,
      { stage: "main", modelId: "m1", providerId: "stepfun", rateLimits: PACED },
    );
    const p = [{ role: "user" as const, content: "hi" }];
    for (let i = 0; i < 6; i++) await wrapped.doStream({ prompt: p });
    expect(inner).toHaveBeenCalledTimes(6);
    expect(events).toHaveLength(0);
  });
});

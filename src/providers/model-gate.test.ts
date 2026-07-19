/**
 * Bước 2 metered gate — meter-only skeleton unit tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzePrompt, ceilingForCall, meterCall, wrapModelWithGate } from "./model-gate.js";

const mockLog = vi.hoisted(() => vi.fn());
vi.mock("../storage/interaction-log.js", () => ({ logInteraction: mockLog }));

afterEach(() => {
  mockLog.mockReset();
  delete process.env.MUONROI_GATE;
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

describe("ceilingForCall", () => {
  it("derives from catalog contextWindow", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({ contextWindow: 128000 } as any)).toBe(128000);
  });
  it("returns undefined without a context window", () => {
    expect(ceilingForCall(undefined)).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: test cast to a minimal model stub
    expect(ceilingForCall({} as any)).toBeUndefined();
  });
});

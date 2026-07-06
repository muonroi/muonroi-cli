import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/index.js";
import type { ResolvedModelRuntime } from "../runtime.js";
import { resolveTemperatureParam } from "../runtime.js";

/**
 * Regression coverage for resolveTemperatureParam — the orchestrator-side
 * temperature helper. Guards against reintroducing the hardcoded
 * `temperature: 0.7` that made every Moonshot/Kimi (opencode-go) tool-loop
 * turn fail with "invalid temperature: only 1 is allowed for this model".
 */

function baseModel(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: "test-model",
    name: "Test Model",
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "fixture",
    provider: "openai",
    ...overrides,
  };
}

function runtime(model: ModelInfo, unsupportedParams?: string[]): ResolvedModelRuntime {
  return { modelInfo: model, unsupportedParams } as unknown as ResolvedModelRuntime;
}

describe("resolveTemperatureParam", () => {
  it("returns the desired temperature for a normal model", () => {
    const rt = runtime(baseModel({ provider: "deepseek", id: "deepseek-v4-flash" }));
    expect(resolveTemperatureParam(rt, 0.7)).toEqual({ temperature: 0.7 });
  });

  it("clamps to the model's fixed_temperature (Kimi via opencode-go)", () => {
    const rt = runtime(baseModel({ provider: "opencode-go", id: "opencode/kimi-k2.7-code", fixedTemperature: 1 }));
    // Desired 0.7 must NOT be sent — Moonshot rejects anything but 1.
    expect(resolveTemperatureParam(rt, 0.7)).toEqual({ temperature: 1 });
    expect(resolveTemperatureParam(rt, 0.3)).toEqual({ temperature: 1 });
  });

  it("omits temperature for reasoning models that do not accept it", () => {
    // OpenAI Responses-API reasoning model → acceptsParam('temperature') is false.
    const rt = runtime(baseModel({ provider: "openai", id: "gpt-5.4", reasoning: true }));
    expect(resolveTemperatureParam(rt, 0.7)).toEqual({});
  });

  it("omits temperature when the OAuth registry marks it unsupported", () => {
    const rt = runtime(baseModel({ provider: "openai", id: "codex" }), ["temperature"]);
    expect(resolveTemperatureParam(rt, 0.7)).toEqual({});
  });
});

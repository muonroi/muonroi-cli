/**
 * Regression cover for the council output-budget defect.
 *
 * MECHANISM (measured live against StepFun 2026-09-05, council spec-synthesis
 * prompt, `max_tokens: 1024` — the literal that used to sit at
 * src/council/clarifier.ts:753):
 *
 *     finish_reason: "length"
 *     content:            0 chars
 *     reasoning_content:  5134 chars
 *     usage.completion_tokens: 1024        (== the cap)
 *     usage.completion_tokens_details.reasoning_tokens: 0
 *
 * The whole budget went into the thinking block; the visible answer never
 * started; `stripThinkBlocks` returned ""; the council fallback chain read that
 * as `empty-completion` and walked every candidate model until exhausted.
 * Corroborated in the captured run DB (ideal-home-ooCK36 usage_events ids 3/4/5:
 * step-3.5-flash, step-3.5-flash-2603 and step-3.7-flash each billed
 * `in=404 out=1024` — output pinned to the cap exactly — matching the three
 * `model-fallback reason=empty-completion` events in run4.jsonl).
 *
 * The fix is NOT "raise the literal": it is to treat a caller's number as a
 * VISIBLE-output budget and size the request from the model's catalog-declared
 * ceiling whenever thinking shares that budget.
 */
import { describe, expect, it } from "vitest";
import { catalogModelToModelInfo } from "../../models/catalog-client.js";
import type { ModelInfo } from "../../types/index.js";
import { DEFAULT_REASONING_OUTPUT_BUDGET_TOKENS, resolveMaxOutputTokens } from "../capabilities.js";
import { resolveMaxOutputTokensParam } from "../runtime.js";

function model(over: Partial<ModelInfo>): ModelInfo {
  return {
    id: "m",
    name: "m",
    contextWindow: 256_000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: "",
    provider: "stepfun",
    ...over,
  };
}

describe("resolveMaxOutputTokens", () => {
  it("widens a reasoning model's budget to its catalog-declared ceiling", () => {
    // step-3.5-flash: reasoning: true, max_output_tokens: 8192.
    // The council asked for 1024 visible tokens; thinking ate all 1024.
    const m = model({ id: "step-3.5-flash", reasoning: true, maxOutputTokens: 8192 });
    expect(resolveMaxOutputTokens("stepfun", m, 1024)).toBe(8192);
  });

  it("uses the DECLARED default when the catalog publishes no ceiling", () => {
    // step-3.7-flash declares `max_output_tokens: 0` — the "not published"
    // sentinel — which catalogModelToModelInfo maps to undefined. It must never
    // become a request for 0 tokens, and must not silently fall back to the
    // caller's too-small visible budget either.
    const m = model({ id: "step-3.7-flash", reasoning: true, maxOutputTokens: undefined });
    const got = resolveMaxOutputTokens("stepfun", m, 1024);
    expect(got).toBe(DEFAULT_REASONING_OUTPUT_BUDGET_TOKENS);
    expect(got).not.toBe(0);
    expect(got).not.toBe(1024);
  });

  it("leaves a NON-reasoning model's budget exactly as the caller asked", () => {
    const m = model({ reasoning: false, maxOutputTokens: 8192 });
    expect(resolveMaxOutputTokens("stepfun", m, 1024)).toBe(1024);
  });

  it("never shrinks a caller that already asked for more than the ceiling", () => {
    const m = model({ reasoning: true, maxOutputTokens: 4096 });
    expect(resolveMaxOutputTokens("stepfun", m, 6144)).toBe(6144);
  });

  it("omits the param entirely when the model does not accept it", () => {
    const m = model({ reasoning: true, maxOutputTokens: 8192, supportsMaxOutputTokens: false });
    expect(resolveMaxOutputTokens("stepfun", m, 1024)).toBeUndefined();
  });
});

describe("catalogModelToModelInfo — max_output_tokens", () => {
  const base = {
    id: "x",
    name: "x",
    provider: "stepfun",
    context_window: 256_000,
    input_price_per_million: 0,
    output_price_per_million: 0,
    reasoning: true,
    description: "",
  };

  it("carries a declared ceiling through to ModelInfo", () => {
    // Before the fix this field was dropped on the floor: the catalog declared
    // max_output_tokens but ModelInfo had no such property, so no call site
    // could size a budget from it.
    const info = catalogModelToModelInfo({ ...base, max_output_tokens: 8192 } as never);
    expect(info.maxOutputTokens).toBe(8192);
  });

  it("maps the 0 sentinel to undefined, not to a zero ceiling", () => {
    const info = catalogModelToModelInfo({ ...base, max_output_tokens: 0 } as never);
    expect(info.maxOutputTokens).toBeUndefined();
  });
});

describe("resolveMaxOutputTokensParam (the spread every council wire site uses)", () => {
  it("emits the ceiling for a reasoning model", () => {
    const runtime = {
      model: {},
      modelId: "step-3.5-flash",
      modelInfo: model({ id: "step-3.5-flash", reasoning: true, maxOutputTokens: 8192 }),
    };
    expect(resolveMaxOutputTokensParam(runtime as never, 1024)).toEqual({ maxOutputTokens: 8192 });
  });

  it("still omits the param on an OAuth backend that rejects it", () => {
    // ChatGPT Codex 400s on max_output_tokens — the pre-existing guard this
    // helper must not regress.
    const runtime = {
      model: {},
      modelId: "step-3.5-flash",
      modelInfo: model({ id: "step-3.5-flash", reasoning: true, maxOutputTokens: 8192 }),
      unsupportedParams: ["maxOutputTokens"] as const,
    };
    expect(resolveMaxOutputTokensParam(runtime as never, 1024)).toEqual({});
  });
});

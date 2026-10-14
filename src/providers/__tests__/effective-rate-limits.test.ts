import { describe, expect, it } from "vitest";
import { effectiveRateLimits } from "../runtime.js";

const STEPFUN = {
  id: "step-5-preview",
  provider: "stepfun",
  rateLimits: { concurrency: 5, requestsPerMinute: 100, tokensPerMinute: 500_000 },
};

describe("effectiveRateLimits — per-account overrides of the catalog's rate_limits", () => {
  it("returns the catalog value when the account sets nothing", () => {
    expect(effectiveRateLimits(STEPFUN, undefined)).toEqual(STEPFUN.rateLimits);
    expect(effectiveRateLimits(STEPFUN, {})).toEqual(STEPFUN.rateLimits);
  });

  // StepFun V0 accounts allow 10 RPM; the catalog holds a higher tier's number.
  it("applies a provider-wide override field by field", () => {
    expect(effectiveRateLimits(STEPFUN, { stepfun: { requests_per_minute: 10 } })).toEqual({
      concurrency: 5,
      requestsPerMinute: 10,
      tokensPerMinute: 500_000,
    });
  });

  it("lets a model entry win over the provider entry", () => {
    const out = effectiveRateLimits(STEPFUN, {
      stepfun: { concurrency: 2, tokens_per_minute: 100_000 },
      "step-5-preview": { concurrency: 3 },
    });
    expect(out).toEqual({ concurrency: 3, requestsPerMinute: 100, tokensPerMinute: 100_000 });
  });

  it("declares limits for an un-annotated model and ignores nonsense values", () => {
    const bare = { id: "m", provider: "p", rateLimits: undefined };
    expect(effectiveRateLimits(bare, { p: { concurrency: 4, requests_per_minute: -1 } })).toEqual({ concurrency: 4 });
  });
});

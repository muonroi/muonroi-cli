// src/product-loop/__tests__/discovery-recommender.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  computeCostGuard,
  councilRecommend,
  leaderRecommend,
  shouldFallbackToLeader,
  withRateLimitBackoff,
} from "../discovery-recommender.js";

function makeLeader(seq: Array<string | Error>) {
  const q = [...seq];
  return {
    generate: vi.fn(async () => {
      const n = q.shift();
      if (n instanceof Error) throw n;
      return { content: n ?? "", costUsd: 0.01 };
    }),
  };
}

describe("discovery-recommender — leader", () => {
  it("returns parsed recommendation with primary + alternatives", async () => {
    const leader = makeLeader([
      JSON.stringify({
        primary: { value: "saas", rationale: "fits idea" },
        alternatives: [
          { value: "internal-tool", rationale: "alt 1" },
          { value: "consumer-app", rationale: "alt 2" },
        ],
      }),
    ]);
    const rec = await leaderRecommend(
      {
        question: { id: "productType", required: true, recommendMode: "leader", prompt: "?" } as any,
        context: {},
        detection: {
          isGitRepo: false,
          hasCommitHistory: false,
          srcFileCount: 0,
          manifests: [],
          languages: [],
          frameworks: [],
          classification: "greenfield",
        },
      },
      leader as any,
    );
    expect(rec.primary.value).toBe("saas");
    expect(rec.alternatives.length).toBe(2);
    expect(rec.source).toBe("leader");
    expect(rec.costUsd).toBeGreaterThan(0);
  });

  it("retries once on malformed JSON", async () => {
    const leader = makeLeader([
      "bad",
      JSON.stringify({ primary: { value: "saas", rationale: "x" }, alternatives: [] }),
    ]);
    const rec = await leaderRecommend(
      {
        question: { id: "productType", required: true, recommendMode: "leader", prompt: "?" } as any,
        context: {},
        detection: {} as any,
      },
      leader as any,
    );
    expect(rec.primary.value).toBe("saas");
    expect(leader.generate).toHaveBeenCalledTimes(2);
  });

  it("falls back to user-only after two failures", async () => {
    const leader = makeLeader(["bad", "bad"]);
    const rec = await leaderRecommend(
      {
        question: { id: "productType", required: true, recommendMode: "leader", prompt: "?" } as any,
        context: {},
        detection: {} as any,
      },
      leader as any,
    );
    expect(rec.source).toBe("user-only");
  });
});

describe("discovery-recommender — council", () => {
  it("synthesizes recommendation from chunks where 2-of-3 stances agree", async () => {
    const fakeDebate = {
      async *runDebate() {
        yield { type: "stance", name: "pragmatist", value: "monolith", rationale: "simple" };
        yield { type: "stance", name: "scaler", value: "monolith", rationale: "ok for scale" };
        yield { type: "stance", name: "cost-optimizer", value: "microservices", rationale: "isolate" };
        yield { type: "cost", costUsd: 0.3 };
      },
    };
    const leader = makeLeader([]);
    const rec = await councilRecommend(
      {
        question: { id: "backendArchitecture", required: true, recommendMode: "council", prompt: "?" } as any,
        context: {},
        detection: { classification: "greenfield" } as any,
      },
      leader as any,
      fakeDebate as any,
    );
    expect(rec.primary.value).toBe("monolith");
    expect(rec.alternatives.length).toBe(1);
    expect(rec.source).toBe("council");
    expect(rec.tiebreakUsed).toBe(false);
    expect(rec.costUsd).toBeCloseTo(0.3, 2);
  });

  it("invokes synth tiebreak when all three stances differ", async () => {
    const fakeDebate = {
      async *runDebate() {
        yield { type: "stance", name: "pragmatist", value: "monolith", rationale: "simple" };
        yield { type: "stance", name: "scaler", value: "microservices", rationale: "scale" };
        yield { type: "stance", name: "cost-optimizer", value: "serverless", rationale: "cheap" };
        yield { type: "cost", costUsd: 0.3 };
      },
    };
    const leader = makeLeader([
      JSON.stringify({
        primary: { value: "monolith", rationale: "synth: best fit" },
        alternatives: [
          { value: "microservices", rationale: "alt" },
          { value: "serverless", rationale: "alt" },
        ],
      }),
    ]);
    const rec = await councilRecommend(
      {
        question: { id: "backendArchitecture", required: true, recommendMode: "council", prompt: "?" } as any,
        context: {},
        detection: { classification: "greenfield" } as any,
      },
      leader as any,
      fakeDebate as any,
    );
    expect(rec.tiebreakUsed).toBe(true);
    expect(rec.primary.value).toBe("monolith");
    expect(rec.synthFailed).toBeFalsy();
  });

  it("falls back to highest-confidence when synth fails", async () => {
    const fakeDebate = {
      async *runDebate() {
        yield { type: "stance", name: "pragmatist", value: "monolith", rationale: "simple", confidence: 0.7 };
        yield { type: "stance", name: "scaler", value: "microservices", rationale: "scale", confidence: 0.4 };
        yield { type: "stance", name: "cost-optimizer", value: "serverless", rationale: "cheap", confidence: 0.5 };
        yield { type: "cost", costUsd: 0.3 };
      },
    };
    const leader = makeLeader(["bad json", "still bad"]);
    const rec = await councilRecommend(
      {
        question: { id: "backendArchitecture", required: true, recommendMode: "council", prompt: "?" } as any,
        context: {},
        detection: { classification: "greenfield" } as any,
      },
      leader as any,
      fakeDebate as any,
    );
    expect(rec.tiebreakUsed).toBe(true);
    expect(rec.synthFailed).toBe(true);
    expect(rec.primary.value).toBe("monolith"); // highest confidence
  });

  it("falls back to leader when council throws", async () => {
    const fakeDebate = {
      // biome-ignore lint/correctness/useYield: test stub — always throws, never yields
      async *runDebate() {
        throw new Error("council unavailable");
      },
    };
    const leader = makeLeader([
      JSON.stringify({ primary: { value: "monolith", rationale: "leader fallback" }, alternatives: [] }),
    ]);
    const rec = await councilRecommend(
      {
        question: { id: "backendArchitecture", required: true, recommendMode: "council", prompt: "?" } as any,
        context: {},
        detection: { classification: "greenfield" } as any,
      },
      leader as any,
      fakeDebate as any,
    );
    expect(rec.source).toBe("leader");
    expect(rec.primary.value).toBe("monolith");
  });
});

describe("discovery-recommender — cost guard + 429", () => {
  it("guard = max($2.50, 0.15 * capUsd)", () => {
    expect(computeCostGuard(0)).toBe(2.5);
    expect(computeCostGuard(10)).toBe(2.5);
    expect(computeCostGuard(20)).toBe(3.0);
    expect(computeCostGuard(50)).toBe(7.5);
  });

  it("shouldFallbackToLeader trips when cumulative + estimate exceeds guard", () => {
    expect(shouldFallbackToLeader({ cumulative: 0, capUsd: 50 })).toBe(false);
    expect(shouldFallbackToLeader({ cumulative: 7.2, capUsd: 50 })).toBe(true); // 7.20 + 0.45 > 7.50
    expect(shouldFallbackToLeader({ cumulative: 2.1, capUsd: 10 })).toBe(true); // 2.10 + 0.45 > 2.50
  });

  it("withRateLimitBackoff retries 429 and succeeds on third attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("rate"), { status: 429 }))
      .mockResolvedValueOnce("ok");
    const result = await withRateLimitBackoff(fn, { delays: [1] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("withRateLimitBackoff gives up after maxRetries attempts", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("rate"), { status: 429 }));
    await expect(withRateLimitBackoff(fn, { delays: [1] })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3); // maxRetries=3 total attempts
  });

  it("withRateLimitBackoff does not retry non-429 errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network"));
    await expect(withRateLimitBackoff(fn, { delays: [1] })).rejects.toThrow("network");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

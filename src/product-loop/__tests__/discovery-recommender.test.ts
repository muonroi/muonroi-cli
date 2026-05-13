// src/product-loop/__tests__/discovery-recommender.test.ts
import { describe, expect, it, vi } from "vitest";
import { leaderRecommend } from "../discovery-recommender.js";

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

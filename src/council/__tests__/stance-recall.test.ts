import { describe, expect, it, vi } from "vitest";
import type { EERecallResponse } from "../../ee/types.js";
import { makeStanceRecall, type StanceRecallClient } from "../stance-recall.js";

function resp(text: string | null): EERecallResponse {
  return { text, entries: [], count: 0 };
}

describe("makeStanceRecall", () => {
  it("returns undefined when no client is provided", () => {
    expect(makeStanceRecall(null)).toBeUndefined();
    expect(makeStanceRecall(undefined)).toBeUndefined();
  });

  it("fires one recall per unique role, forwarding the role as stance", async () => {
    const recall = vi.fn(async (_q: string, o?: { stance?: string }) => resp(`seed:${o?.stance}`));
    const fn = makeStanceRecall({ recall } as StanceRecallClient)!;
    const seeds = await fn(["research", "implement", "research"], "build a todo app");
    // "research" deduped → 2 calls, not 3.
    expect(recall).toHaveBeenCalledTimes(2);
    expect(seeds.get("research")).toBe("seed:research");
    expect(seeds.get("implement")).toBe("seed:implement");
    const stancesSent = recall.mock.calls.map((c) => c[1]?.stance).sort();
    expect(stancesSent).toEqual(["implement", "research"]);
  });

  it("omits roles whose recall returns null/empty text", async () => {
    const recall = vi.fn(async (_q: string, o?: { stance?: string }) =>
      o?.stance === "verify" ? resp(null) : resp("  ok  "),
    );
    const fn = makeStanceRecall({ recall } as StanceRecallClient)!;
    const seeds = await fn(["research", "verify"], "q");
    expect(seeds.get("research")).toBe("ok");
    expect(seeds.has("verify")).toBe(false);
  });

  it("never throws when a recall rejects — that role is just skipped", async () => {
    const recall = vi.fn(async (_q: string, o?: { stance?: string }) => {
      if (o?.stance === "boom") throw new Error("network");
      return resp("fine");
    });
    const fn = makeStanceRecall({ recall } as StanceRecallClient)!;
    const seeds = await fn(["boom", "research"], "q");
    expect(seeds.has("boom")).toBe(false);
    expect(seeds.get("research")).toBe("fine");
  });

  it("returns an empty map for a blank query or no roles (no calls)", async () => {
    const recall = vi.fn(async () => resp("x"));
    const fn = makeStanceRecall({ recall } as StanceRecallClient)!;
    expect((await fn(["research"], "   ")).size).toBe(0);
    expect((await fn([], "q")).size).toBe(0);
    expect(recall).not.toHaveBeenCalled();
  });

  it("caps seed text to maxSeedChars", async () => {
    const recall = vi.fn(async () => resp("x".repeat(5000)));
    const fn = makeStanceRecall({ recall } as StanceRecallClient, { maxSeedChars: 100 })!;
    const seeds = await fn(["research"], "q");
    expect(seeds.get("research")!.length).toBe(100);
  });
});

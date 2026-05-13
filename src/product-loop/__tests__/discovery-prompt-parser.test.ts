// src/product-loop/__tests__/discovery-prompt-parser.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePromptForContext } from "../discovery-prompt-parser.js";

interface FakeLeader {
  generate: ReturnType<typeof vi.fn>;
}

function makeLeader(responseSeq: Array<string | Error>): FakeLeader {
  const queue = [...responseSeq];
  return {
    generate: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { content: next ?? "", costUsd: 0.01 };
    }),
  };
}

describe("discovery-prompt-parser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty partial on empty idea", async () => {
    const leader = makeLeader([]);
    const { partial, costUsd } = await parsePromptForContext("", leader as any);
    expect(partial).toEqual({});
    expect(costUsd).toBe(0);
    expect(leader.generate).not.toHaveBeenCalled();
  });

  it("parses well-formed JSON from leader response", async () => {
    const leader = makeLeader([JSON.stringify({ productType: "saas", targetPlatform: ["web"] })]);
    const { partial } = await parsePromptForContext("Build a SaaS dashboard", leader as any);
    expect(partial.productType).toBe("saas");
    expect(partial.targetPlatform).toEqual(["web"]);
  });

  it("strips code fences from response", async () => {
    const leader = makeLeader(['```json\n{"productType":"saas"}\n```']);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect(partial.productType).toBe("saas");
  });

  it("retries once on malformed JSON then succeeds", async () => {
    const leader = makeLeader(["not json", JSON.stringify({ productType: "saas" })]);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect(partial.productType).toBe("saas");
    expect(leader.generate).toHaveBeenCalledTimes(2);
  });

  it("falls back to empty partial after second malformed response", async () => {
    const leader = makeLeader(["not json", "still not json"]);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect(partial).toEqual({});
  });

  it("returns empty partial on timeout", async () => {
    const leader = makeLeader([new Error("timeout")]);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect(partial).toEqual({});
  });

  it("strips unknown fields silently", async () => {
    const leader = makeLeader([JSON.stringify({ productType: "saas", unknownField: "x" })]);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect((partial as any).unknownField).toBeUndefined();
    expect(partial.productType).toBe("saas");
  });

  it("ignores invalid enum values for known fields", async () => {
    const leader = makeLeader([JSON.stringify({ productType: "nonsense" })]);
    const { partial } = await parsePromptForContext("idea", leader as any);
    expect(partial.productType).toBeUndefined();
  });
});

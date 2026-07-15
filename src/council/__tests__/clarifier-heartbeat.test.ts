import { describe, expect, it } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { researchScopeForClarification } from "../clarifier.js";

describe("researchScopeForClarification heartbeat", () => {
  it("emits council_status ticks while llm.research is in flight", async () => {
    // llm.research resolves after ~2.5 ticks (tickInterval 1000ms) so at least
    // one "tick" council_status must be yielded before it returns.
    const llm = {
      research: () => new Promise<string>((r) => setTimeout(() => r("brief text"), 2500)),
    } as unknown as Parameters<typeof researchScopeForClarification>[3];

    const chunks: StreamChunk[] = [];
    // Real signature (clarifier.ts:301): (topic, conversationContext,
    // leaderModelId, llm, signal, reachableModels).
    const gen = researchScopeForClarification("narrow this scope", "", "test-leader-model", llm, undefined, []);
    for await (const c of gen) {
      chunks.push(c);
    }

    const statuses = chunks.filter((c) => c.type === "council_status");
    expect(statuses.some((c) => (c as { councilStatus?: { state?: string } }).councilStatus?.state === "tick")).toBe(
      true,
    );
  }, 10_000);
});

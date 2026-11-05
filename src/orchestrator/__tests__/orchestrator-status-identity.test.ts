import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog, MODELS } from "../../models/registry.js";
import { __resetStatusBarStoreForTests, statusBarStore } from "../../state/status-bar-store.js";
import { recordUsageEvent } from "../../storage/index.js";
import { appendCostLog } from "../../usage/cost-log.js";
import { selectOrchestratorModel } from "../orchestration-policy.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../storage/index.js", async (original) => ({ ...(await original<object>()), recordUsageEvent: vi.fn() }));
vi.mock("../../usage/cost-log.js", async (original) => ({
  ...(await original<object>()),
  appendCostLog: vi.fn(async () => undefined),
}));

const record = Agent.prototype as unknown as {
  recordUsage: (
    usage: { inputTokens: number; outputTokens: number },
    source: "message" | "compaction" | "task" | "title",
    model: string,
  ) => void;
};
let helper: (typeof MODELS)[number];
let leader: (typeof MODELS)[number];
beforeAll(async () => {
  await loadCatalog();
  helper = MODELS.find(
    (m) => m.tier === "fast" && m.provider && MODELS.some((p) => p.provider === m.provider && p.tier === "premium"),
  )!;
  expect(helper).toBeDefined();
  leader = selectOrchestratorModel(helper.provider!, MODELS, () => false);
});
beforeEach(() => {
  vi.clearAllMocks();
  __resetStatusBarStoreForTests();
});

describe("orchestrator status identity and usage attribution", () => {
  it.each([
    "compaction",
    "task",
    "title",
  ] as const)("%s usage retains the leader label and bills the helper model", (source) => {
    const owner = {
      executionRole: "orchestrator",
      modelId: leader.id,
      providerId: leader.provider,
      session: { id: "fixture-owner" },
      messageSeqs: [],
    };
    statusBarStore.setState({ provider: leader.provider, model: leader.id });
    record.recordUsage.call(owner, { inputTokens: 100, outputTokens: 10 }, source, helper.id);
    expect(statusBarStore.getState()).toMatchObject({
      provider: leader.provider,
      model: leader.id,
      in_tokens: 100,
      out_tokens: 10,
    });
    expect(recordUsageEvent).toHaveBeenCalledWith(
      "fixture-owner",
      source,
      helper.id,
      expect.any(Object),
      null,
      false,
      0,
      undefined,
    );
    if (source === "compaction") {
      // compactForContext writes the one authoritative cost-log row per
      // compaction; a second row from recordUsage double-counted every
      // compaction (186 rows for 93 compactions, 2026-11-02..04).
      expect(appendCostLog).not.toHaveBeenCalled();
    } else {
      expect(appendCostLog).toHaveBeenCalledWith(
        expect.objectContaining({ model: helper.id, callsite: `orchestrator.${source}` }),
      );
    }
  });

  it("reflects an explicitly changed leader on the next usage update", () => {
    const owner = { executionRole: "orchestrator", modelId: helper.id, providerId: helper.provider, session: null };
    statusBarStore.setState({ provider: leader.provider, model: leader.id });
    record.recordUsage.call(owner, { inputTokens: 100, outputTokens: 10 }, "message", helper.id);
    expect(statusBarStore.getState().model).toBe(helper.id);
  });

  it("preserves the actual call model for non-orchestrator execution", () => {
    const owner = { executionRole: "worker", modelId: leader.id, providerId: leader.provider, session: null };
    record.recordUsage.call(owner, { inputTokens: 100, outputTokens: 10 }, "task", helper.id);
    expect(statusBarStore.getState().model).toBe(helper.id);
  });
});

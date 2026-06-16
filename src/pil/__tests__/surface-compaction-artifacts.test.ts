import { beforeEach, describe, expect, test, vi } from "vitest";
import { surfaceCompactionArtifacts } from "../layer3-ee-injection";
import type { PipelineContext } from "../types";

// Issue #4 — on a meta-analysis turn the full Layer 3 is skipped, so the agent
// would otherwise have to guess an artifact exists and hand-call ee_query. This
// arm auto-surfaces the elided high-value tool-artifacts into the enriched
// prompt. Mock the EE search + the audit log so the test stays offline.
vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../storage/interaction-log.js", () => ({
  logInteraction: vi.fn(),
}));

import { searchByText } from "../../ee/bridge.js";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    raw: "compaction cần cải thiện gì trong CLI",
    enriched: "compaction cần cải thiện gì trong CLI",
    taskType: "general",
    domain: null,
    confidence: 0.85,
    outputStyle: "balanced",
    tokenBudget: 2000,
    metrics: null,
    layers: [],
    sessionId: "sess-meta-1",
    ...overrides,
  } as PipelineContext;
}

const artifactPoint = {
  id: "art1",
  score: 0.9,
  payload: {
    text: "tool-artifact id=call_7 toolName=read_file elided 4200 chars: src/orchestrator/compaction.ts createCompactionSummaryMessage ...",
  },
  collection: "experience-behavioral",
};
const checkpointPoint = {
  id: "cp1",
  score: 0.8,
  payload: { text: "Context checkpoint summary ✔ DONE: extended IMPORTANT_TOOL_NAMES; tests 16/16" },
  collection: "experience-behavioral",
};
const genericPoint = {
  id: "gen1",
  score: 0.97,
  payload: { text: "Always run the full test suite before pushing" },
  collection: "experience-behavioral",
};

describe("surfaceCompactionArtifacts (issue #4 — meta-turn auto-surface)", () => {
  beforeEach(() => {
    vi.mocked(searchByText).mockReset();
    vi.mocked(searchByText).mockResolvedValue([]);
  });

  test("auto-surfaces [artifact] + checkpoint refs (and the rehydrate instruction) into enriched", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape mirrors EEPoint
    vi.mocked(searchByText).mockResolvedValue([artifactPoint, checkpointPoint] as any);
    const ctx = makeCtx();
    const out = await surfaceCompactionArtifacts(ctx);

    expect(out.enriched).toContain("[artifact]"); // artifact-typed line
    expect(out.enriched).toContain("ee.query tool"); // how to rehydrate the full output
    expect(out.enriched).toContain("call_7"); // the concrete tool-artifact id the agent can fetch
    const layer = out.layers.find((l) => l.name === "ee-meta-artifacts");
    expect(layer?.applied).toBe(true);
    expect(layer?.delta).toContain("artifacts=2");
    // Searches only the behavioral collection (where tool-artifacts are persisted).
    expect(vi.mocked(searchByText)).toHaveBeenCalledWith(
      expect.stringContaining("tool-artifact"),
      ["experience-behavioral"],
      expect.any(Number),
      expect.any(Object),
    );
  });

  test("no sessionId → unchanged, no EE call (no prior compaction to rehydrate)", async () => {
    const ctx = makeCtx({ sessionId: undefined });
    const out = await surfaceCompactionArtifacts(ctx);
    expect(out.enriched).toBe(ctx.enriched);
    expect(out.layers.find((l) => l.name === "ee-meta-artifacts")?.delta).toBe("no-session");
    expect(vi.mocked(searchByText)).not.toHaveBeenCalled();
  });

  test("search failure is fail-open + recorded (delta=error=…, enriched unchanged)", async () => {
    vi.mocked(searchByText).mockRejectedValue(new Error("EE down"));
    const ctx = makeCtx();
    const out = await surfaceCompactionArtifacts(ctx);
    expect(out.enriched).toBe(ctx.enriched);
    expect(out.layers.find((l) => l.name === "ee-meta-artifacts")?.delta).toMatch(/^error=/);
  });

  test("generic behavioral hits are filtered out (not mislabelled as artifacts)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape mirrors EEPoint
    vi.mocked(searchByText).mockResolvedValue([genericPoint] as any);
    const ctx = makeCtx();
    const out = await surfaceCompactionArtifacts(ctx);
    expect(out.enriched).toBe(ctx.enriched);
    expect(out.layers.find((l) => l.name === "ee-meta-artifacts")?.delta).toBe("no-artifacts");
  });

  test("idempotent — a second pass on the already-injected context does not re-inject", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test fixture shape mirrors EEPoint
    vi.mocked(searchByText).mockResolvedValue([artifactPoint] as any);
    const first = await surfaceCompactionArtifacts(makeCtx());
    expect(first.enriched).toContain("[artifact]");

    // Feed the enriched (now carrying the ee-checkpoint marker) back in.
    const second = await surfaceCompactionArtifacts(makeCtx({ enriched: first.enriched }));
    expect(second.layers.find((l) => l.name === "ee-meta-artifacts")?.delta).toBe("already-injected");
    expect(second.enriched).toBe(first.enriched); // not grown a second time
  });
});

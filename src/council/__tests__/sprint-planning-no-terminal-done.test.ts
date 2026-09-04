/**
 * sprint-planning-no-terminal-done.test.ts — P0-1.
 *
 * `{type:"done"}` is the TURN terminator: the TUI ends its `for await` over a
 * run the moment it sees one (`use-app-logic.tsx`: `if (chunk.type === "done")
 * break;`). Under `sprintPlanningMode` this council is a SUB-STEP of `/ideal`'s
 * sprint runner, not a turn — index.ts already gated the RUN-END `done` on that
 * flag ("runSprint, not a standalone turn"), but the eight EARLY-BAIL sites
 * still emitted one.
 *
 * Live consequence (2026-09-04, run mtmkya3uaf85): sprint 1 planning bailed at
 * the `participants.length < 2` guard, the `done` propagated up through
 * sprint-runner → loop-driver → runProductLoopV1 into the TUI, and the whole
 * `/ideal` run was torn down with no halt card, no error and no terminal event.
 *
 * This pins the smallest reachable bail (fewest participants) in both
 * directions: suppressed as a sub-step, still emitted for a standalone council.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../storage/index", () => ({
  appendSystemMessage: vi.fn(),
  appendMessages: vi.fn(),
  loadTranscript: vi.fn().mockReturnValue([]),
  logInteraction: vi.fn(),
}));
vi.mock("../leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn().mockResolvedValue({ modelId: "mock-leader", promotedFrom: null }),
  // Fewer than 2 reachable participants — the "No reachable provider" bail.
  resolveParticipants: vi.fn().mockResolvedValue([]),
  buildCouncilCandidatePool: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../utils/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/settings.js")>();
  return {
    ...actual,
    isCouncilMultiProviderPreferred: vi.fn().mockReturnValue(false),
    loadMcpServers: vi.fn().mockReturnValue([]),
  };
});

const noopLlm = {
  generate: vi.fn(async () => ""),
  research: vi.fn(async () => ""),
  debate: vi.fn(async () => ({ text: "", toolCalls: [] })),
};

// biome-ignore lint/correctness/useYield: stub host orchestrator, never invoked on the bail path
async function* noopProcess(): AsyncGenerator<never, void, unknown> {}

async function drain(gen: AsyncGenerator<unknown, unknown, unknown>) {
  const chunks: Array<Record<string, unknown>> = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value as Record<string, unknown>);
    step = await gen.next();
  }
  return { chunks, ret: step.value };
}

async function runBail(options: Record<string, unknown>) {
  const { runCouncil } = await import("../index.js");
  return drain(
    runCouncil(
      "topic",
      "mock-model",
      [],
      "sess-bail",
      noopLlm as never,
      vi.fn(async () => ""),
      vi.fn(async () => true),
      noopProcess as never,
      options as never,
    ) as AsyncGenerator<unknown, unknown, unknown>,
  );
}

describe("runCouncil early bail — turn terminator scoping", () => {
  it("sprintPlanningMode: emits the diagnosis but NOT the {type:'done'} turn terminator", async () => {
    const { chunks, ret } = await runBail({ sprintPlanningMode: true, skipClarification: true });

    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    expect(chunks.some((c) => c.type === "content" && String(c.content ?? "").includes("No reachable provider"))).toBe(
      true,
    );
    // Bail still reports itself to the caller as "no synthesis".
    expect(ret).toBeNull();
  });

  it("standalone council: still emits {type:'done'} (no over-suppression)", async () => {
    const { chunks, ret } = await runBail({ skipClarification: true });

    expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
    expect(ret).toBeNull();
  });
});

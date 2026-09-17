/**
 * sprint-plan-bail-reason-message.test.ts
 *
 * MEASURED FAILURE (session 1f9f57415170, run mu3ks8zwe8d5): the sprint-1
 * planning council debated fine, synthesis ran FOUR times (initial + compact
 * retry, twice — once for the debate outcome, once for the sprintPlanningMode
 * plan-lock re-synthesis) and returned an empty string every time. The single
 * message sprint-runner.ts emitted for every `runCouncil` bail —
 *
 *   "Sprint N planning council produced no plan (council bailed before
 *    synthesis — check provider reachability and API keys for the planning
 *    model)"
 *
 * — is false for what happened: synthesis ran, was billed 17 times, and the
 * fault (an empty completion from a reasoning leader) has nothing to do with
 * provider reachability or API keys. Only the "fewer than 2 reachable
 * participants" bail actually warrants that advice.
 *
 * `runCouncil`'s early-bail paths and its final `return synthesisText || null`
 * now record WHY on the `councilStats.bailReason` side-channel (passed by
 * reference via `options.councilStats`, since the generator's return value
 * collapses every bail to a bare `null`). These tests exercise sprint-runner's
 * message construction against a mocked `runCouncil` that sets `bailReason`
 * exactly like the real one would, for each of the three bail kinds reachable
 * from an automated `sprintPlanningMode` run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BailReason = { kind: string; detail: string } | undefined;
const councilBehaviour: { bail: BailReason } = { bail: undefined };

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn((...args: unknown[]) => {
    // `options` (with `councilStats`, when the caller threads it) is the last
    // positional argument to the real `runCouncil`.
    const options = args[args.length - 1] as { councilStats?: { bailReason?: BailReason } } | undefined;
    return (async function* () {
      if (options?.councilStats && councilBehaviour.bail) {
        options.councilStats.bailReason = councilBehaviour.bail;
      }
      yield { type: "content", content: "planning…" };
      // Every scenario exercised here IS a bail — a genuinely empty synthesis
      // collapses to null exactly like the early-bail paths do.
      return null;
    })();
  }),
}));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false, reason: "" })),
}));
vi.mock("../artifact-io.js", () => ({
  appendIteration: vi.fn(),
  readCriteria: vi.fn(async () => []),
}));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  recordProductSpend: vi.fn(async () => undefined),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => ({
    idea: "greenfield idea",
    detection: { classification: "greenfield" },
    context: {},
  })),
}));

import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let testFlowDir = "";
beforeEach(() => {
  testFlowDir = mkdtempSync(join(tmpdir(), "sprint-plan-bail-reason-"));
  vi.clearAllMocks();
  councilBehaviour.bail = undefined;
});
afterEach(() => {
  rmSync(testFlowDir, { recursive: true, force: true });
});

function makeSpec(): ProductSpec {
  return {
    idea: "greenfield idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  } as ProductSpec;
}

function makeCtx(): unknown {
  return {
    runId: "run-plan-bail-reason",
    flowDir: testFlowDir,
    cwd: testFlowDir,
    idea: "greenfield idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "impl" };
    }),
    detectVerifyRecipe: async () => null,
  };
}

/** Drain until return or throw; reports both the chunks and the outcome. */
async function drain(
  gen: AsyncGenerator<unknown, unknown, unknown>,
): Promise<{ chunks: Array<Record<string, unknown>>; error?: Error }> {
  const chunks: Array<Record<string, unknown>> = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks };
      chunks.push(value as Record<string, unknown>);
    }
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

async function runOnce(): Promise<Error | undefined> {
  const { error } = await drain(
    runSprint({
      sprintN: 1,
      ctx: makeCtx() as never,
      productSpec: makeSpec(),
      roleAssignments: NO_ROLES,
      history: [],
    }) as never,
  );
  return error;
}

describe("sprint-runner — honest planning-bail message per bail kind", () => {
  it("no-reachable-participants bail keeps the provider/keys advice (this one is actually true)", async () => {
    councilBehaviour.bail = {
      kind: "no-reachable-participants",
      detail: "Fewer than 2 reachable council participants — check API keys in user-settings.json or environment.",
    };
    const error = await runOnce();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/planning council produced no plan/i);
    expect(error?.message ?? "").toMatch(/api keys?/i);
    expect(error?.message ?? "").toMatch(/provider/i);
  });

  it("empty-synthesis bail does NOT claim the council bailed before synthesis or point at API keys", async () => {
    councilBehaviour.bail = {
      kind: "empty-synthesis",
      detail:
        "Synthesizer returned empty completion on both attempts. Provider may be rate-limited, or the leader " +
        "is a reasoning model spending its whole output budget on thinking tokens — the debate exchanges above " +
        "are still usable as raw notes.",
    };
    const error = await runOnce();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/planning council produced no plan/i);
    // Both clauses of the old blanket message are false for this bail kind.
    expect(error?.message ?? "").not.toMatch(/bailed before synthesis/i);
    expect(error?.message ?? "").not.toMatch(/api key/i);
    // ... and it DOES say what actually happened.
    expect(error?.message ?? "").toContain("Synthesizer returned empty completion on both attempts");
  });

  it("no-openings bail says every panelist failed to open — the one case where 'bailed before synthesis' is true", async () => {
    councilBehaviour.bail = {
      kind: "no-openings",
      detail: "Every panelist failed to produce an opening statement after 2 attempts.",
    };
    const error = await runOnce();
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/planning council produced no plan/i);
    expect(error?.message ?? "").toContain("Every panelist failed to produce an opening statement");
  });
});

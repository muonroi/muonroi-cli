/**
 * P1.3 wiring tests: assert that extractRunToEE is called at the shipped
 * terminus (drainSprints) and the abort path (runAbort), and that a failing
 * EE client does not prevent the shipped result from being returned.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Static mocks (must precede dynamic imports) ───────────────────────────────

vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(async function* () {
    yield { type: "content", content: "[gather→scoping]" };
    return { runId: "ignored", stage: "approved", success: true };
  }),
}));

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));

vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

// ship-polish must not throw so it doesn't mask the EE call
vi.mock("../ship-polish.js", () => ({
  polishDelivery: vi.fn().mockResolvedValue({ notes: [] }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { setDefaultEEClient } from "../../ee/intercept.js";
import { writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ee-wire-"));
}

function makeOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionModelId: "claude-sonnet-4-6",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    ...overrides,
  };
}

function makeStubClient(returnValue: { ok: boolean; mistakes?: number; stored?: number } | null) {
  return {
    extract: vi.fn().mockResolvedValue(returnValue),
    intercept: vi.fn(),
    promptStale: vi.fn(),
    stats: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    searchPoints: vi.fn(),
  } as unknown as ReturnType<typeof import("../../ee/client.js").createEEClient>;
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

const shippedIter = (): IterationState => ({
  sprintN: 1,
  stage: "shipped",
  scoreBefore: 0,
  scoreAfter: 1.0,
  criteriaMet: 3,
  criteriaPartial: 0,
  criteriaUnmet: 0,
  costUsd: 0.1,
  lastVerifyResult: "PASS",
  actualCost: 0.1,
  score: 1.0,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P1.3 — EE extract wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force legacy sprint path so we don't need the full phase-orchestrator
    // stack (projectContext, phase plans, etc.) in these unit tests.
    process.env.MUONROI_PHASE_MODE = "0";
  });

  afterEach(async () => {
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("shipped path: extract is called once with scope=ideal:<runId>", async () => {
    const flowDir = await tmpFlowDir();
    const stub = makeStubClient({ ok: true, mistakes: 1, stored: 2 });
    setDefaultEEClient(stub);

    // runSprint returns shipped on first call
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const opts = makeOpts({ flowDir, idea: "build a thing", cwd: flowDir });
    const { result } = await drain(runProductLoop(opts as any));

    // run returned success
    expect(result.success).toBe(true);
    expect(result.shipped).toBe(true);

    // extract was called exactly once
    expect(stub.extract).toHaveBeenCalledOnce();
    const callArg = vi.mocked(stub.extract).mock.calls[0][0];
    expect(callArg.meta?.source).toBe("cli-exit");
    expect(callArg.meta?.scope).toBe(`ideal:${result.runId}`);
    expect(callArg.projectPath).toBe(flowDir);
  });

  it("shipped path: EE failure is non-fatal — result.success still true", async () => {
    const flowDir = await tmpFlowDir();
    const nullStub = makeStubClient(null); // EE returns null (offline/unreachable)
    setDefaultEEClient(nullStub);

    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as any).mockImplementationOnce(async function* () {
      return shippedIter();
    });

    const opts = makeOpts({ flowDir, idea: "build another thing", cwd: flowDir });
    const { result } = await drain(runProductLoop(opts as any));

    // Even though EE returned null, the run still ships
    expect(result.success).toBe(true);
    expect(result.shipped).toBe(true);
    expect(nullStub.extract).toHaveBeenCalledOnce();
  });

  it("abort path: extract is called with scope=ideal:<runId>", async () => {
    const flowDir = await tmpFlowDir();
    const runId = "abort-test-run";

    // Create a proper manifest so runAbort can read it via readManifest.
    await writeManifest(flowDir, runId, {
      idea: "abort test idea",
      capUsd: 50,
      maxSprints: 3,
      doneThreshold: 0.9,
      createdAt: new Date(),
    });

    // Also seed manifest.md content (already done above via writeManifest, but
    // we also want a transcript file so extractRunToEE doesn't skip the call).
    const runDir = path.join(flowDir, "runs", runId);
    await fs.writeFile(path.join(runDir, "roadmap.md"), "# roadmap content", "utf8");

    const stub = makeStubClient({ ok: true });
    setDefaultEEClient(stub);

    const abortOpts = makeOpts({ flowDir, runId, subcommand: "abort", cwd: flowDir });
    const { result } = await drain(runProductLoop(abortOpts as any));

    expect(result.runId).toBe(runId);
    expect(result.reason).toBe("aborted");

    // extract was called for the abort path
    expect(stub.extract).toHaveBeenCalledOnce();
    const callArg = vi.mocked(stub.extract).mock.calls[0][0];
    expect(callArg.meta?.scope).toBe(`ideal:${runId}`);
  });
});

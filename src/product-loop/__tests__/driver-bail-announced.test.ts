/**
 * `runProductLoop` must never swallow a non-approved loop-driver outcome.
 *
 * `runLoopDriver` signals every non-approved terminal state by RETURNING a
 * `DriverResult` rather than throwing, so the `catch` arms in `index.ts` never
 * see one. Both call sites used to do a bare `return { ...driverResult }`,
 * yielding nothing — the orchestrator's `for await` ended normally and the TUI
 * received no error chunk, no toast and no terminal event.
 *
 * Measured on run `mtmrm9c667d4` (2026-09-04): scoping returned
 * `failed_to_synthesize_spec` after a truncated synthesis completion, and the
 * session emitted zero further chunks, events or LLM calls for 32 minutes while
 * `loop:scoping` still showed as active. Indistinguishable from a hang.
 *
 * Every bail — error or halt, from any stage, for any reason — must announce
 * itself on the stream.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(),
}));
vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));
vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));

import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";
import type { DriverResult } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

function makeOpts(overrides: Record<string, unknown> = {}): any {
  return {
    sessionModelId: getTestModels().balanced,
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    // forceCouncil keeps the dispatcher on runStart (the loop-driver path).
    // Without it a low-complexity idea routes to runHotPath, which never calls
    // runLoopDriver at all.
    flags: { maxCost: 50, maxSprints: 3, doneThreshold: 0.9, forceCouncil: true },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    ...overrides,
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

function stubDriver(result: DriverResult): void {
  // biome-ignore lint/correctness/useYield: intentional mock generator
  (runLoopDriver as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
    return result;
  });
}

/** Text of any chunk that carries user-visible content. */
function visibleText(chunks: any[]): string {
  return chunks
    .filter((c) => c && (c.type === "content" || c.type === "error"))
    .map((c) => String(c.content ?? ""))
    .join("\n");
}

describe("runProductLoop announces every non-approved driver outcome", () => {
  let flowDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MUONROI_PHASE_MODE = "0";
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "ideal-bail-"));
  });

  it("yields an error chunk when scoping returns failed_to_synthesize_spec", async () => {
    stubDriver({
      runId: "ignored",
      stage: "error",
      success: false,
      reason: "failed_to_synthesize_spec",
      detail: "Spec synthesis produced no parseable ProductSpec after 2 attempts (cut off).",
    });

    const { chunks, result } = await drain(runProductLoop(makeOpts({ flowDir, idea: "slugify accents" })));

    expect(result.success).toBe(false);
    expect(result.stage).toBe("error");
    expect(result.reason).toBe("failed_to_synthesize_spec");

    // The regression: this list was empty, so the turn ended in silence.
    const errorChunks = chunks.filter((c: any) => c.type === "error");
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect(visibleText(chunks)).toContain("Spec synthesis produced no parseable ProductSpec");
    expect(visibleText(chunks)).toContain("stopped before sprints");

    // It bailed before sprints — the announcement is the ONLY terminal signal.
    expect(runSprint).not.toHaveBeenCalled();
  });

  it("falls back to the machine reason when the driver supplies no detail", async () => {
    stubDriver({ runId: "ignored", stage: "error", success: false, reason: "missing_state_for_scoping" });

    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, idea: "anything" })));

    expect(chunks.filter((c: any) => c.type === "error").length).toBeGreaterThanOrEqual(1);
    expect(visibleText(chunks)).toContain("missing_state_for_scoping");
  });

  it("announces a halt as well as an error", async () => {
    stubDriver({ runId: "ignored", stage: "halted", success: false, reason: "user_rejected_spec" });

    const { chunks, result } = await drain(runProductLoop(makeOpts({ flowDir, idea: "anything" })));

    expect(result.stage).toBe("halted");
    expect(visibleText(chunks)).toContain("user_rejected_spec");
    expect(visibleText(chunks)).toContain("stopped before sprints");
  });

  it("does not announce anything on the approved path", async () => {
    stubDriver({ runId: "ignored", stage: "approved", success: true });
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      // biome-ignore lint/correctness/useYield: intentional mock generator
      async function* () {
        return {
          sprintN: 1,
          stage: "shipped",
          scoreBefore: 0,
          scoreAfter: 1,
          criteriaMet: 1,
          criteriaPartial: 0,
          criteriaUnmet: 0,
          costUsd: 0.1,
          lastVerifyResult: "PASS",
          actualCost: 0.1,
          score: 1,
        };
      },
    );

    const { chunks } = await drain(runProductLoop(makeOpts({ flowDir, idea: "anything" })));

    expect(visibleText(chunks)).not.toContain("stopped before sprints");
  });
});

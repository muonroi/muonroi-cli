/**
 * sprint-nested-turn-terminator.test.ts — a nested turn's `{type:"done"}` must
 * never end the `/ideal` run.
 *
 * MEASURED (session d4fd0b77f6a6, run mtwnfp8p3869): sprint 1's completeness
 * re-check prompt went through `processMessageFn` → the full chat turn path →
 * a forked child sub-session (ad356cad9642). The child's last model call was at
 * 08:39:05; at 08:41:14 the top-level turn watchdog fired and
 * `processMessage` yielded `{type:"error","Turn ended by watchdog: …"}` and then
 * `{type:"done"}` (orchestrator.ts:3708-3709). `sprint-runner` forwarded both
 * unfiltered, the TUI's `/ideal` for-await ended on the `done`
 * (use-app-logic.tsx:5277 `if (chunk.type === "done") break;`), and nothing
 * else was ever recorded — no sprint_stage row, no sprint_impl_error, no file
 * written under the run dir — while the process sat idle at the chat prompt.
 *
 * A normal turn ends with `done` too (tool-engine.ts:4570), so the leak was not
 * specific to the watchdog: any nested turn that completed normally tore the
 * run down the same way.
 *
 * These tests drive the REAL `runSprint` and consume it exactly like the TUI
 * does — stop on the first `done` — because the sibling guard at the planning
 * council seam was pinned only there and the two other forwarding loops were
 * missed.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Verbatim chunk shapes the orchestrator emits (orchestrator.ts:3690-3709). */
const WATCHDOG_ERROR = {
  type: "error",
  content: "Turn ended by watchdog: assistant turn produced no output for 120s — treated as hung",
  isAuthError: false,
} as const;
const TURN_DONE = { type: "done" } as const;

type NestedScript = Array<Record<string, unknown>>;
const nested: { impl: NestedScript; recheck: NestedScript } = { impl: [], recheck: [] };

vi.mock("../../council/index.js", () => ({
  runCouncil: vi.fn(() =>
    (async function* () {
      yield { type: "content", content: "planning…" };
      // Names a target that the nested turns never create, so the 4A
      // completeness re-check always fires after implementation.
      return "## Plan\n- create src/feature/missing-target.ts\n";
    })(),
  ),
}));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB1_costProjection: vi.fn(() => ({ halt: false, projection: 0, headroom: 100 })),
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
  reserveForProduct: vi.fn(async () => ({
    id: "tok",
    model: "m",
    provider: "p",
    projected_usd: 0.1,
    est_input_tokens: 100,
    est_output_tokens: 100,
    createdAtMs: 0,
  })),
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
const RECHECK_PROMPT_HEAD = "The sprint plan named these target files but they DO NOT exist on disk yet";
const ENV_KEYS = ["MUONROI_SPRINT_IMPL_RECHECK", "MUONROI_SPRINT_ISOLATED_IMPL", "MUONROI_IDEAL_ADHERENCE_REVIEW"];

let testDir = "";
const prevEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "sprint-nested-done-"));
  vi.clearAllMocks();
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  delete process.env.MUONROI_SPRINT_IMPL_RECHECK; // re-check is default-ON
  delete process.env.MUONROI_SPRINT_ISOLATED_IMPL; // isolated impl is default-ON
  // The adherence review is gated on the isolated bridge and needs a git diff;
  // it is not the seam under test, so keep it out of the way.
  process.env.MUONROI_IDEAL_ADHERENCE_REVIEW = "0";
  nested.impl = [{ type: "content", content: "impl applied" }, TURN_DONE];
  nested.recheck = [{ type: "content", content: "recheck applied" }, TURN_DONE];
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
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

const prompts: string[] = [];
const isolatedCalls: string[] = [];
/**
 * `isolatedImpl: true` reproduces the measured run: the implementation stage
 * ran through `runIsolatedTask` (the production default — a Promise, no stream,
 * no `done`) and only the re-check went through `processMessageFn`.
 * `isolatedImpl: false` takes the streamed implementation path instead.
 */
function makeCtx(opts: { isolatedImpl: boolean }): unknown {
  prompts.length = 0;
  isolatedCalls.length = 0;
  return {
    runId: "run-nested-done",
    flowDir: testDir,
    cwd: testDir,
    idea: "greenfield idea",
    llm: { generate: vi.fn(async () => "text"), research: vi.fn(async () => "r") },
    flags: { maxCost: 100, maxSprints: 1, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn((prompt: string) => {
      prompts.push(prompt);
      const script = prompt.startsWith(RECHECK_PROMPT_HEAD) ? nested.recheck : nested.impl;
      return (async function* () {
        for (const c of script) yield c;
      })();
    }),
    ...(opts.isolatedImpl
      ? {
          runIsolatedTask: vi.fn(async (req: { prompt: string }) => {
            isolatedCalls.push(req.prompt);
            return { success: true, output: "isolated impl applied" };
          }),
        }
      : {}),
    detectVerifyRecipe: async () => null,
  };
}

type Phase = { phaseId?: string; state?: string; errorMessage?: string };
const phaseOf = (c: Record<string, unknown>): Phase | undefined =>
  c.type === "council_phase" ? (c.councilPhase as Phase) : undefined;
const statesOf = (chunks: Array<Record<string, unknown>>, id: string) =>
  chunks
    .map(phaseOf)
    .filter((p) => p?.phaseId === id)
    .map((p) => p?.state);

/**
 * Consume a sprint the way the TUI consumes `/ideal` (use-app-logic.tsx:5277):
 * stop on the first `done`. Also stops once the Verification stage opens — the
 * stage after the re-check, i.e. proof the sprint carried on — so the test does
 * not depend on the mocked verify internals downstream.
 */
async function drainLikeTui(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<{
  chunks: Array<Record<string, unknown>>;
  stop: "done-chunk" | "reached-verification" | "returned" | "threw";
  error?: Error;
}> {
  const chunks: Array<Record<string, unknown>> = [];
  try {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, stop: "returned" };
      const c = value as Record<string, unknown>;
      chunks.push(c);
      if (c.type === "done") {
        await gen.return(undefined);
        return { chunks, stop: "done-chunk" };
      }
      const p = phaseOf(c);
      if (p?.phaseId === "sprint-1-verification" && p.state === "active") {
        await gen.return(undefined);
        return { chunks, stop: "reached-verification" };
      }
    }
  } catch (err) {
    return { chunks, stop: "threw", error: err as Error };
  }
}

function sprint(opts: { isolatedImpl: boolean }): AsyncGenerator<unknown, unknown, unknown> {
  return runSprint({
    sprintN: 1,
    ctx: makeCtx(opts) as never,
    productSpec: makeSpec(),
    roleAssignments: NO_ROLES,
    history: [],
  }) as never;
}

describe("runSprint — a nested turn's `done` never ends the /ideal stream", () => {
  it("re-check (measured shape: isolated impl, re-check killed by the turn watchdog) does not end the run; the error still reaches the transcript", async () => {
    nested.recheck = [{ type: "content", content: "working…" }, WATCHDOG_ERROR, TURN_DONE];

    const { chunks, stop } = await drainLikeTui(sprint({ isolatedImpl: true }));

    // Sanity: this is the measured shape — isolated impl, then the re-check
    // through processMessageFn because the plan target is missing on disk.
    expect(isolatedCalls).toHaveLength(1);
    expect(existsSync(join(testDir, "src/feature/missing-target.ts"))).toBe(false);
    expect(prompts.filter((p) => p.startsWith(RECHECK_PROMPT_HEAD))).toHaveLength(1);

    expect(stop).toBe("reached-verification");
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    // We suppress the terminator, not the diagnosis.
    expect(chunks.some((c) => c.type === "error" && c.content === WATCHDOG_ERROR.content)).toBe(true);
  });

  it("re-check: a watchdog-killed nested turn closes the re-check stage as FAILED, carrying the watchdog message", async () => {
    nested.recheck = [WATCHDOG_ERROR, TURN_DONE];

    const { chunks, stop } = await drainLikeTui(sprint({ isolatedImpl: true }));

    expect(stop).toBe("reached-verification");
    expect(statesOf(chunks, "sprint-1-impl-recheck")).toEqual(["active", "error"]);
    const recheckErr = chunks.map(phaseOf).find((p) => p?.phaseId === "sprint-1-impl-recheck" && p.state === "error");
    expect(recheckErr?.errorMessage).toContain("Turn ended by watchdog");
  });

  it("implementation (streamed path): a watchdog-killed nested turn does not leak `done`; it fails the stage loudly", async () => {
    nested.impl = [{ type: "content", content: "editing…" }, WATCHDOG_ERROR, TURN_DONE];

    const { chunks, stop, error } = await drainLikeTui(sprint({ isolatedImpl: false }));

    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    expect(chunks.some((c) => c.type === "error" && c.content === WATCHDOG_ERROR.content)).toBe(true);
    // Stage failure, not a silent carry-on: the implementation phase closes
    // `error` and runSprint throws, which product-loop/index.ts turns into a
    // persisted sprint halt + the TUI recovery card.
    expect(stop).toBe("threw");
    expect(error?.message).toContain("Turn ended by watchdog");
    expect(statesOf(chunks, "sprint-1-implementation")).toEqual(["active", "error"]);
    // The re-check never runs on top of a failed implementation.
    expect(prompts.some((p) => p.startsWith(RECHECK_PROMPT_HEAD))).toBe(false);
  });

  it("normal completion (content, done) of both nested turns ends each stage normally and the sprint continues", async () => {
    const { chunks, stop } = await drainLikeTui(sprint({ isolatedImpl: false }));

    expect(stop).toBe("reached-verification");
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    expect(statesOf(chunks, "sprint-1-implementation")).toEqual(["active", "done"]);
    expect(statesOf(chunks, "sprint-1-impl-recheck")).toEqual(["active", "done"]);
    expect(chunks.some((c) => c.type === "content" && c.content === "impl applied")).toBe(true);
    expect(chunks.some((c) => c.type === "content" && c.content === "recheck applied")).toBe(true);
  });

  it("an `error` the nested turn recovered from (error, content, done) does not fail the stage", async () => {
    nested.recheck = [WATCHDOG_ERROR, { type: "content", content: "recovered and finished" }, TURN_DONE];

    const { chunks, stop } = await drainLikeTui(sprint({ isolatedImpl: true }));

    expect(stop).toBe("reached-verification");
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(0);
    expect(statesOf(chunks, "sprint-1-impl-recheck")).toEqual(["active", "done"]);
  });
});

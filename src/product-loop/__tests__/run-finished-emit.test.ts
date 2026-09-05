/**
 * run-finished-emit.test.ts — A2 (terminal-state coverage), the SUCCESS case.
 *
 * `docs/agent-first/SELF-IMPROVEMENT-PLAN.md` §6.0 open item 3: failures
 * announce themselves (`sprint-halt reason=…`, `announceDriverBail`), but a
 * successful `/ideal` run emitted **no terminal event at all** — so to an agent
 * driving the TUI over MCP, "finished fine" and "hung" were the same
 * observation. That is instance 5 of §1's failure class, inverted: the system
 * does the thing and reports nothing.
 *
 * These tests pin the invariant at the single choke point every `/ideal`
 * subcommand returns through (`runProductLoop`): **every path that ends a run
 * emits exactly one `run-finished` event carrying the outcome** — success,
 * failure, throw, or consumer teardown.
 *
 * Mock scaffolding mirrors `route-decision-emit.test.ts`, which drives the same
 * entry point with a fake `__muonroiAgentRuntime`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventFilter } from "@muonroi/agent-harness-core/event-filter";
import { redactEvent } from "@muonroi/agent-harness-core/event-redact";
import { LIVE_EVENT_KINDS } from "@muonroi/agent-harness-core/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

vi.mock("../sprint-runner.js", () => ({
  runSprint: vi.fn(),
}));
vi.mock("../cross-run-memory.js", () => ({
  extractRunToEE: vi.fn(async () => ({ ok: true, durationMs: 1, mistakes: 0, stored: 1 })),
}));
vi.mock("../../ee/phase-outcome.js", () => ({
  fireAndForgetPhaseOutcome: vi.fn(),
}));
vi.mock("../loop-driver.js", () => ({
  runLoopDriver: vi.fn(),
}));
vi.mock("../backlog-store.js", () => ({
  readBacklog: vi.fn(async () => null),
  writeBacklog: vi.fn(async () => undefined),
}));
vi.mock("../sprint-store.js", () => ({
  readSprintPlan: vi.fn(async () => null),
  writeSprintPlan: vi.fn(async () => undefined),
  setActiveSprint: vi.fn(async () => undefined),
}));
vi.mock("../backlog-builder.js", () => ({
  buildBacklog: vi.fn(async () => ({
    runId: "test-run",
    productSlug: "test",
    items: [],
    derivedFromClarifyId: "abc123",
    createdAtUtc: new Date().toISOString(),
  })),
}));
vi.mock("../sprint-planner.js", () => ({
  planSprints: vi.fn(async () => ({
    runId: "test-run",
    sprints: [{ id: "sprint-1", number: 1, goal: "go", itemIds: [], status: "planned" }],
    createdAtUtc: new Date().toISOString(),
  })),
  applySprintAssignments: vi.fn(async () => undefined),
}));
vi.mock("../discovery-persistence.js", () => ({
  readProjectContext: vi.fn(async () => null),
}));
// Keep the real artifact-io behaviour; only `writeManifest` is overridden, in a
// single test, to produce an exception that escapes the whole generator.
vi.mock("../artifact-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artifact-io.js")>();
  return { ...actual, writeManifest: vi.fn(actual.writeManifest) };
});
vi.mock("../gather.js", () => ({
  clarifiedSpecFromContext: vi.fn(() => ({
    problemStatement: "test",
    constraints: [],
    successCriteria: [],
    scope: "test",
    rawQA: [],
    resolved: {},
  })),
}));

import { writeManifest } from "../artifact-io.js";
import { runProductLoop } from "../index.js";
import { runLoopDriver } from "../loop-driver.js";
import { runSprint } from "../sprint-runner.js";
import type { IterationState } from "../types.js";

beforeAll(async () => {
  await loadCatalog();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmpFlowDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "run-finished-emit-"));
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

function shippedIter(sprintN = 1): IterationState {
  return {
    sprintN,
    stage: "shipped",
    scoreBefore: 0,
    scoreAfter: 1.0,
    criteriaMet: 1,
    criteriaPartial: 0,
    criteriaUnmet: 0,
    costUsd: 0.1,
    lastVerifyResult: "PASS",
  };
}

function makeOpts(flowDir: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    flowDir,
    idea: "build something",
    subcommand: "start",
    sessionModelId: getTestModels().balanced,
    sessionId: "test-session-id",
    llm: { generate: vi.fn(async () => ""), research: vi.fn(async () => "") },
    flags: { maxCost: 50, maxSprints: 8, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(async () => "answer"),
    respondToPreflight: vi.fn(async () => true),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "ok" };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    mode: "new",
    ...overrides,
  };
}

type Emitted = Record<string, unknown>;

function emittedKinds(emitEvent: ReturnType<typeof vi.fn>): string[] {
  return emitEvent.mock.calls.map((c) => (c[0] as Emitted)?.["kind"] as string);
}

function runFinishedEvents(emitEvent: ReturnType<typeof vi.fn>): Emitted[] {
  return emitEvent.mock.calls.map((c) => c[0] as Emitted).filter((e) => e?.["kind"] === "run-finished");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run-finished — the success case announces itself", () => {
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = { emitEvent };
    vi.clearAllMocks();
    emitEvent.mockClear();
    process.env.MUONROI_PHASE_MODE = "0";
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runSprint as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return shippedIter(1);
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__muonroiAgentRuntime;
    delete process.env.MUONROI_PHASE_MODE;
  });

  it("CAPTURE: prints the full emitted event sequence of a successful hot-path run", async () => {
    const flowDir = await tmpFlowDir();
    const { result } = await drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never));
    // Deliberate artifact, not a debug leftover: §2.1 says artifacts decide.
    // The operator diffs this file before/after the emit site to see the
    // silence and then the terminal event. Written to tmpdir so it never
    // pollutes the repo. Opt in with A2_CAPTURE_OUT=<path>.
    const out = process.env["A2_CAPTURE_OUT"] ?? path.join(os.tmpdir(), "a2-run-finished-capture.json");
    await fs.writeFile(
      out,
      JSON.stringify(
        { result, emittedKinds: emittedKinds(emitEvent), runFinished: runFinishedEvents(emitEvent) },
        null,
        2,
      ),
      "utf8",
    );
    expect(result).toBeDefined();
  });

  it("emits exactly one run-finished with outcome=approved when the hot-path ships", async () => {
    const flowDir = await tmpFlowDir();
    const { result } = await drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never));
    expect(result.stage).toBe("approved");

    const finished = runFinishedEvents(emitEvent);
    expect(finished).toHaveLength(1);
    const ev = finished[0]!;
    expect(ev["t"]).toBe("event");
    expect(ev["outcome"]).toBe("approved");
    expect(ev["success"]).toBe(true);
    expect(ev["shipped"]).toBe(true);
    expect(ev["subcommand"]).toBe("start");
    expect(ev["reason"]).toBe("shipped");
    expect(typeof ev["runId"]).toBe("string");
    expect(ev["runId"]).not.toBe("");
    expect(typeof ev["sprintsRun"]).toBe("number");
    expect(typeof ev["ts"]).toBe("number");
  });

  it("is the LAST event of the run — a driver can treat it as the close", async () => {
    const flowDir = await tmpFlowDir();
    await drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never));
    const kinds = emittedKinds(emitEvent);
    expect(kinds.at(-1)).toBe("run-finished");
  });

  it("carries the outcome for a non-approved result too (symmetry with sprint-halt)", async () => {
    const flowDir = await tmpFlowDir();
    // `ship` without a runId returns stage:"error" reason:"missing_runId".
    await drain(runProductLoop(makeOpts(flowDir, { subcommand: "ship", runId: undefined }) as never));
    const finished = runFinishedEvents(emitEvent);
    expect(finished).toHaveLength(1);
    expect(finished[0]!["outcome"]).toBe("error");
    expect(finished[0]!["success"]).toBe(false);
    expect(finished[0]!["reason"]).toBe("missing_runId");
    expect(finished[0]!["subcommand"]).toBe("ship");
  });

  it("announces a THROW rather than letting the exception be the only signal", async () => {
    const flowDir = await tmpFlowDir();
    // `writeManifest` runs right after `createRun` in runHotPath and is NOT
    // inside a try — an exception here escapes the whole generator, which is
    // the exit the `catch` arm exists for.
    vi.mocked(writeManifest).mockImplementationOnce(() => {
      throw new Error("boom from writeManifest");
    });
    await expect(drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never))).rejects.toThrow(
      /boom from writeManifest/,
    );
    const finished = runFinishedEvents(emitEvent);
    expect(finished).toHaveLength(1);
    expect(finished[0]!["outcome"]).toBe("threw");
    expect(finished[0]!["success"]).toBe(false);
    expect(String(finished[0]!["reason"])).toContain("boom from writeManifest");
    // The run id was already published to the sink by createRun, so even a
    // throw names the run rather than reporting "".
    expect(finished[0]!["runId"]).not.toBe("");
  });

  it("announces ABANDONED when the consumer tears the generator down mid-run", async () => {
    const flowDir = await tmpFlowDir();
    (runLoopDriver as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield { type: "content", content: "running" };
      yield { type: "content", content: "still running" };
      return { runId: "r", stage: "approved", success: true };
    });
    const gen = runProductLoop(makeOpts(flowDir, { complexity: "high" }) as never);
    await gen.next();
    await gen.return(undefined as never);

    const finished = runFinishedEvents(emitEvent);
    expect(finished).toHaveLength(1);
    expect(finished[0]!["outcome"]).toBe("abandoned");
    expect(finished[0]!["success"]).toBe(false);
  });

  it("does not throw when no agentRuntime is installed (normal user mode)", async () => {
    (globalThis as Record<string, unknown>).__muonroiAgentRuntime = undefined;
    const flowDir = await tmpFlowDir();
    await expect(drain(runProductLoop(makeOpts(flowDir, { complexity: "low" }) as never))).resolves.toBeDefined();
  });
});

/**
 * Emitting the event is not enough — it has to SURVIVE the two harness-side
 * enumerations between `emitEvent` and the driver. Both fail silently:
 * `createEventFilter` drops any kind missing from the default preset, and
 * `redactEvent` strips an unlisted kind to a bare `{t, kind}` — a content-free
 * terminal event, exactly the §2.6 attack shape the referee rejects.
 */
describe("run-finished — survives the harness wire path", () => {
  it("is allowed by the DEFAULT event filter (MUONROI_HARNESS_EVENTS unset)", () => {
    expect(createEventFilter(undefined)("run-finished")).toBe(true);
    expect(createEventFilter("lifecycle")("run-finished")).toBe(true);
  });

  it("is listed in LIVE_EVENT_KINDS, so tui.last_event / tui.wait_for accept it", () => {
    expect(LIVE_EVENT_KINDS).toContain("run-finished");
  });

  it("keeps its payload through redaction instead of being stripped to {t, kind}", () => {
    const out = redactEvent({
      t: "event",
      kind: "run-finished",
      runId: "run-123",
      subcommand: "start",
      outcome: "approved",
      success: true,
      reason: "shipped",
      sprintsRun: 2,
      shipped: true,
      ts: 1,
    }) as unknown as Record<string, unknown>;
    expect(out["outcome"]).toBe("approved");
    expect(out["reason"]).toBe("shipped");
    expect(out["runId"]).toBe("run-123");
    expect(out["sprintsRun"]).toBe(2);
    expect(out["shipped"]).toBe(true);
    expect(out["subcommand"]).toBe("start");
  });

  it("caps + scrubs `reason`, which carries an exception message on outcome=threw", () => {
    const out = redactEvent({
      t: "event",
      kind: "run-finished",
      runId: "",
      subcommand: "start",
      outcome: "threw",
      success: false,
      reason: "x".repeat(1000),
      sprintsRun: 0,
      shipped: false,
      ts: 1,
    }) as unknown as Record<string, unknown>;
    expect(String(out["reason"]).length).toBeLessThanOrEqual(300);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// recordPlanExecutionHalt (plan-execution.ts) writes an interaction_logs row
// on every halt path below — mock logInteraction so those rows never hit the
// real DB, same pattern as plan-phase.test.ts / provider-failure-blocklist.test.ts.
vi.mock("../../storage/index.js", () => ({ logInteraction: vi.fn() }));

import { isCouncilPlanExecution, isImplementationIntent } from "../../pil/layer6-output.js";
import { logInteraction } from "../../storage/index.js";
import type { StreamChunk } from "../../types/index.js";
import { type PlanPhase, renderPlanMarkdown } from "../plan-artifact.js";
import { buildPhasePrompt, type ExecutionArgs, runPlanExecution, verifyPhase } from "../plan-execution.js";

const mockLogInteraction = logInteraction as ReturnType<typeof vi.fn>;

const PHASE: PlanPhase = {
  id: "P0",
  title: "Sentinel E2E",
  steps: ["Add the spy"],
  files: ["src/council/index.ts"],
  acceptance: ["Sentinel wins end to end"],
  verify: "bunx vitest run x",
  done: false,
};

describe("execution envelope", () => {
  it("a phase prompt is recognised as council plan execution", () => {
    expect(isCouncilPlanExecution(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("a phase prompt also reads as implementation intent", () => {
    expect(isImplementationIntent(buildPhasePrompt(".planning/PLAN.md", PHASE))).toBe(true);
  });

  it("ordinary prose is not council plan execution", () => {
    expect(isCouncilPlanExecution("Council debate completed. Approved conclusion: …")).toBe(false);
  });

  it("the prompt carries the phase acceptance criteria and its verify command", () => {
    const p = buildPhasePrompt(".planning/PLAN.md", PHASE);
    expect(p).toContain("Sentinel wins end to end");
    expect(p).toContain("bunx vitest run x");
    expect(p).toContain("P0");
  });
});

describe("verifyPhase", () => {
  it("a zero exit status passes", async () => {
    const r = await verifyPhase(PHASE, "/tmp", async () => ({ stdout: "ok", stderr: "", status: 0 }));
    expect(r.ok).toBe(true);
  });

  it("a non-zero exit status fails and keeps the output for the halt reason", async () => {
    const r = await verifyPhase(PHASE, "/tmp", async () => ({ stdout: "", stderr: "2 failed", status: 1 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("2 failed");
  });

  it("a phase with no verify command does NOT auto-pass", async () => {
    const r = await verifyPhase({ ...PHASE, verify: "" }, "/tmp", async () => ({ stdout: "", stderr: "", status: 0 }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no verify command");
  });

  // Round 3 (code review): the injected ExecFn can reproduce exactly the
  // shape spawn/spawnSync produce on a timeout, a spawn failure, or output
  // overflow — {status: null, error: {message}} — without any real process.
  // A gate whose entire diagnostic value is the halt reason needs each of
  // these three under test, not just the "OS never fails" happy path.
  it("a timeout (status: null, error set) fails and the message reaches the halt reason", async () => {
    const r = await verifyPhase(PHASE, "/tmp", async () => ({
      stdout: "partial output before the timeout",
      stderr: "",
      status: null,
      error: { message: "verify command timed out after 600000ms" },
    }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("verify command timed out after 600000ms");
    expect(r.output).toContain("partial output before the timeout");
  });

  it("a spawn failure (ENOENT-class) fails and the message reaches the halt reason", async () => {
    const r = await verifyPhase(PHASE, "/tmp", async () => ({
      stdout: "",
      stderr: "",
      status: null,
      error: { message: "spawn bunx ENOENT" },
    }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("spawn bunx ENOENT");
  });

  it("an output overflow fails and the message reaches the halt reason", async () => {
    const r = await verifyPhase(PHASE, "/tmp", async () => ({
      stdout: "the first 10MB of a runaway test dump",
      stderr: "",
      status: null,
      error: { message: "verify command output exceeded 10485760 bytes" },
    }));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("verify command output exceeded 10485760 bytes");
    expect(r.output).toContain("the first 10MB of a runaway test dump");
  });

  it("error set alongside a coincidental zero status still fails — error always wins", async () => {
    // Defensive: no real spawn/spawnSync path produces both at once (error
    // implies status stays null), but the gate's OWN condition must not
    // silently trust a stray status:0 over a set error.
    const r = await verifyPhase(PHASE, "/tmp", async () => ({
      stdout: "ok",
      stderr: "",
      status: 0,
      error: { message: "should never both be set, but must still fail if it happens" },
    }));
    expect(r.ok).toBe(false);
  });
});

// ── runPlanExecution — the destructive half: halt paths, multi-phase advance,
// exhausted plans, and the terminal-chunk / no-progress / fs guards added on
// code-review round 2. ────────────────────────────────────────────────────
function phase(id: string, verify = "exit 0"): PlanPhase {
  return {
    id,
    title: `Title ${id}`,
    steps: [`step ${id}`],
    files: [],
    acceptance: [`accept ${id}`],
    verify,
    done: false,
  };
}

function seedPlan(cwd: string, phases: PlanPhase[]): string {
  const planPath = join(cwd, "PLAN.md");
  writeFileSync(planPath, renderPlanMarkdown("test", phases), "utf8");
  return planPath;
}

const okExec: ExecutionArgs["exec"] = async () => ({ stdout: "ok", stderr: "", status: 0 });
const failExec: ExecutionArgs["exec"] = async () => ({ stdout: "", stderr: "2 failed", status: 1 });

function passthroughMessage(seen: string[]): ExecutionArgs["processMessage"] {
  return async function* (message: string) {
    seen.push(message);
    yield { type: "content", content: "did the work" } as StreamChunk;
  };
}

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<{ chunks: StreamChunk[]; result: T }> {
  const chunks: StreamChunk[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { chunks, result: step.value };
}

describe("runPlanExecution", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("advances multiple phases in order, marking each done on disk", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [phase("P0"), phase("P1")]);
    const seen: string[] = [];

    const { result } = await drain(
      runPlanExecution({ cwd, planPath, processMessage: passthroughMessage(seen), exec: okExec }),
    );

    expect(result).toEqual({ completed: ["P0", "P1"], haltedAt: null, reason: "plan complete" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("P0");
    expect(seen[1]).toContain("P1");
    const body = readFileSync(planPath, "utf8");
    expect(body.match(/\*\*Status:\*\* done/g)).toHaveLength(2);
  });

  it("a failing verify halts, does NOT advance to the next phase, and records the halt", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [phase("P0"), phase("P1")]);
    const seen: string[] = [];
    mockLogInteraction.mockClear();

    const { result, chunks } = await drain(
      runPlanExecution({
        cwd,
        planPath,
        processMessage: passthroughMessage(seen),
        exec: failExec,
        sessionId: "sess-halt",
      }),
    );

    expect(result.completed).toEqual([]);
    expect(result.haltedAt).toBe("P0");
    expect(result.reason).toContain("2 failed");
    // Only phase P0 ran — the loop stopped, it did not march on to P1.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("P0");
    expect(chunks.some((c) => c.type === "content" && c.content?.includes("Halted at P0"))).toBe(true);
    // Nothing was marked done — P0 stays pending on disk.
    expect(readFileSync(planPath, "utf8")).not.toContain("**Status:** done");

    // The halt this whole gate exists to enforce must land somewhere a
    // forensic reader can find it — the exact gap this fix closes.
    expect(mockLogInteraction).toHaveBeenCalledWith(
      "sess-halt",
      "error",
      expect.objectContaining({ eventSubtype: "council_plan_execution_verify_failed" }),
    );
  });

  it("a plan whose phases are already all done returns immediately without a turn", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [{ ...phase("P0"), done: true }]);
    const seen: string[] = [];

    const { result } = await drain(
      runPlanExecution({ cwd, planPath, processMessage: passthroughMessage(seen), exec: okExec }),
    );

    expect(result).toEqual({ completed: [], haltedAt: null, reason: "plan complete" });
    expect(seen).toHaveLength(0);
  });

  it("a no-progress write-back (hand-edited plan missing the Status line) halts instead of looping forever", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = join(cwd, "PLAN.md");
    // No `**Status:**` line at all — markPhaseDone (plan-artifact.ts) returns the
    // body UNCHANGED for a phase shaped like this. Without the no-progress guard
    // this would re-select P0 forever: unbounded turns, unbounded verify runs.
    writeFileSync(
      planPath,
      ["# PLAN — test", "", "## P0 — Do it", "", "**Acceptance:**", "- it works", "", "**Verify:** exit 0"].join("\n"),
      "utf8",
    );
    const seen: string[] = [];

    const { result } = await drain(
      runPlanExecution({ cwd, planPath, processMessage: passthroughMessage(seen), exec: okExec }),
    );

    expect(result.haltedAt).toBe("P0");
    expect(result.reason).toContain("could not mark P0 done");
    // The loop ran the phase turn exactly ONCE, not forever.
    expect(seen).toHaveLength(1);
  });

  it("an unreadable plan path halts with a reason instead of throwing out of the generator", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = join(cwd, "does-not-exist", "PLAN.md");
    const seen: string[] = [];

    const { result } = await drain(
      runPlanExecution({ cwd, planPath, processMessage: passthroughMessage(seen), exec: okExec }),
    );

    expect(result.haltedAt).toBeNull();
    expect(result.reason).toContain("could not read");
    expect(seen).toHaveLength(0);
  });

  it("the plan disappearing between verify and the write-back halts instead of throwing", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [phase("P0")]);
    const seen: string[] = [];
    // A verify command that "passes" but, as a side effect, removes the plan
    // file — simulates the plan disappearing mid-run (deleted, renamed, made
    // unwritable) between the phase turn finishing and the write-back.
    const vanishingExec: ExecutionArgs["exec"] = async () => {
      rmSync(planPath, { force: true });
      return { stdout: "ok", stderr: "", status: 0 };
    };

    const { result } = await drain(
      runPlanExecution({ cwd, planPath, processMessage: passthroughMessage(seen), exec: vanishingExec }),
    );

    expect(result.haltedAt).toBe("P0");
    expect(result.reason).toContain("could not re-read");
  });

  it("filters the inner turn's terminal done chunk so a later phase is never stranded", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [phase("P0"), phase("P1")]);
    const processMessage: ExecutionArgs["processMessage"] = async function* (message: string) {
      yield { type: "content", content: `worked on ${message.includes("P0") ? "P0" : "P1"}` } as StreamChunk;
      // Every real processMessage call ends with a turn-terminal done chunk
      // (orchestrator.ts) — runPlanExecution must swallow it, not forward it,
      // or the stream consumer stops pulling after phase 1 (blocker-5 class bug).
      yield { type: "done" } as StreamChunk;
    };

    const { chunks, result } = await drain(runPlanExecution({ cwd, planPath, processMessage, exec: okExec }));

    expect(result.completed).toEqual(["P0", "P1"]);
    expect(chunks.some((c) => c.type === "done")).toBe(false);
    expect(chunks.some((c) => c.type === "content" && c.content?.includes("worked on P0"))).toBe(true);
    expect(chunks.some((c) => c.type === "content" && c.content?.includes("worked on P1"))).toBe(true);
  });

  it("a phase the turn itself already marked done on disk is accepted, not treated as no-progress", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = seedPlan(cwd, [phase("P0")]);
    // Simulate a sub-agent turn that (unusually, but not an error) writes
    // PLAN.md itself, marking P0 done before verify even runs.
    const processMessage: ExecutionArgs["processMessage"] = async function* () {
      const body = readFileSync(planPath, "utf8");
      writeFileSync(planPath, body.replace("**Status:** pending", "**Status:** done"), "utf8");
      yield { type: "content", content: "did it and self-marked" } as StreamChunk;
    };

    const { result } = await drain(runPlanExecution({ cwd, planPath, processMessage, exec: okExec }));

    expect(result).toEqual({ completed: ["P0"], haltedAt: null, reason: "plan complete" });
  });

  it("an UNPARSEABLE plan reports 'no phases found', never 'plan complete'", async () => {
    // "no phases in the file" and "every phase is done" are different outcomes.
    // Collapsing them made a malformed (e.g. hand-edited) PLAN.md report success
    // having run nothing at all — fail-silent-SUCCESS on a gate.
    cwd = mkdtempSync(join(tmpdir(), "plan-exec-"));
    const planPath = join(cwd, "PLAN.md");
    writeFileSync(planPath, "# PLAN\n\nA prose plan with no `## P0 —` headings at all.\n", "utf8");

    let turns = 0;
    const processMessage: ExecutionArgs["processMessage"] = async function* () {
      turns += 1;
      yield { type: "done" } as StreamChunk;
    };

    const { result, chunks } = await drain(runPlanExecution({ cwd, planPath, processMessage, exec: okExec }));

    expect(result.completed).toEqual([]);
    expect(result.reason).toContain("no phases found");
    expect(result.reason).not.toContain("plan complete");
    expect(turns).toBe(0);
    // And it must SAY so — a silent no-op read as a finished run.
    expect(chunks.some((c) => c.type === "content" && c.content?.includes("no phases found"))).toBe(true);
  });
});

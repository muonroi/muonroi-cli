/**
 * The resume digest must name an action, not restate the failure.
 *
 * Run `muc2joffe506` on `D:\sources\CompanyLibs\qa-platform` ended with
 * `.muonroi-flow/runs/muc2joffe506/state.md` reading, verbatim:
 *
 *   - Stage: sprint-2
 *   - Last completed: sprint-2 retrospective
 *   - Next action: Retry sprint 2: engineering_floor: no_test_commands
 *   - Score: 0.00
 *   - Verify: ERROR
 *
 * while `sprints/2-outcome.json` recorded `{"failedCondition":
 * "engineering_floor", "reason": "no_test_commands", "pass": false, "score": 0,
 * "verify": "ERROR"}`. The user was shown a halt card at that moment, took its
 * recommended option, and stopped the run — the digest was the surface that
 * disagreed. `/ideal resume` prints this line back to the user
 * (src/product-loop/index.ts:2214-2220), so it is an instruction, not a label.
 *
 * These tests drive the REAL `runSprint` (the same harness
 * `sprint-outcome-reason.test.ts` uses) and assert on what it writes into
 * `state.md` and yields into the transcript.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
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
vi.mock("../cost-scoper.js", () => ({ recordProductSpend: vi.fn(async () => undefined) }));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { runCouncil } from "../../council/index.js";
import { writeArtifact } from "../../flow/artifact-io.js";
import { parseResumeDigest } from "../../flow/run-artifacts.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

let flowDir: string;
let projectCwd: string;

function makeSpec(): ProductSpec {
  return {
    idea: "test idea",
    persona: "users",
    mvp: ["feat1"],
    phase2: [],
    architecture: "arch",
    ioContract: "io",
    folderStructure: "src/",
    sprintEstimate: 1,
    costEstimate: 10,
    createdAt: new Date(),
  };
}

function makeCtx(): any {
  return {
    runId: "run-digest",
    flowDir,
    cwd: projectCwd,
    idea: "test idea",
    llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
  };
}

async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<{ chunks: T[]; result: R | undefined }> {
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { chunks, result: value as R };
    chunks.push(value as T);
  }
}

/** The `Next action` line as it would land in `state.md`. */
function nextActionWritten(): string {
  const calls = (writeArtifact as any).mock.calls.filter((c: unknown[]) => c[1] === "state.md");
  expect(calls.length).toBeGreaterThan(0);
  const stateMap = calls[calls.length - 1][2] as { sections: Map<string, string> };
  const digest = parseResumeDigest(stateMap.sections.get("Resume Digest"));
  expect(digest).not.toBeNull();
  return digest!.nextAction;
}

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "digest-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "digest-cwd-"));
  vi.clearAllMocks();
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "VERIFY_PASS\n",
    verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] },
  });
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
});

afterEach(() => {
  rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the resume digest after a failed sprint", () => {
  it("does not write a bare 'Retry sprint 2' for engineering_floor: no_test_commands", async () => {
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "no_test_commands",
      score: 0,
    });

    await drain(
      runSprint({ sprintN: 2, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const nextAction = nextActionWritten();
    // The exact line muc2joffe506 wrote.
    expect(nextAction).not.toBe("Retry sprint 2: engineering_floor: no_test_commands");
    expect(nextAction).not.toMatch(/^Retry sprint 2\b/);
    // It must name where the fix belongs.
    expect(nextAction).toMatch(/manifest|test command/i);
  }, 90_000);

  it("names the real manifest when the project's tests are on disk but undeclared", async () => {
    // The qa-platform shape, measured: backend/requirements.txt exists and
    // contains no pytest, while backend/conftest.py opens with "Pytest
    // configuration for backend tests."
    mkdirSync(join(projectCwd, "backend"), { recursive: true });
    writeFileSync(join(projectCwd, "backend", "requirements.txt"), "fastapi==0.115.0\nsqlalchemy==2.0.35\n");
    writeFileSync(join(projectCwd, "backend", "conftest.py"), '"""Pytest configuration for backend tests."""\n');

    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "no_test_commands",
      score: 0,
    });

    await drain(
      runSprint({ sprintN: 2, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const nextAction = nextActionWritten();
    expect(nextAction).toContain("backend/requirements.txt");
    expect(nextAction).toContain("pytest");
  }, 90_000);

  it("keeps the pass line unchanged", async () => {
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1 });

    await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(nextActionWritten()).toBe("Definition-of-Done met — advance to the next phase or ship");
  }, 90_000);

  it("shows the user the SAME line it writes to state.md", async () => {
    (evaluateDoneGate as any).mockResolvedValue({
      pass: false,
      failedCondition: "engineering_floor",
      reason: "no_test_commands",
      score: 0,
    });

    const { chunks } = await drain(
      runSprint({ sprintN: 2, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const text = (chunks as any[]).map((c) => c.content ?? "").join("");
    // One derivation, two surfaces: the transcript line the user reads at that
    // moment and the digest `/ideal resume` reads later cannot disagree.
    expect(text).toContain(nextActionWritten());
  }, 90_000);
});

describe("the CB-3 halt card and the digest read from one derivation", () => {
  it("puts the derived action on the halt chunk's detail", async () => {
    (CB3_verifyBlank as any).mockReturnValue({ halt: true, reason: "no_recipe" });

    const { chunks } = await drain(
      runSprint({ sprintN: 1, ctx: makeCtx(), productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    const halt = (chunks as any[]).find((c) => c.type === "halt");
    expect(halt).toBeDefined();
    expect(halt.haltChunk.reason).toBe("no_recipe");
    // The card renders `detail` verbatim (src/ui/components/halt-recovery-card.tsx:63-67).
    // It used to be absent, so the card named three options and no reason to
    // prefer any of them.
    expect(halt.haltChunk.detail).toBeTruthy();
    expect(halt.haltChunk.detail).toMatch(/recipe/i);
    expect(halt.haltChunk.detail).not.toMatch(/^Retry sprint/);
  }, 90_000);
});

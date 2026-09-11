/**
 * F5 — CALL-SITE PIN.
 *
 * `goal-contradiction-gate.test.ts` proves the gate is correct. That is not
 * enough in this repository: it has repeatedly shipped a correct helper wired to
 * nothing, with the live path unchanged and every gate green — that is literally
 * what `scripts/lib/export-reachability.ts` was built to catch, twice.
 *
 * So this file drives the REAL `runSprint` against a REAL git repository whose
 * working tree carries the REAL change from commit `6888526`
 * (`src/TCIS.CodeStandards/TCIS.CodeStandards.csproj`, before → after, verbatim),
 * and asserts on `IterationState.lastVerifyResult` — the value the done-gate and
 * the next sprint's carry-over actually read.
 *
 * The verify sub-agent claims PASS and the deterministic floor finds no project
 * to gate on, exactly as in run 1. So PASS is what the sprint scores unless the
 * goal gate takes it away.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";

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
// The deterministic verify floor is a SEPARATE gate with its own dedicated
// suite (`sprint-verify-floor.test.ts`). It is held at "unavailable" here so a
// FAIL in this file can only have come from the goal gate — and so the fixture
// project, which is a real analyzer project file, never causes a real toolchain
// build to be shelled out during a unit test.
vi.mock("../verify-floor.js", () => ({
  runVerifyFloor: vi.fn(async () => ({
    verdict: "unavailable",
    reason: "no-commands-discovered",
    detail: "held unavailable by the F5 call-site fixture",
    checks: [],
    elapsedMs: 0,
  })),
  applyVerifyFloor: (current: string) => ({ verdict: current, downgraded: false, upgraded: false, note: "" }),
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

import { runCouncil } from "../../council/index.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { GOAL_GATE_SYSTEM, type GoalGateRecord } from "../goal-contradiction-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";
import { F5_GOAL } from "./fixtures/f5-tcis-goal.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

/** `git show 6888526^:src/TCIS.CodeStandards/TCIS.CodeStandards.csproj` — verbatim. */
const CSPROJ_BEFORE = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <IsRoslynComponent>true</IsRoslynComponent>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <PackageId>TCIS.CodeStandards</PackageId>
    <Authors>TCIS Libraries</Authors>
    <Description>Roslyn analyzers enforcing TCIS corporate coding standards (line length, line-break style, semantic grouping).</Description>
    <IncludeBuildOutput>false</IncludeBuildOutput>
    <GenerateDependencyFile>false</GenerateDependencyFile>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" />
    <PackageReference Include="Microsoft.CodeAnalysis.Analyzers" />
    <PackageReference Include="Microsoft.CodeAnalysis.Workspaces.Common" />
  </ItemGroup>
</Project>
`;

/** `git show 6888526:…` — the same file after the change the two runs both made. */
const CSPROJ_AFTER = CSPROJ_BEFORE.replace(
  "<TargetFramework>netstandard2.0</TargetFramework>",
  "<TargetFramework>net9.0</TargetFramework>",
).replace('    <PackageReference Include="Microsoft.CodeAnalysis.Workspaces.Common" />\n', "");

const CSPROJ_PATH = "src/TCIS.CodeStandards/TCIS.CodeStandards.csproj";
const DECISIVE_REMOVAL = "-    <TargetFramework>netstandard2.0</TargetFramework>";
const GOAL_FRAGMENT = "báo warning trong visual studio";

function fence(body: unknown): string {
  return `Reasoning first.\n\n\`\`\`goal-check\n${JSON.stringify(body)}\n\`\`\`\n`;
}

const CONTRADICTS = fence({
  verdict: "contradicts",
  contradictions: [
    {
      goal: GOAL_FRAGMENT,
      change: DECISIVE_REMOVAL,
      why: "retargeted away from the only framework the IDE loads the component from, so the warning can never appear",
    },
  ],
  rationale: "the change removes the only path to the behaviour the user asked for",
});

const ALIGNED = fence({ verdict: "aligned", contradictions: [], rationale: "serves the stated goal" });

let flowDir: string;
let projectCwd: string;
/** Every prompt the goal gate actually sent, in order. */
let goalPrompts: string[];
/** What the stubbed judge replies with. */
let judgeReply: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: projectCwd, stdio: "ignore" });
}

/** A real repository whose HEAD holds the pre-change file. */
function seedRepo(): void {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "f5@test.local"]);
  git(["config", "user.name", "F5 fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectCwd, "before.txt"), "seed\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
  git(["commit", "-q", "-m", "seed"]);
}

function writeCsproj(contents: string): void {
  mkdirSync(join(projectCwd, "src", "TCIS.CodeStandards"), { recursive: true });
  writeFileSync(join(projectCwd, CSPROJ_PATH), contents, "utf8");
}

function makeSpec(): ProductSpec {
  return {
    idea: F5_GOAL.idea,
    persona: "TCIS developers",
    mvp: [...F5_GOAL.successCriteria],
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
    runId: "run-f5-callsite",
    flowDir,
    cwd: projectCwd,
    // The user's literal text — the goal the gate must judge against.
    idea: F5_GOAL.idea,
    sessionModelId: getTestModels().balanced,
    llm: {
      generate: vi.fn(async (_model: string, system: string, prompt: string) => {
        if (system === GOAL_GATE_SYSTEM) {
          goalPrompts.push(prompt);
          return judgeReply;
        }
        return "synthesis text";
      }),
      research: vi.fn(async () => "research"),
    },
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
    respondToQuestion: vi.fn(),
    respondToPreflight: vi.fn(),
    processMessageFn: vi.fn(async function* () {
      yield { type: "content", content: "implementing..." };
    }),
    detectVerifyRecipe: vi.fn(async () => ({ testCommands: [], coverage: 80, shellInitCommands: [] })),
  };
}

/** The gate's durable record, read back the way an auditor would. */
function readGoalGateRecord(sprintN = 1): GoalGateRecord | null {
  const p = join(flowDir, "runs", "run-f5-callsite", "sprints", `${sprintN}-goal-gate.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as GoalGateRecord;
}

async function runOneSprint(): Promise<{ result: any; text: string }> {
  const gen = runSprint({
    sprintN: 1,
    ctx: makeCtx(),
    productSpec: makeSpec(),
    roleAssignments: NO_ROLES,
    history: [],
  });
  let text = "";
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { result: value, text };
    if ((value as any)?.type === "content") text += (value as any).content;
  }
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  flowDir = mkdtempSync(join(tmpdir(), "f5-callsite-flow-"));
  projectCwd = mkdtempSync(join(tmpdir(), "f5-callsite-cwd-"));
  goalPrompts = [];
  judgeReply = ALIGNED;
  vi.clearAllMocks();
  // Tier-3 self-verify is a separate gate with its own spawn; keep it out of
  // this measurement so a FAIL here can only have come from the goal gate.
  process.env.MUONROI_SPRINT_SELF_VERIFY = "0";
  (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
  (CB3_verifyBlank as any).mockReturnValue({ halt: false });
  (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
  (runVerifyOrchestration as any).mockResolvedValue({
    success: true,
    output: "Everything looks good.\nVERIFY_PASS\n",
    verifyRecipe: { testCommands: [], coverage: 80, shellInitCommands: [] },
  });
  (runCouncil as any).mockImplementation(async function* () {
    yield { type: "content", content: "council planning..." };
    return "synthesis text from council";
  });
});

afterEach(() => {
  delete process.env.MUONROI_SPRINT_SELF_VERIFY;
  rmSync(flowDir, { recursive: true, force: true });
  rmSync(projectCwd, { recursive: true, force: true });
});

describe("runSprint consults the goal-contradiction gate", () => {
  it("does NOT score PASS when the change works against the stated goal", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    // The change both runs made, now sitting in the working tree.
    writeCsproj(CSPROJ_AFTER);
    judgeReply = CONTRADICTS;

    const { result, text } = await runOneSprint();

    // The judge was asked, and was shown both halves of the evidence.
    expect(goalPrompts).toHaveLength(1);
    expect(goalPrompts[0]).toContain(DECISIVE_REMOVAL);
    expect(goalPrompts[0]).toContain(GOAL_FRAGMENT);
    // …and the sprint the verify agent called PASS is not scored PASS.
    expect(result.lastVerifyResult).toBe("FAIL");
    expect(text).toContain("[goal-gate]");
    // The contradiction reaches the transcript by name, not as a count.
    expect(text).toContain(GOAL_FRAGMENT);
  }, 90_000);

  it("still scores PASS when the judge finds the change serves the goal", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER.replace("net9.0", "netstandard2.0"));
    judgeReply = ALIGNED;

    const { result, text } = await runOneSprint();

    expect(goalPrompts).toHaveLength(1);
    expect(result.lastVerifyResult).toBe("PASS");
    expect(text).toContain("serves the stated goal");
  }, 90_000);

  it("does NOT score PASS when the judge's reply cannot be read", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER);
    judgeReply = "Honestly it all looks reasonable to me.";

    const { result, text } = await runOneSprint();

    expect(result.lastVerifyResult).toBe("FAIL");
    expect(text).toContain("NOT been checked");
  }, 90_000);

  it("leaves PASS standing, announced, when the judge answers with nothing at all", async () => {
    // MEASURED against the real leader: at the shipped 2048-token budget the
    // reasoning consumed the whole output allowance and `generate` returned ""
    // on 2 of 4 calls (finishReason "length"). That is infrastructure, and the
    // sprint must not be failed by it — but it must not look like a pass either.
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER);
    judgeReply = "";

    const { result, text } = await runOneSprint();

    // The retry is threaded through the real call site, not only the unit test.
    expect(goalPrompts).toHaveLength(2);
    expect(result.lastVerifyResult).toBe("PASS");
    expect(text).toContain("was NOT checked against the goal");
    expect(text).toContain("empty-reply");
  }, 90_000);

  it("leaves PASS standing — and never calls the judge — when there is no diff to read", async () => {
    // No repository at all: the gate cannot see the change, so it has no opinion.
    const { result, text } = await runOneSprint();

    expect(goalPrompts).toEqual([]);
    expect(result.lastVerifyResult).toBe("PASS");
    // Fail-open is announced: "found nothing" and "never ran" must not look alike.
    expect(text).toContain("was NOT checked against the goal");
  }, 90_000);

  it("still scores PASS — and sees the work — when the sprint never committed anything", async () => {
    // MEASURED, live run, mid-run: `git diff HEAD` was 5,874 characters of
    // package-version and solution bookkeeping and the sprint's entire output
    // was untracked, so the judge was shown none of it and answered "aligned".
    // HEAD never moved across two sprints, so the HEAD~1 fallback never fired.
    seedRepo();
    writeCsproj(CSPROJ_AFTER); // never added, never committed
    judgeReply = CONTRADICTS;

    const { result } = await runOneSprint();

    expect(goalPrompts).toHaveLength(1);
    expect(goalPrompts[0]).toContain("<TargetFramework>net9.0</TargetFramework>");
    expect(result.lastVerifyResult).toBe("FAIL");
    expect(readGoalGateRecord()?.diffFiles).toContain(CSPROJ_PATH);
  }, 90_000);

  it("is skipped entirely under MUONROI_IDEAL_GOAL_GATE=0", async () => {
    process.env.MUONROI_IDEAL_GOAL_GATE = "0";
    try {
      seedRepo();
      writeCsproj(CSPROJ_BEFORE);
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
      git(["commit", "-q", "-m", "pre-change analyzer project"]);
      writeCsproj(CSPROJ_AFTER);
      judgeReply = CONTRADICTS;

      const { result, text } = await runOneSprint();

      expect(goalPrompts).toEqual([]);
      expect(result.lastVerifyResult).toBe("PASS");
      expect(text).not.toContain("[goal-gate]");
    } finally {
      delete process.env.MUONROI_IDEAL_GOAL_GATE;
    }
  }, 90_000);
});

/**
 * F5 — the verdict has to OUTLIVE the run.
 *
 * MEASURED: the gate ran on sprint 2 of a live `/ideal` run (the sprint ended
 * `verify: PASS`, so the call site was reached) and its verdict could not be
 * found afterwards anywhere — not in `~/.muonroi-cli/muonroi.db` (every text
 * column of `messages`, `interaction_logs` and `tool_results` searched for
 * `goal-gate`), not in `~/.muonroi-cli/debug.log`, and not under the run's own
 * `.muonroi-flow/runs/<runId>/`. That it had run at all was an inference from
 * control flow. `idealTrace` is a no-op unless `MUONROI_IDEAL_TRACE` is set
 * (`ideal-trace.ts:35`), the TUI discards stderr with the alternate screen
 * buffer, and the `aligned` path only yielded a transcript chunk nothing keeps.
 *
 * So the record goes next to the sprint artifacts the loop already writes, and
 * it carries the two fields that would have made the untracked-diff defect
 * visible on sight — WHICH files the judge saw and HOW MANY characters — rather
 * than only the verdict they produced.
 */
describe("the goal gate leaves a durable record", () => {
  it("records a firing verdict with its evidence and the diff it judged", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER);
    judgeReply = CONTRADICTS;

    await runOneSprint();
    const rec = readGoalGateRecord();

    expect(rec).not.toBeNull();
    expect(rec?.fired).toBe(true);
    expect(rec?.source).toBe("contradicts");
    expect(rec?.sprintN).toBe(1);
    expect(rec?.runId).toBe("run-f5-callsite");
    // The decision is auditable without re-running it: both halves of the
    // evidence, not a count.
    expect(rec?.contradictions?.[0]?.goal).toContain(GOAL_FRAGMENT);
    expect(rec?.contradictions?.[0]?.change).toContain(DECISIVE_REMOVAL);
    // …and what the judge was actually shown.
    expect(rec?.diffOrigin).toBe("working-tree");
    expect(rec?.diffFiles).toContain(CSPROJ_PATH);
    expect(rec?.diffChars).toBeGreaterThan(0);
    expect(typeof rec?.judgedAt).toBe("string");
  }, 90_000);

  it("records an ALIGNED verdict too — the case that produced no evidence at all", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER.replace("net9.0", "netstandard2.0"));
    judgeReply = ALIGNED;

    await runOneSprint();
    const rec = readGoalGateRecord();

    expect(rec?.fired).toBe(false);
    expect(rec?.source).toBe("aligned");
    // The pair that makes a rubber stamp visible on sight: an "aligned" beside
    // a file list holding nothing but bookkeeping is a wrong answer you can see.
    expect(rec?.diffFiles).toContain(CSPROJ_PATH);
    expect(rec?.diffChars).toBeGreaterThan(0);
  }, 90_000);

  it("records a fail-open outcome, so 'found nothing' and 'never ran' stay different facts", async () => {
    // No repository at all — the gate has nothing to read and no opinion.
    await runOneSprint();
    const rec = readGoalGateRecord();

    expect(rec).not.toBeNull();
    expect(rec?.fired).toBe(false);
    expect(rec?.source).toBe("diff-unreadable");
    expect(rec?.detail.length).toBeGreaterThan(0);
    // Nothing was judged, so nothing is claimed about what was seen.
    expect(rec?.diffFiles).toBeUndefined();
  }, 90_000);

  it("records the empty-reply fail-open, which the transcript alone loses", async () => {
    seedRepo();
    writeCsproj(CSPROJ_BEFORE);
    execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
    git(["commit", "-q", "-m", "pre-change analyzer project"]);
    writeCsproj(CSPROJ_AFTER);
    judgeReply = "";

    const { result } = await runOneSprint();
    const rec = readGoalGateRecord();

    expect(result.lastVerifyResult).toBe("PASS");
    expect(rec?.source).toBe("empty-reply");
    expect(rec?.fired).toBe(false);
    // A diff WAS read and shown — the failure was on the way back, and the
    // record has to say so, or an auditor cannot tell it from "no diff".
    expect(rec?.diffFiles).toContain(CSPROJ_PATH);
  }, 90_000);

  it("records that the gate was switched off, rather than writing nothing", async () => {
    process.env.MUONROI_IDEAL_GOAL_GATE = "0";
    try {
      seedRepo();
      writeCsproj(CSPROJ_BEFORE);
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "ignore" });
      git(["commit", "-q", "-m", "pre-change analyzer project"]);
      writeCsproj(CSPROJ_AFTER);

      await runOneSprint();

      // "Off" is the one state a reader is most likely to mistake for "clean".
      expect(readGoalGateRecord()?.source).toBe("disabled");
    } finally {
      delete process.env.MUONROI_IDEAL_GOAL_GATE;
    }
  }, 90_000);
});

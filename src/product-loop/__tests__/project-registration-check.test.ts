/**
 * S6 — a new project manifest must be REGISTERED in its ecosystem's solution/
 * workspace index, or its tests never run at all.
 *
 * ## The bug this closes
 *
 * Live run `mu54vrme4c87` created a new .NET analyzer project and its test
 * project, but never added either to the repo's solution file. The solution
 * carried 108 projects and zero matches for the two new ones, so
 * `dotnet test <sln>` never ran their tests and both sprints ended
 * `engineering_floor: zero_coverage`. Prompt text alone (the "Layout
 * convention" block, and sprint 1's own plan naming "register in the
 * solution" as task 1) did not close the gap — this file proves the
 * deterministic structural check that does.
 *
 * These tests execute REAL `git` in REAL temp directories, the same
 * discipline `verify-floor.test.ts` / `verify-floor-attribution.test.ts`
 * already use for this repo's other deterministic-evidence modules: the whole
 * value of this checker is that it reads the actual working tree, so a mocked
 * filesystem/git would assert nothing about that.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk, TaskRequest, ToolResult, VerifyRecipe } from "../../types/index.js";
import { logger } from "../../utils/logger.js";
import type { LayoutConvention } from "../layout-convention.js";
import {
  checkProjectRegistration,
  computeAddedFilesSinceBaseline,
  formatProjectRegistrationMustFix,
  formatProjectRegistrationNote,
  hasProjectRegistrationViolations,
  type ProjectRegistrationCheckResult,
} from "../project-registration-check.js";
import { type FloorDelta, VERIFY_BASELINE_VERSION, type VerifyBaseline } from "../verify-baseline.js";
import {
  buildFixPrompt,
  computeFailureKey,
  computeVerifyFixTrigger,
  deriveFailureIdentity,
  runVerifyFixLoop,
  type VerifyPassOutcome,
} from "../verify-fix-loop.js";
import type { FloorCheck } from "../verify-floor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers — neutral names only, no company names.
// ─────────────────────────────────────────────────────────────────────────────

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;

/** One `.sln`, optionally referencing projects. `relPaths` may use backslashes deliberately. */
function slnContent(relPaths: Array<{ name: string; relPath: string }>): string {
  const header = "Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\n";
  const body = relPaths
    .map(
      (p, i) =>
        `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${p.name}", "${p.relPath}", "{1111111${i}-1111-1111-1111-111111111111}"\nEndProject`,
    )
    .join("\n");
  return `${header}${body}\nGlobal\nEndGlobal\n`;
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "s6-proj-reg-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "s6@test.local");
  git(repo, "config", "user.name", "S6 fixture");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

function baselineWith(overrides: Partial<VerifyBaseline> = {}): VerifyBaseline {
  return {
    version: VERIFY_BASELINE_VERSION,
    runId: "run-s6",
    capturedAtUtc: new Date().toISOString(),
    cwd: "/tmp/unused",
    gitCommit: null,
    gitBranch: "main",
    gitDirty: null,
    commands: { build: [], test: [] },
    buildOk: true,
    failingTests: [],
    results: [],
    unattributable: false,
    ...overrides,
  };
}

let repo: string;

beforeEach(() => {
  repo = initRepo();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkProjectRegistration — the core matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("checkProjectRegistration — .NET solution registration", () => {
  it("a new csproj not referenced by the repo's .sln is a violation", async () => {
    writeFileSync(join(repo, "Acme.sln"), slnContent([]));
    commitAll(repo, "add empty solution"); // sln is tracked+clean
    // The new project is created AFTER the solution commit and never staged —
    // `git add -A` inside `commitAll` above must not scoop it up, or the test
    // would prove nothing about an untracked new project.
    mkdirSync(join(repo, "src", "src", "Acme.Widgets"), { recursive: true });
    writeFileSync(join(repo, "src", "src", "Acme.Widgets", "Acme.Widgets.csproj"), CSPROJ);

    const result = await checkProjectRegistration({ cwd: repo, baseline: null, layoutConvention: null });

    expect(result.ecosystems).toHaveLength(1);
    const eco = result.ecosystems[0]!;
    expect(eco.ecosystem).toBe("C#");
    expect(eco.status).toBe("violations");
    expect(eco.solutionFile).toBe("Acme.sln");
    expect(eco.unregistered).toHaveLength(1);
    expect(eco.unregistered[0]!.manifest).toBe("src/src/Acme.Widgets/Acme.Widgets.csproj");
    expect(eco.unregistered[0]!.solutionFile).toBe("Acme.sln");
    expect(hasProjectRegistrationViolations(result)).toBe(true);
  });

  it("the same project is ok once `dotnet sln add` registers it — including a backslash sln path", async () => {
    writeFileSync(
      join(repo, "Acme.sln"),
      // Deliberately backslash-separated, as `dotnet sln add` actually writes on Windows.
      slnContent([{ name: "Acme.Widgets", relPath: "src\\src\\Acme.Widgets\\Acme.Widgets.csproj" }]),
    );
    commitAll(repo, "add solution referencing the widget project");
    mkdirSync(join(repo, "src", "src", "Acme.Widgets"), { recursive: true });
    writeFileSync(join(repo, "src", "src", "Acme.Widgets", "Acme.Widgets.csproj"), CSPROJ);

    const result = await checkProjectRegistration({ cwd: repo, baseline: null, layoutConvention: null });

    // The csproj is untracked, so it's still "added since baseline" — but now
    // registered, so nothing is flagged.
    expect(result.ecosystems).toHaveLength(1);
    expect(result.ecosystems[0]!.status).toBe("ok");
    expect(result.ecosystems[0]!.unregistered).toEqual([]);
    expect(hasProjectRegistrationViolations(result)).toBe(false);
  });

  it("a project outside the solution's own directory tree is never flagged", async () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "Acme.sln"), slnContent([]));
    commitAll(repo, "add solution in sub/");
    mkdirSync(join(repo, "other"), { recursive: true });
    writeFileSync(join(repo, "other", "Foo.csproj"), CSPROJ);

    // LayoutConvention forced so this exercises the "chosen solution, but the
    // manifest sits outside its directory tree" path directly (not the
    // ancestor-search "no candidate at all" path — see the next test for that).
    const layoutConvention: LayoutConvention = {
      projectsDir: "sub",
      projectsCount: 3,
      projectManifestName: "<Name>.csproj",
      totalExamples: 3,
      solutionFile: "sub/Acme.sln",
    };

    const result = await checkProjectRegistration({ cwd: repo, baseline: null, layoutConvention });

    expect(result.ecosystems).toHaveLength(1);
    expect(result.ecosystems[0]!.status).toBe("ok");
    expect(result.ecosystems[0]!.unregistered).toEqual([]);
  });

  it("two solution files near the new project — ambiguous, never a guess", async () => {
    writeFileSync(join(repo, "One.sln"), slnContent([]));
    writeFileSync(join(repo, "Two.sln"), slnContent([]));
    commitAll(repo, "add two solutions");
    mkdirSync(join(repo, "src", "Foo"), { recursive: true });
    writeFileSync(join(repo, "src", "Foo", "Foo.csproj"), CSPROJ);

    const result = await checkProjectRegistration({ cwd: repo, baseline: null, layoutConvention: null });

    expect(result.ecosystems).toHaveLength(1);
    expect(result.ecosystems[0]!.status).toBe("ambiguous");
    expect(result.ecosystems[0]!.unregistered).toHaveLength(1);
    expect(result.ecosystems[0]!.unregistered[0]!.reason).toMatch(/ambiguous/);
    expect(hasProjectRegistrationViolations(result)).toBe(false);
  });

  it("no .sln anywhere in the repo — unsupported, never a violation", async () => {
    mkdirSync(join(repo, "src", "Foo"), { recursive: true });
    writeFileSync(join(repo, "src", "Foo", "Foo.csproj"), CSPROJ);
    // csproj stays untracked; nothing is ever committed as a solution.

    const result = await checkProjectRegistration({ cwd: repo, baseline: null, layoutConvention: null });

    expect(result.ecosystems).toHaveLength(1);
    expect(result.ecosystems[0]!.status).toBe("unsupported");
    expect(result.ecosystems[0]!.unregistered).toEqual([]);
    expect(hasProjectRegistrationViolations(result)).toBe(false);
  });

  it("a baseline with no gitCommit falls back to git status only, and still finds the violation", async () => {
    writeFileSync(join(repo, "Acme.sln"), slnContent([]));
    commitAll(repo, "add empty solution");
    mkdirSync(join(repo, "src", "src", "Acme.Widgets"), { recursive: true });
    writeFileSync(join(repo, "src", "src", "Acme.Widgets", "Acme.Widgets.csproj"), CSPROJ);

    const baseline = baselineWith({ gitCommit: null, cwd: repo });
    const result = await checkProjectRegistration({ cwd: repo, baseline, layoutConvention: null });

    expect(result.addedFilesSource).toBe("git-status-fallback");
    expect(result.note).toMatch(/gitCommit/);
    expect(result.ecosystems[0]!.status).toBe("violations");
  });

  it("a git failure is reported as status error, logged, and never a violation", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "s6-not-a-repo-"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const result = await checkProjectRegistration({ cwd: notARepo, baseline: null, layoutConvention: null });

      expect(result.error).toBeTruthy();
      expect(result.ecosystems).toHaveLength(1);
      expect(result.ecosystems[0]!.status).toBe("error");
      expect(hasProjectRegistrationViolations(result)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      rmSync(notARepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAddedFilesSinceBaseline — the git plumbing in isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAddedFilesSinceBaseline", () => {
  // The function's contract (per the acceptance review's note #4) is now
  // "new PROJECT MANIFESTS since baseline", not "every changed file" — the
  // manifest-type filter is applied here, before the bound, so an arbitrary
  // non-manifest file (a plain .txt) is correctly excluded from the result.
  it("subtracts files the baseline already recorded as dirty", async () => {
    mkdirSync(join(repo, "AlreadyDirty"), { recursive: true });
    writeFileSync(join(repo, "AlreadyDirty", "AlreadyDirty.csproj"), CSPROJ);
    mkdirSync(join(repo, "NewlyAdded"), { recursive: true });
    writeFileSync(join(repo, "NewlyAdded", "NewlyAdded.csproj"), CSPROJ);
    const baseline = baselineWith({ dirtyFiles: ["AlreadyDirty/AlreadyDirty.csproj"] });

    const res = await computeAddedFilesSinceBaseline(repo, baseline);

    expect(res.files).toContain("NewlyAdded/NewlyAdded.csproj");
    expect(res.files).not.toContain("AlreadyDirty/AlreadyDirty.csproj");
  });

  it("with no baseline at all, every currently dirty/untracked project manifest counts as added", async () => {
    mkdirSync(join(repo, "BrandNew"), { recursive: true });
    writeFileSync(join(repo, "BrandNew", "BrandNew.csproj"), CSPROJ);
    const res = await computeAddedFilesSinceBaseline(repo, null);
    expect(res.files).toContain("BrandNew/BrandNew.csproj");
    expect(res.source).toBe("git-status-fallback");
    expect(res.note).toMatch(/no baseline/);
  });

  it("a plain non-manifest file is excluded — the function's contract is manifests, not every changed file", async () => {
    writeFileSync(join(repo, "README-notes.txt"), "not a project manifest");
    const res = await computeAddedFilesSinceBaseline(repo, null);
    expect(res.files).not.toContain("README-notes.txt");
  });

  it("a file inside a build-output directory (BUILD_OUTPUT_DIRS) is excluded even if it happens to be manifest-named", async () => {
    mkdirSync(join(repo, "obj"), { recursive: true });
    writeFileSync(join(repo, "obj", "Ghost.csproj"), CSPROJ);
    const res = await computeAddedFilesSinceBaseline(repo, null);
    expect(res.files).not.toContain("obj/Ghost.csproj");
  });

  // Note #4 (acceptance review): the manifest-type filter must run BEFORE the
  // bound, not after — otherwise a flood of non-manifest files sorting ahead
  // of a real manifest could push it past the slice cutoff and make a genuine
  // new project invisible. `bin/` is the exact example named in the review:
  // it is deliberately NOT in `BUILD_OUTPUT_DIRS` (see language-registry.ts —
  // `bin` is a legitimate source directory in Node/Python repos), so the
  // directory filter alone cannot rescue this case; only filtering-before-
  // bounding by manifest type does. 2005 junk files exceeds the OLD
  // (pre-fix) bound of `MAX_NEW_MANIFESTS * 10` = 2000.
  it("a large un-ignored bin/ tree does not truncate a real new manifest out of the result", async () => {
    const junkDir = join(repo, "bin");
    mkdirSync(junkDir, { recursive: true });
    const JUNK_COUNT = 2005;
    for (let i = 0; i < JUNK_COUNT; i++) {
      writeFileSync(join(junkDir, `aaa${String(i).padStart(5, "0")}.dll`), "");
    }
    // Sorts AFTER every "bin/aaa....dll" junk entry alphabetically — exactly
    // the position a filter-after-bound implementation would have discarded.
    mkdirSync(join(repo, "zzz-real"), { recursive: true });
    writeFileSync(join(repo, "zzz-real", "Real.csproj"), CSPROJ);

    const res = await computeAddedFilesSinceBaseline(repo, null);

    expect(res.files).toContain("zzz-real/Real.csproj");
  }, 60_000);

  // Note #3 (acceptance review): a COMMITTED rename/copy must be treated as
  // "added at the new path" — the project is exactly as invisible to a stale
  // solution reference as a brand-new file would be, and `git diff --name-
  // status` reports it as `R###`/`C###`, never `A`, so the old "only A"
  // filter silently dropped it.
  it("a committed rename of an existing project is treated as added at its new path", async () => {
    mkdirSync(join(repo, "OldHome"), { recursive: true });
    writeFileSync(join(repo, "OldHome", "Widgets.csproj"), CSPROJ);
    commitAll(repo, "seed the project at its old path");
    const commit1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    mkdirSync(join(repo, "NewHome"), { recursive: true });
    git(repo, "mv", "OldHome/Widgets.csproj", "NewHome/Widgets.csproj");
    commitAll(repo, "move the project to its new path");

    const baseline = baselineWith({ gitCommit: commit1, dirtyFiles: [] });
    const res = await computeAddedFilesSinceBaseline(repo, baseline);

    expect(res.files).toContain("NewHome/Widgets.csproj");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatProjectRegistrationMustFix — the exact wording the fixer/nextFocus see
// ─────────────────────────────────────────────────────────────────────────────

describe("formatProjectRegistrationMustFix", () => {
  const violating: ProjectRegistrationCheckResult = {
    ecosystems: [
      {
        ecosystem: "C#",
        solutionFile: "Acme.sln",
        unregistered: [
          {
            manifest: "src/src/Acme.Widgets/Acme.Widgets.csproj",
            reason: 'not referenced by "Acme.sln"',
            solutionFile: "Acme.sln",
          },
        ],
        status: "violations",
      },
    ],
    addedFilesSource: "git-status-fallback",
    addedFilesCount: 1,
  };

  it("names the manifest and the solution, with a ready dotnet sln command", () => {
    const text = formatProjectRegistrationMustFix(violating);
    expect(text).toBe(
      "Register `src/src/Acme.Widgets/Acme.Widgets.csproj` in `Acme.sln` (e.g. `dotnet sln Acme.sln add src/src/Acme.Widgets/Acme.Widgets.csproj`).",
    );
  });

  it("is null when there is nothing to report", () => {
    const ok: ProjectRegistrationCheckResult = {
      ecosystems: [],
      addedFilesSource: "git-status-fallback",
      addedFilesCount: 0,
    };
    expect(formatProjectRegistrationMustFix(ok)).toBeNull();
    expect(formatProjectRegistrationMustFix(undefined)).toBeNull();
  });

  it("formatProjectRegistrationNote reports violations but stays silent on ok/unsupported", () => {
    expect(formatProjectRegistrationNote(violating)).toMatch(/Acme.sln/);
    const ok: ProjectRegistrationCheckResult = {
      ecosystems: [{ ecosystem: "C#", solutionFile: "Acme.sln", unregistered: [], status: "ok" }],
      addedFilesSource: "git-status-fallback",
      addedFilesCount: 0,
    };
    expect(formatProjectRegistrationNote(ok)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verify-fix-loop integration — a violation triggers the loop EVEN WHEN the
// floor passed, and its wording reaches the fixer prompt.
// ─────────────────────────────────────────────────────────────────────────────

function recipe(overrides: Partial<VerifyRecipe> = {}): VerifyRecipe {
  return {
    ecosystem: "dotnet",
    appKind: "service",
    appLabel: "app",
    shellInitCommands: [],
    bootstrapCommands: [],
    installCommands: [],
    buildCommands: [],
    testCommands: ["dotnet test"],
    smokeKind: "none",
    evidence: [],
    notes: [],
    coverage: 80,
    ...overrides,
  };
}

function outcome(overrides: Partial<VerifyPassOutcome> & Pick<VerifyPassOutcome, "verifyVerdict">): VerifyPassOutcome {
  return {
    verifyResult: { success: overrides.verifyVerdict === "PASS", output: "verify output" },
    recipeFromVerify: recipe(),
    ...overrides,
  };
}

const violatingStructureCheck: ProjectRegistrationCheckResult = {
  ecosystems: [
    {
      ecosystem: "C#",
      solutionFile: "Acme.sln",
      unregistered: [
        {
          manifest: "src/src/Acme.Widgets/Acme.Widgets.csproj",
          reason: 'not referenced by "Acme.sln"',
          solutionFile: "Acme.sln",
        },
      ],
      status: "violations",
    },
  ],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 1,
};

const cleanStructureCheck: ProjectRegistrationCheckResult = {
  ecosystems: [{ ecosystem: "C#", solutionFile: "Acme.sln", unregistered: [], status: "ok" }],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 1,
};

describe("computeVerifyFixTrigger — structureCheck (S6)", () => {
  it("triggers even though verify PASSED and the recipe reports real coverage", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: violatingStructureCheck,
    });
    expect(r.shouldRun).toBe(true);
    expect(r.identity?.failedCondition).toBe("engineering_floor");
    expect(r.identity?.reason).toBe("project_not_registered");
  });

  it("does not trigger when the structure check found nothing wrong", () => {
    const r = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: cleanStructureCheck,
    });
    expect(r.shouldRun).toBe(false);
  });

  it("absent structureCheck behaves byte-identically to before S6", () => {
    const withField = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
    });
    const withUndefinedField = computeVerifyFixTrigger({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: undefined,
    });
    expect(withField).toEqual(withUndefinedField);
    expect(withField.shouldRun).toBe(false);
  });
});

describe("buildFixPrompt — carries the project-registration must-fix text", () => {
  it("includes the exact register-in-solution wording", () => {
    const identity = deriveFailureIdentity({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: violatingStructureCheck,
    });
    const mustFix = formatProjectRegistrationMustFix(violatingStructureCheck);
    expect(mustFix).toBeTruthy();

    const prompt = buildFixPrompt({
      sprintN: 1,
      round: 1,
      identity,
      verifyTail: "",
      mustFix: mustFix ?? undefined,
      openTasks: [],
      planSynthesis: "the approved plan",
    });

    expect(prompt).toContain("=== MUST FIX ===");
    expect(prompt).toContain(
      "Register `src/src/Acme.Widgets/Acme.Widgets.csproj` in `Acme.sln` (e.g. `dotnet sln Acme.sln add src/src/Acme.Widgets/Acme.Widgets.csproj`).",
    );
  });
});

describe("runVerifyFixLoop end-to-end — a registration violation drives a real fix round", () => {
  it("triggers, dispatches a fixer, and stops once the re-check comes back clean", async () => {
    const initial = outcome({ verifyVerdict: "PASS", structureCheck: violatingStructureCheck });
    const fixed = outcome({ verifyVerdict: "PASS", structureCheck: cleanStructureCheck });
    let verifyPassCalls = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    async function* runVerifyPass(): AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
      verifyPassCalls++;
      return fixed;
    }
    const fixerCalls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      fixerCalls.push(req);
      return { success: true, output: "registered the project in the solution" };
    };

    const result = await (async () => {
      const gen = runVerifyFixLoop({
        sprintN: 1,
        planSynthesis: "the approved plan",
        openTasks: [],
        fixModelId: "fix-model",
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 2,
      });
      while (true) {
        const n = await gen.next();
        if (n.done) return n.value;
      }
    })();

    expect(result.triggered).toBe(true);
    expect(result.stopReason).toBe("pass");
    expect(fixerCalls).toHaveLength(1);
    expect(verifyPassCalls).toBe(1);
    expect(result.final.structureCheck?.ecosystems[0]?.status).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocker #2 (acceptance review) — the failure key must see PARTIAL progress.
//
// `deriveFailureIdentity` used to return `errorSet: []` for a registration
// violation, so registering 1 of 2 projects produced the SAME no-progress key
// as registering neither — the loop could not tell "getting better" from
// "stuck". Fixed: `errorSet` is now the sorted list of unregistered manifest
// paths, and a coexisting build failure's own errors are UNIONED with them
// (never one replacing the other) so neither side's progress can mask the
// other's.
// ─────────────────────────────────────────────────────────────────────────────

const twoViolations: ProjectRegistrationCheckResult = {
  ecosystems: [
    {
      ecosystem: "C#",
      solutionFile: "Acme.sln",
      unregistered: [
        { manifest: "src/A/A.csproj", reason: 'not referenced by "Acme.sln"', solutionFile: "Acme.sln" },
        { manifest: "src/B/B.csproj", reason: 'not referenced by "Acme.sln"', solutionFile: "Acme.sln" },
      ],
      status: "violations",
    },
  ],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 2,
};

const oneViolationLeft: ProjectRegistrationCheckResult = {
  ecosystems: [
    {
      ecosystem: "C#",
      solutionFile: "Acme.sln",
      unregistered: [{ manifest: "src/B/B.csproj", reason: 'not referenced by "Acme.sln"', solutionFile: "Acme.sln" }],
      status: "violations",
    },
  ],
  addedFilesSource: "git-status-fallback",
  addedFilesCount: 2,
};

describe("deriveFailureIdentity — errorSet reflects partial registration progress (blocker #2)", () => {
  it("errorSet is the sorted unregistered manifest paths, not an empty array", () => {
    const identity = deriveFailureIdentity({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: twoViolations,
    });
    expect(identity.reason).toBe("project_not_registered");
    expect(identity.errorSet).toEqual(["src/A/A.csproj", "src/B/B.csproj"]);
  });

  it("registering one of two projects narrows errorSet and changes the no-progress key", () => {
    const before = deriveFailureIdentity({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: twoViolations,
    });
    const after = deriveFailureIdentity({
      verifyVerdict: "PASS",
      recipe: recipe({ coverage: 80 }),
      verifyOutput: "",
      structureCheck: oneViolationLeft,
    });
    expect(after.errorSet).toEqual(["src/B/B.csproj"]);
    expect(computeFailureKey(before)).not.toBe(computeFailureKey(after));
  });

  it("a coexisting build failure: reason names both, errorSet is the union of the build's own errors and the unregistered paths", () => {
    const buildFloor: FloorDelta = {
      verdict: "fail",
      failureKind: "build-failed",
      failedCommand: "dotnet build",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: true,
      buildAttribution: "run-introduced",
      rule: "delta",
      runIdVerified: true,
    };
    const floorChecks: FloorCheck[] = [
      {
        kind: "build",
        command: "dotnet build",
        exitCode: 1,
        ok: false,
        timedOut: false,
        outputTail: "",
        elapsedMs: 10,
        errorSet: ["error NU1107: version conflict"],
      },
    ];
    const identity = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: buildFloor,
      floorChecks,
      recipe: recipe(),
      verifyOutput: "",
      structureCheck: oneViolationLeft,
    });
    expect(identity.reason).toBe("build_run_introduced+project_not_registered");
    expect(identity.errorSet).toEqual(["error NU1107: version conflict", "src/B/B.csproj"]);
  });

  it("a build failure the floor could only call pre-existing never blends into the identity, even when a structure violation is also present", () => {
    const preExistingBuildFloor: FloorDelta = {
      verdict: "fail",
      failureKind: "build-failed",
      failedCommand: "dotnet build",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: true,
      buildAttribution: "pre-existing",
      rule: "delta",
      runIdVerified: true,
    };
    const identity = deriveFailureIdentity({
      verifyVerdict: "FAIL",
      floorDelta: preExistingBuildFloor,
      recipe: recipe(),
      verifyOutput: "",
      structureCheck: oneViolationLeft,
    });
    // Pure structure identity — no "build_..." prefix, no build errorSet mixed in.
    expect(identity.reason).toBe("project_not_registered");
    expect(identity.errorSet).toEqual(["src/B/B.csproj"]);
  });
});

describe("computeVerifyFixTrigger — a pre-existing build excused, but a registration violation still triggers", () => {
  it("shouldRun is true (not the pre_existing_build_only skip) when structure is violated alongside an excused build", () => {
    const preExistingBuildFloor: FloorDelta = {
      verdict: "fail",
      failureKind: "build-failed",
      failedCommand: "dotnet build",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: true,
      buildAttribution: "pre-existing",
      rule: "delta",
      runIdVerified: true,
    };
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: preExistingBuildFloor,
      recipe: recipe(),
      verifyOutput: "",
      structureCheck: oneViolationLeft,
    });
    expect(r.shouldRun).toBe(true);
    expect(r.skippedReason).toBeUndefined();
    expect(r.identity?.reason).toBe("project_not_registered");
  });

  it("still skips (pre_existing_build_only) when the build is excused and structure is clean", () => {
    const preExistingBuildFloor: FloorDelta = {
      verdict: "fail",
      failureKind: "build-failed",
      failedCommand: "dotnet build",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: true,
      buildAttribution: "pre-existing",
      rule: "delta",
      runIdVerified: true,
    };
    const r = computeVerifyFixTrigger({
      verifyVerdict: "FAIL",
      floorDelta: preExistingBuildFloor,
      recipe: recipe(),
      verifyOutput: "",
    });
    expect(r.shouldRun).toBe(false);
    expect(r.skippedReason).toBe("pre_existing_build_only");
  });
});

describe("runVerifyFixLoop end-to-end — partial progress is never mistaken for no progress (blocker #2)", () => {
  /** Sequences fixed VerifyPassOutcomes, one per call — mirrors verify-fix-loop.test.ts's own local helper. */
  function sequencePass(
    ...outcomes: VerifyPassOutcome[]
  ): (roundLabel: string) => AsyncGenerator<StreamChunk, VerifyPassOutcome, unknown> {
    let i = 0;
    // biome-ignore lint/correctness/useYield: test stub never needs to yield a StreamChunk
    return async function* gen() {
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      return next as VerifyPassOutcome;
    };
  }

  async function drainLoop<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R> {
    while (true) {
      const n = await gen.next();
      if (n.done) return n.value;
    }
  }

  it("2 unregistered projects: fixer registers 1, the loop continues (not no_progress), fixer registers the other, pass", async () => {
    const initial = outcome({ verifyVerdict: "PASS", structureCheck: twoViolations });
    const afterRound1 = outcome({ verifyVerdict: "PASS", structureCheck: oneViolationLeft });
    const afterRound2 = outcome({ verifyVerdict: "PASS", structureCheck: cleanStructureCheck });
    const runVerifyPass = sequencePass(afterRound1, afterRound2);
    const fixerCalls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      fixerCalls.push(req);
      return { success: true, output: "registered one project" };
    };

    const result = await drainLoop(
      runVerifyFixLoop({
        sprintN: 1,
        planSynthesis: "the approved plan",
        openTasks: [],
        fixModelId: "fix-model",
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 3,
      }),
    );

    expect(result.stopReason).toBe("pass");
    expect(result.rounds).toHaveLength(2);
    expect(fixerCalls).toHaveLength(2);
    // Round 1 must NOT be recorded as no-progress — the key changed because
    // the errorSet narrowed from 2 manifests to 1.
    expect(result.rounds[0]!.failureKeyBefore).not.toBe(result.rounds[0]!.failureKeyAfter);
  });

  it("a build failure and a registration violation coexist: fixing the build alone is read as progress, not masked by the still-open violation", async () => {
    const buildFloor: FloorDelta = {
      verdict: "fail",
      failureKind: "build-failed",
      failedCommand: "dotnet build",
      newlyFailing: [],
      preExisting: [],
      fixed: [],
      buildAlreadyBroken: true,
      buildAttribution: "run-introduced",
      rule: "delta",
      runIdVerified: true,
    };
    const initial = outcome({ verifyVerdict: "FAIL", floorDelta: buildFloor, structureCheck: oneViolationLeft });
    // Round 1: the build is fixed (floor now passes, no floorDelta), but the
    // project is STILL unregistered.
    const buildFixedStructureStillOpen = outcome({ verifyVerdict: "PASS", structureCheck: oneViolationLeft });
    // Round 2: the project is registered too.
    const bothFixed = outcome({ verifyVerdict: "PASS", structureCheck: cleanStructureCheck });
    const runVerifyPass = sequencePass(buildFixedStructureStillOpen, bothFixed);
    const fixerCalls: TaskRequest[] = [];
    const runIsolatedTask = async (req: TaskRequest): Promise<ToolResult> => {
      fixerCalls.push(req);
      return { success: true, output: "fixed one of the two problems" };
    };

    const result = await drainLoop(
      runVerifyFixLoop({
        sprintN: 1,
        planSynthesis: "the approved plan",
        openTasks: [],
        fixModelId: "fix-model",
        runIsolatedTask,
        initial,
        runVerifyPass,
        maxRounds: 3,
      }),
    );

    expect(result.stopReason).toBe("pass");
    expect(result.rounds).toHaveLength(2);
    expect(fixerCalls).toHaveLength(2);
    // Round 1's key must differ from the initial key (build fix recognized as
    // progress) even though the structure violation alone would, on its own,
    // reproduce the SAME reason string every round.
    expect(result.rounds[0]!.failureKeyBefore).not.toBe(result.rounds[0]!.failureKeyAfter);
  });
});

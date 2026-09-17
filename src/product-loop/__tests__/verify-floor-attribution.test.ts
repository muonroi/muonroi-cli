/**
 * S5 — honest attribution for a build break that was ALSO red at baseline.
 *
 * ## The bug this closes
 *
 * Run `mu54vrme4c87`'s verify floor told sprint 2 that a build break was "not
 * this run's doing":
 *
 *   [verify-floor] Deterministic verify floor FAILED — the build/typecheck
 *   gate failed, and it was ALREADY failing at baseline. This is not this
 *   run's doing — but nothing can be verified on a broken build, so the floor
 *   cannot open until it is fixed.
 *
 * The break was in fact the run's own doing: `Microsoft.CodeAnalysis.CSharp`
 * was downgraded 4.14.0 -> 4.8.0 in `Directory.Packages.props`, producing an
 * NU1107. The baseline that "excused" it recorded `gitCommit: null` (a
 * resolvable HEAD, `f812759`, silently lost) and `gitDirty: true` with no
 * record of WHAT was dirty or what its build actually printed — so the old
 * binary `buildOk === false -> always pre-existing` rule had nothing to
 * compare against and excused it anyway.
 *
 * This file proves, with synthetic fixtures modeled on that evidence (no
 * company names): the 3-way attribution rule in `attributeBuildFailure`
 * (`verify-baseline.ts`), the `gitCommit`-capture fix + its logging in
 * `readGitIdentity` (`verify-floor.ts`), and the end-to-end wiring through
 * `runVerifyFloor` + `describeBuildMustFix`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import {
  attributeBuildFailure,
  describeBuildMustFix,
  extractErrorSet,
  type FloorCheckLike,
  type FloorDelta,
  VERIFY_BASELINE_VERSION,
  type VerifyBaseline,
  type VerifyBaselineCommandResult,
} from "../verify-baseline.js";
import { captureVerifyFloorBaseline, readGitIdentity, runVerifyFloor } from "../verify-floor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic dotnet-style fixtures, modeled on the mu54vrme4c87 evidence.
// ─────────────────────────────────────────────────────────────────────────────

const NU1107_SAMPLE =
  "C:\\repo\\src\\Sample.csproj : error NU1107: Version conflict detected for Sample.CodeAnalysis. " +
  "Install/reference Sample.CodeAnalysis 4.14.0 directly to project Sample to resolve this issue.";

const CS0103_LEGACY =
  "C:\\repo\\src\\Legacy.cs(10,5): error CS0103: the name 'Baz' does not exist in the current context";

function baselineWith(overrides: Partial<VerifyBaseline>): VerifyBaseline {
  return {
    version: VERIFY_BASELINE_VERSION,
    runId: "run-A",
    capturedAtUtc: new Date().toISOString(),
    cwd: "/tmp/x",
    gitCommit: "abc123",
    gitBranch: "main",
    gitDirty: true,
    commands: { build: ["dotnet build"], test: [] },
    buildOk: false,
    failingTests: [],
    results: [],
    unattributable: false,
    ...overrides,
  };
}

function buildResult(rawOutput: string): VerifyBaselineCommandResult {
  return {
    kind: "build",
    command: "dotnet build",
    exitCode: 1,
    ok: false,
    failingTests: [],
    formats: [],
    errorSet: extractErrorSet(rawOutput),
  };
}

function buildCheck(rawOutput: string): FloorCheckLike {
  return {
    kind: "build",
    command: "dotnet build",
    ok: false,
    exitCode: 1,
    timedOut: false,
    errorSet: extractErrorSet(rawOutput),
    outputTail: rawOutput,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// attributeBuildFailure — the 3-way rule (pure, no IO)
// ─────────────────────────────────────────────────────────────────────────────

describe("attributeBuildFailure — honest 3-way attribution", () => {
  it("a dirty OLD-FORMAT baseline (no stored signature at all) is UNATTRIBUTABLE — not excused", () => {
    // `results: []` mirrors every baseline written before errorSet existed:
    // there is no build result to read a signature from.
    const baseline = baselineWith({ gitDirty: true, results: [] });
    const current = buildCheck(NU1107_SAMPLE);
    expect(attributeBuildFailure(current, baseline, null)).toBe("unattributable");
  });

  it("a NEW error versus the baseline's recorded signature is RUN-INTRODUCED", () => {
    const baseline = baselineWith({ gitDirty: true, results: [buildResult(CS0103_LEGACY)] });
    const current = buildCheck(NU1107_SAMPLE);
    expect(attributeBuildFailure(current, baseline, null)).toBe("run-introduced");
  });

  it("an IDENTICAL error set (same failure, same baseline) is PRE-EXISTING", () => {
    const baseline = baselineWith({ gitDirty: true, results: [buildResult(NU1107_SAMPLE)] });
    const current = buildCheck(NU1107_SAMPLE);
    expect(attributeBuildFailure(current, baseline, null)).toBe("pre-existing");
  });

  it("a CLEAN baseline (gitDirty: false) is PRE-EXISTING regardless of signature", () => {
    const baseline = baselineWith({ gitDirty: false, results: [] });
    const current = buildCheck(NU1107_SAMPLE);
    expect(attributeBuildFailure(current, baseline, null)).toBe("pre-existing");
  });

  it("no stored signature, but the failure NAMES a file this run changed, is RUN-INTRODUCED", () => {
    const baseline = baselineWith({ gitDirty: true, results: [] });
    const mentionsChangedFile =
      "C:\\repo\\src\\Sample.csproj : error NU1107: Version conflict detected — see src\\Directory.Packages.props";
    const current = buildCheck(mentionsChangedFile);
    expect(attributeBuildFailure(current, baseline, ["src/Directory.Packages.props"])).toBe("run-introduced");
  });

  it("no stored signature, and nothing names a run-changed file, stays UNATTRIBUTABLE", () => {
    const baseline = baselineWith({ gitDirty: true, results: [] });
    const current = buildCheck(NU1107_SAMPLE);
    expect(attributeBuildFailure(current, baseline, ["src/some/other/file.cs"])).toBe("unattributable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeBuildMustFix — the S3b-style carry-over item
// ─────────────────────────────────────────────────────────────────────────────

describe("describeBuildMustFix — must-fix carry-over, only for the two dishonest-before cases", () => {
  const deltaWith = (overrides: Partial<FloorDelta>): FloorDelta => ({
    verdict: "fail",
    newlyFailing: [],
    preExisting: [],
    fixed: [],
    buildAlreadyBroken: true,
    rule: "delta",
    runIdVerified: true,
    failureKind: "build-failed",
    failedCommand: "dotnet build",
    ...overrides,
  });

  it("returns null for pre-existing — genuinely not this run's doing", () => {
    expect(describeBuildMustFix(deltaWith({ buildAttribution: "pre-existing" }))).toBeNull();
  });

  it("returns a must-fix line for run-introduced, naming the failed command", () => {
    const note = describeBuildMustFix(deltaWith({ buildAttribution: "run-introduced" }));
    expect(note).toContain("dotnet build");
    expect(note).toContain("this run introduced its own break");
  });

  it("returns a must-fix line for unattributable", () => {
    const note = describeBuildMustFix(deltaWith({ buildAttribution: "unattributable" }));
    expect(note).toContain("not enough evidence to rule this run out");
  });

  it("returns null for the plain BROKE-THE-BUILD case (buildAlreadyBroken: false) — already an ordinary FAIL", () => {
    expect(describeBuildMustFix(deltaWith({ buildAlreadyBroken: false, buildAttribution: undefined }))).toBeNull();
  });

  it("returns null for a non-build failure kind", () => {
    expect(
      describeBuildMustFix(deltaWith({ failureKind: "test-regression", buildAttribution: "run-introduced" })),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readGitIdentity — the gitCommit: null bug and its silent swallow
// ─────────────────────────────────────────────────────────────────────────────

describe("readGitIdentity — captures gitCommit and no longer swallows git failures silently", () => {
  let repo: string;

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "s5-readgit-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "s5@test.local");
    git("config", "user.name", "S5 fixture");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("captures gitCommit when HEAD resolves — the exact value HEAD rev-parses to", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const id = readGitIdentity(repo);
    expect(id.commit).toBe(head);
    expect(id.branch).toBe("main");
    expect(id.dirty).toBe(false);
    expect(id.dirtyFiles).toEqual([]);
  });

  it("a git failure is LOGGED, not silently swallowed", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    // A directory that is not a git repository at all: `git rev-parse HEAD`
    // exits non-zero here — the exact failure shape that used to return null
    // with no log line at all (only a thrown spawnSync exception was logged,
    // and spawnSync reports failure via res.error/res.status, not by throwing).
    const notARepo = mkdtempSync(join(tmpdir(), "s5-readgit-not-a-repo-"));
    try {
      const id = readGitIdentity(notARepo);
      expect(id.commit).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const loggedRevParseFailure = warnSpy.mock.calls.some(
        ([, msg]) => typeof msg === "string" && msg.includes("readGitIdentity") && msg.includes("rev-parse"),
      );
      expect(loggedRevParseFailure).toBe(true);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end through runVerifyFloor — a real git repo, a real `npm run build`.
// ─────────────────────────────────────────────────────────────────────────────

describe("runVerifyFloor — honest attribution end-to-end (replays the mu54vrme4c87 shape)", () => {
  let repo: string;
  let baselinePath: string;

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  }

  function writeBuildCfg(code: string, message: string): void {
    writeFileSync(join(repo, "buildcfg.json"), JSON.stringify({ code, message }), "utf8");
  }

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s5-e2e-"));
    baselinePath = join(repo, "verify-baseline.json");

    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "s5-fixture", version: "0.0.0", private: true, scripts: { build: "node build.js" } }),
      "utf8",
    );
    writeFileSync(
      join(repo, "build.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'buildcfg.json'), 'utf8'));",
        "console.error('error ' + cfg.code + ': ' + cfg.message);",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    writeBuildCfg("CS0103", "legacy baseline issue in Legacy.cs");
    writeFileSync(join(repo, "README.md"), "seed\n", "utf8");

    git("init", "-q", "-b", "main");
    git("config", "user.email", "s5@test.local");
    git("config", "user.name", "S5 fixture");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    // Dirty an UNRELATED file so the baseline is captured on a dirty tree —
    // exactly like mu54vrme4c87, where an earlier run's leftover breakage was
    // still present. This exercises the error-set comparison, not the trivial
    // gitDirty===false shortcut.
    writeFileSync(join(repo, "README.md"), "seed\ndirty\n", "utf8");

    await captureVerifyFloorBaseline({ cwd: repo, runId: "run-A", baselinePath });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("captures a baseline with a real gitCommit and recorded dirty state", async () => {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(baselinePath, "utf8"));
    const baseline = JSON.parse(raw) as VerifyBaseline;
    expect(baseline.gitCommit).not.toBeNull();
    expect(baseline.gitDirty).toBe(true);
    expect(baseline.dirtyFiles).toEqual(["README.md"]);
    expect(baseline.buildOk).toBe(false);
    expect(baseline.results[0]?.errorSet).toEqual(expect.arrayContaining([expect.stringContaining("CS0103")]));
  });

  it("a DIFFERENT build error than the baseline's is RUN-INTRODUCED, not excused as inherited", async () => {
    // This run's own edit: a NEW error the baseline never saw, naming a file
    // the run itself changed (buildcfg.json — not in the baseline's dirty set).
    writeBuildCfg("NU1107", "Version conflict detected for Sample.CodeAnalysis in Directory.Packages.props");

    const res = await runVerifyFloor({ cwd: repo, forceEnable: true, baselinePath, runId: "run-A" });

    expect(res.verdict).toBe("fail");
    expect(res.delta?.failureKind).toBe("build-failed");
    expect(res.delta?.buildAlreadyBroken).toBe(true);
    expect(res.delta?.buildAttribution).toBe("run-introduced");
    expect(res.detail).toContain("this run introduced its own break");
    // The old byte-identical "not this run's doing" sentence must NOT appear
    // for this case — that was the exact bug.
    expect(res.detail).not.toContain("This is not this run's doing");
    expect(describeBuildMustFix(res.delta!)).toContain("Fix it before the next sprint can be verified.");
  });

  it("the SAME build error as the baseline's is PRE-EXISTING, with the byte-identical message", async () => {
    // No further edit — the tree is still dirty in exactly the way the
    // baseline captured. This is the true pre-existing case.
    const res = await runVerifyFloor({ cwd: repo, forceEnable: true, baselinePath, runId: "run-A" });

    expect(res.verdict).toBe("fail");
    expect(res.delta?.buildAttribution).toBe("pre-existing");
    expect(res.detail).toContain(
      "the build/typecheck gate failed, and it was ALREADY failing at baseline. This is not this run's doing — but nothing can be verified on a broken build, so the floor cannot open until it is fixed.",
    );
    expect(describeBuildMustFix(res.delta!)).toBeNull();
  });
});

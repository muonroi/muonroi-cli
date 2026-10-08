/**
 * The baseline is the artifact that decides whether a failure is BLAMED on this
 * run or EXCUSED as inherited. These tests pin that a turn operating on the
 * project cannot author it, and that when someone else writes to the in-tree
 * path the reported reason names what actually happened.
 *
 * ## The measured incident these tests are built from
 *
 * `/ideal` run `muc2joffe506` in `D:\sources\CompanyLibs\qa-platform`. During
 * sprint 2's implementation stage a sub-agent authored a project script
 * (`verify.mjs`) whose report destination was
 *
 *     path.join(process.cwd(), ".muonroi-flow", "runs", "muc2joffe506", "verify-baseline.json")
 *
 * — the floor's own baseline path, with this run's id hardcoded — and committed
 * it to the project. Every later invocation of the project's verify command
 * (`node verify.mjs`) overwrote the baseline with its own 176-byte report. The
 * last one landed at `2026-09-24T06:53:58.576Z`, inside sprint 2's verification
 * window, and `sprints/2-verify.md` then recorded
 *
 *     Rule applied: ABSOLUTE (fail-closed) — the baseline file could not be read
 *     or parsed.
 *
 * Two defects, both pinned below:
 *
 *  A. Damage was limited only by the foreign file having the WRONG SHAPE. It
 *     carried the RIGHT `runId` and the right `version`. A file with the right
 *     shape and a fabricated `failingTests` list would have been ACCEPTED, and
 *     every real regression in the run excused as pre-existing.
 *  B. That file read and parsed perfectly. It was rejected on SHAPE. The
 *     sentence blamed an IO/parse failure that never happened, so the one
 *     symptom that would have told the user their baseline was clobbered was
 *     reported as something else entirely.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerifyBaseline } from "../verify-baseline.js";
import { captureVerifyFloorBaseline, runVerifyFloor } from "../verify-floor.js";

/** Same fake runner the delta tests use: `fail.json` names who fails. */
const RUNNER = `const fs = require("node:fs");
const path = require("node:path");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "fail.json"), "utf8"));
for (const n of names) console.log("[xUnit.net 00:00:01.00]     " + n + " [FAIL]");
console.log("Total tests: " + (names.length + 10));
process.exit(names.length ? 1 : 0);
`;

const PRE_EXISTING = ["Acme.Tests.AlreadyRed.WasFailingBeforeTheRun"];
const REGRESSION = "Acme.Tests.NewRuleTests.ThisRunBrokeIt";

const TEST_CMD = "node runner.cjs";
const OK_BUILD = 'node -e "process.exit(0)"';
const RUN_ID = "run-integrity";

/**
 * The foreign file's EXACT bytes, copied from
 * `qa-platform/.muonroi-flow/runs/muc2joffe506/verify-baseline.json` (176 bytes).
 * Written by the project's own `verify.mjs`, not by this codebase —
 * `tsFilesScanned` and `linesScanned` appear nowhere in this repository, and the
 * values 48 / 5412 match that script's stdout verbatim.
 */
const FOREIGN_176_BYTES = `{
  "version": 1,
  "runId": "muc2joffe506",
  "verifiedAt": "2026-09-24T06:53:58.576Z",
  "tsFilesScanned": 48,
  "linesScanned": 5412,
  "verdict": "PASS",
  "failures": []
}`;

/**
 * A real, correctly-shaped baseline from this machine, keys copied verbatim from
 * `tcis-libraries/.muonroi-flow/runs/muauw6u93e1c/verify-baseline.json`. Written
 * by an older process with no witness beside it, so it must keep loading.
 */
const HISTORICAL_KEYS = [
  "version",
  "runId",
  "capturedAtUtc",
  "cwd",
  "gitCommit",
  "gitBranch",
  "gitDirty",
  "dirtyFiles",
  "dirtyDiffHash",
  "commands",
  "buildOk",
  "failingTests",
  "results",
  "unattributable",
  "elapsedMs",
] as const;

let cwd: string;
let outside: string;

const inTreeAt = () => join(cwd, "verify-baseline.json");
/** Deliberately outside `cwd` — a turn operating on the project cannot compute it. */
const witnessAt = () => join(outside, `${RUN_ID}.json`);

const commands = () => ({ build: [OK_BUILD], test: [TEST_CMD] });

function setFailing(names: string[]): void {
  writeFileSync(join(cwd, "fail.json"), JSON.stringify(names), "utf8");
}

async function capture() {
  return captureVerifyFloorBaseline({
    cwd,
    runId: RUN_ID,
    baselinePath: inTreeAt(),
    witnessPath: witnessAt(),
    commandsOverride: commands(),
  });
}

async function floor(opts: { witnessPath?: string | null; baselinePath?: string | null } = {}) {
  return runVerifyFloor({
    cwd,
    forceEnable: true,
    commandsOverride: commands(),
    baselinePath: opts.baselinePath === undefined ? inTreeAt() : opts.baselinePath,
    witnessPath: opts.witnessPath === undefined ? witnessAt() : opts.witnessPath,
    runId: RUN_ID,
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "floor-integrity-"));
  outside = mkdtempSync(join(tmpdir(), "floor-witness-"));
  writeFileSync(join(cwd, "runner.cjs"), RUNNER, "utf8");
  setFailing(PRE_EXISTING);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect A — a turn-authored baseline must not be able to excuse a regression
// ─────────────────────────────────────────────────────────────────────────────

describe("verify baseline — a turn-authored file at the baseline path cannot excuse a regression", () => {
  it("FAILS on the regression even though the in-tree file authorises it", async () => {
    const { baseline } = await capture();

    // The attack the incident got one field away from: right shape, right
    // version, right runId, right cwd, right command set — and a fabricated
    // `failingTests` naming the failure this run is about to introduce.
    const forged: VerifyBaseline = {
      ...baseline,
      failingTests: [...PRE_EXISTING, REGRESSION].sort(),
      results: baseline.results.map((r) =>
        r.kind === "test" ? { ...r, failingTests: [...PRE_EXISTING, REGRESSION].sort() } : r,
      ),
    };
    writeFileSync(inTreeAt(), JSON.stringify(forged, null, 2), "utf8");

    setFailing([...PRE_EXISTING, REGRESSION]);
    const res = await floor();

    expect(res.verdict).toBe("fail");
    expect(res.delta?.failureKind).toBe("test-regression");
    expect(res.delta?.newlyFailing).toEqual([REGRESSION]);
    // The genuinely pre-existing failure is still excused — the fix must not
    // reinstate the absolute gate through the back door.
    expect(res.delta?.rule).toBe("delta");
    expect(res.delta?.preExisting).toEqual([...PRE_EXISTING]);
  });

  it("keeps a copy at the in-tree path for a human to read", async () => {
    const { path: inTree, witnessPath } = await capture();
    expect(inTree).toBe(inTreeAt());
    expect(witnessPath).toBe(witnessAt());
    const onDisk = JSON.parse(readFileSync(inTree, "utf8")) as VerifyBaseline;
    expect(onDisk.runId).toBe(RUN_ID);
    expect(onDisk.failingTests).toEqual([...PRE_EXISTING]);
  });

  it("still PASSES a run whose only failures were already failing, from the witness alone", async () => {
    await capture();
    // Delete the in-tree copy entirely: the verdict must not depend on it.
    rmSync(inTreeAt(), { force: true });

    const res = await floor();
    expect(res.verdict).toBe("pass");
    expect(res.delta?.rule).toBe("delta");
    expect(res.delta?.preExisting).toEqual([...PRE_EXISTING]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect B — the reported reason must be the one that actually happened
// ─────────────────────────────────────────────────────────────────────────────

describe("verify baseline — the reported reason names what actually happened", () => {
  it("does NOT blame an IO/parse failure for the real 176-byte foreign file", async () => {
    // No witness: exactly the incident's situation, where the in-tree file was
    // the only thing the floor had to go on.
    writeFileSync(inTreeAt(), FOREIGN_176_BYTES, "utf8");
    setFailing([...PRE_EXISTING, REGRESSION]);

    const res = await floor({ witnessPath: null });

    expect(res.verdict).toBe("fail");
    expect(res.delta?.rule).toBe("absolute");
    // The file read and parsed perfectly. It was rejected on SHAPE.
    expect(res.delta?.rejectReason).toBe("shape-mismatch");
    expect(res.detail).not.toContain("could not be read or parsed");
    // And the sentence has to be actionable: name the fields, and say that
    // something other than this gate wrote the file.
    expect(res.detail).toContain("commands");
    expect(res.detail).toContain("failingTests");
    expect(res.detail.toLowerCase()).toContain("not written by this gate");
  });

  it("still reports `unreadable` for bytes that genuinely do not parse", async () => {
    writeFileSync(inTreeAt(), "{ not json", "utf8");
    setFailing([...PRE_EXISTING, REGRESSION]);

    const res = await floor({ witnessPath: null });
    expect(res.delta?.rejectReason).toBe("unreadable");
    expect(res.detail).toContain("could not be read or parsed");
  });

  it("names the clobber when the in-tree copy is foreign but the witness carries the verdict", async () => {
    await capture();
    writeFileSync(inTreeAt(), FOREIGN_176_BYTES, "utf8");

    const res = await floor();

    // The witness is intact, so the run is judged on real evidence …
    expect(res.verdict).toBe("pass");
    expect(res.delta?.rule).toBe("delta");
    // … but the user must be told their readable copy was overwritten, and by
    // what kind of thing, or they will never find the script doing it.
    expect(res.delta?.tamper?.kind).toBe("foreign");
    expect(res.detail).toContain(inTreeAt());
    expect(res.detail.toLowerCase()).toContain("not written by this gate");
  });

  it("names the clobber when the in-tree copy is a baseline that disagrees with the witness", async () => {
    const { baseline } = await capture();
    const forged: VerifyBaseline = { ...baseline, failingTests: [...PRE_EXISTING, REGRESSION].sort() };
    writeFileSync(inTreeAt(), JSON.stringify(forged, null, 2), "utf8");

    const res = await floor();

    expect(res.delta?.tamper?.kind).toBe("clobbered");
    expect(res.detail.toLowerCase()).toContain("not written by this gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two things that must keep working
// ─────────────────────────────────────────────────────────────────────────────

describe("verify baseline — the escape hatch and older records keep working", () => {
  it("lets MUONROI_SPRINT_FLOOR_BASELINE override even when a witness exists", async () => {
    await capture();

    // A baseline the USER points at, holding a failure set the witness does not
    // have. Their explicit override must win over the gate's own witness.
    const mine = join(outside, "mine.json");
    const theirs: VerifyBaseline = {
      ...(JSON.parse(readFileSync(witnessAt(), "utf8")) as VerifyBaseline),
      failingTests: [...PRE_EXISTING, REGRESSION].sort(),
    };
    writeFileSync(mine, JSON.stringify(theirs, null, 2), "utf8");

    setFailing([...PRE_EXISTING, REGRESSION]);

    const prev = process.env.MUONROI_SPRINT_FLOOR_BASELINE;
    process.env.MUONROI_SPRINT_FLOOR_BASELINE = mine;
    try {
      const res = await runVerifyFloor({
        cwd,
        forceEnable: true,
        commandsOverride: commands(),
        baselinePath: inTreeAt(),
        witnessPath: witnessAt(),
        runId: RUN_ID,
      });
      expect(res.verdict).toBe("pass");
      expect(res.delta?.rule).toBe("delta");
      expect(res.delta?.baselineSource).toBe("env");
      expect(res.detail).toContain("MUONROI_SPRINT_FLOOR_BASELINE");
    } finally {
      if (prev === undefined) delete process.env.MUONROI_SPRINT_FLOOR_BASELINE;
      else process.env.MUONROI_SPRINT_FLOOR_BASELINE = prev;
    }
  });

  it("still loads a correctly-shaped historical baseline that has no witness", async () => {
    // Keys copied verbatim from run muauw6u93e1c's record on this machine.
    const historical: Record<string, unknown> = {
      version: 1,
      runId: RUN_ID,
      capturedAtUtc: "2026-09-21T06:41:54.016Z",
      cwd,
      gitCommit: "e4da0705637fdce927ac1fa799b541dc4d2f9580",
      gitBranch: null,
      gitDirty: true,
      dirtyFiles: [".muonroi-cli/", ".muonroi-flow/"],
      dirtyDiffHash: null,
      commands: commands(),
      buildOk: true,
      failingTests: [...PRE_EXISTING],
      results: [
        { kind: "build", command: OK_BUILD, exitCode: 0, ok: true, failingTests: [], formats: [] },
        { kind: "test", command: TEST_CMD, exitCode: 1, ok: false, failingTests: [...PRE_EXISTING], formats: [] },
      ],
      unattributable: false,
      elapsedMs: 36474,
    };
    expect(Object.keys(historical)).toEqual([...HISTORICAL_KEYS]);
    writeFileSync(inTreeAt(), JSON.stringify(historical, null, 2), "utf8");

    const res = await floor({ witnessPath: null });

    expect(res.verdict).toBe("pass");
    expect(res.delta?.rule).toBe("delta");
    expect(res.delta?.baselineSource).toBe("in-tree");
    expect(res.delta?.preExisting).toEqual([...PRE_EXISTING]);
  });

  it("says the in-tree record was trusted without a witness, rather than implying it was verified", async () => {
    const { baseline } = await capture();
    rmSync(witnessAt(), { force: true });
    writeFileSync(inTreeAt(), JSON.stringify(baseline, null, 2), "utf8");

    const res = await floor();
    expect(res.verdict).toBe("pass");
    expect(res.delta?.baselineSource).toBe("in-tree");
    expect(res.detail).toContain("inside the working tree the run itself edits");
  });
});

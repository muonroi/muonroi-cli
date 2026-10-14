/**
 * "Could not run the tests" and "the tests failed" are different facts.
 *
 * The floor had ONE bucket for both. A test command whose runner is not
 * installed exits non-zero and names no failing test, so `computeFloorDelta`
 * reported `test-unattributable` / `test-absolute-no-baseline` — i.e. it blamed
 * the project's tests for a missing dependency.
 *
 * This is reachable in production. The floor deliberately does NOT run
 * `installCommands` (verify-floor.ts:34-40: they "are environment setup, not
 * gates"), and it runs COLD on at least three paths:
 *
 *   1. `captureVerifyFloorBaseline`, via `captureBaselineWithProgress`
 *      (phase-runner.ts:501-515) — "ONCE, before any phase mutates the tree",
 *      so before the verify sub-agent has ever run. Guaranteed cold, every run.
 *   2. `MUONROI_SPRINT_SKIP_VERIFY=1` (sprint-runner.ts:2564) — the sub-agent is
 *      replaced by a synthetic PASS and the floor still executes.
 *   3. `runDeterministicFloorOnly` / `runFloorRecheck` (sprint-runner.ts:2511,
 *      2861) — "the deterministic floor ALONE ... with no verify sub-agent call".
 *
 * And the baseline cannot neutralise it: a failure that names no test hits
 * `computeFloorDelta`'s "cannot be excused by ANY baseline — we would be
 * guessing" branch (verify-baseline.ts:640-650), which is fail-closed.
 *
 * Every pattern asserted here is a VERBATIM string measured on this machine, not
 * an invented shape. Commands run through `commandsOverride` + `node -e` so the
 * test is deterministic and needs no python — the same convention as
 * `coverage-measurement.test.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifyFloor } from "../verify-floor.js";
import { detectGateCouldNotRun } from "../verify-result.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * A command that prints `text` on stderr and exits `code`, on any platform.
 *
 * The JS string is SINGLE-quoted inside a double-quoted shell argument: cmd.exe
 * does not treat single quotes as quoting, so nesting double quotes here makes
 * node see a SyntaxError and exit 255 instead of emitting the text.
 */
function emit(text: string, code = 1): string {
  const js = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n");
  return `node -e "console.error('${js}'); process.exit(${code})"`;
}

describe("detectGateCouldNotRun — measured strings only", () => {
  it("recognises a missing python module — `python -m pytest` with no pytest installed", () => {
    // Measured verbatim, Python 3.14.5, venv built with --without-pip:
    //   C:\...\backend\.venv\Scripts\python.exe: No module named pytest   (exit 1)
    // Exit 1 is ALSO pytest's own "tests failed" code, so the message is the
    // only thing that separates the two facts.
    const signal = detectGateCouldNotRun(
      "C:\\Users\\phila\\AppData\\Local\\Temp\\coldfloor\\backend\\.venv\\Scripts\\python.exe: No module named pytest\r\n",
    );

    expect(signal?.kind).toBe("dependency_missing");
    expect(signal?.evidence).toContain("No module named pytest");
  });

  it("recognises ModuleNotFoundError — the import form of the same fact", () => {
    const signal = detectGateCouldNotRun("ModuleNotFoundError: No module named 'pytest'");
    expect(signal?.kind).toBe("dependency_missing");
  });

  it("recognises a missing node module", () => {
    // Measured: node -e "require('vitest-not-real')" → Error: Cannot find module 'vitest-not-real'
    const signal = detectGateCouldNotRun("Error: Cannot find module 'vitest-not-real'");
    expect(signal?.kind).toBe("dependency_missing");
  });

  it("recognises a launcher the shell could not find — cmd.exe form", () => {
    // Measured through the floor's own spawn(shell:true) on Windows:
    //   '.venv' is not recognized as an internal or external command,
    const signal = detectGateCouldNotRun(
      "'.venv' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
    );
    expect(signal?.kind).toBe("launcher_missing");
  });

  it("recognises a launcher the shell could not find — POSIX sh form", () => {
    // Measured: sh: line 1: definitely-not-a-real-cmd: command not found
    const signal = detectGateCouldNotRun("sh: line 1: definitely-not-a-real-cmd: command not found");
    expect(signal?.kind).toBe("launcher_missing");
  });

  it("recognises a missing npm script", () => {
    // Measured: npm error Missing script: "test"
    const signal = detectGateCouldNotRun('npm error Missing script: "test"');
    expect(signal?.kind).toBe("script_missing");
  });

  it("returns null for a REAL test failure — the fact it must never steal", () => {
    expect(
      detectGateCouldNotRun(
        "FAIL src/foo.test.ts > adds\nAssertionError: expected 1 to be 2\nTests  1 failed | 3 passed",
      ),
    ).toBeNull();
    expect(detectGateCouldNotRun("=== 2 failed, 8 passed in 1.20s ===")).toBeNull();
    expect(detectGateCouldNotRun("")).toBeNull();
  });

  it("returns null for a compile error — a broken build is not an un-runnable gate", () => {
    expect(detectGateCouldNotRun("src/a.ts(3,5): error TS2322: Type 'string' is not assignable")).toBeNull();
  });
});

describe("the floor names the real cause on a cold run", () => {
  it("reports gate-could-not-run, NOT a test failure, when the runner is absent", async () => {
    const cwd = makeTempDir("muonroi-floor-cold-");

    const result = await runVerifyFloor({
      cwd,
      runId: "cold-1",
      forceEnable: true,
      commandsOverride: {
        build: [],
        // The exact cold-path output, reproduced without needing python.
        test: [emit("C:\\tmp\\backend\\.venv\\Scripts\\python.exe: No module named pytest")],
      },
    });

    expect(result.verdict).toBe("fail");
    // The whole point: the cause is the missing runner, not the project's tests.
    expect(result.delta?.failureKind).toBe("gate-could-not-run");
    expect(result.delta?.failureKind).not.toBe("test-unattributable");
    expect(result.delta?.failureKind).not.toBe("test-absolute-no-baseline");
    // And the human detail must say so, quoting the evidence.
    expect(result.detail).toMatch(/could not (be )?run|No module named pytest/i);
    expect(result.detail).toContain("No module named pytest");
  }, 30_000);

  it("still fails closed — an un-runnable gate never opens the floor", async () => {
    const cwd = makeTempDir("muonroi-floor-cold-closed-");

    const result = await runVerifyFloor({
      cwd,
      runId: "cold-2",
      forceEnable: true,
      commandsOverride: { build: [], test: [emit("sh: 1: pytest: command not found", 127)] },
    });

    expect(result.verdict).toBe("fail");
    expect(result.delta?.verdict).toBe("fail");
    expect(result.delta?.failureKind).toBe("gate-could-not-run");
  }, 30_000);

  it("a genuine test failure is still reported as a test failure, not as could-not-run", async () => {
    const cwd = makeTempDir("muonroi-floor-realfail-");

    const result = await runVerifyFloor({
      cwd,
      runId: "cold-3",
      forceEnable: true,
      commandsOverride: {
        build: [],
        test: [emit("FAIL src/a.test.ts > adds\nAssertionError: expected 1 to be 2\nTests  1 failed | 0 passed")],
      },
    });

    expect(result.verdict).toBe("fail");
    expect(result.delta?.failureKind).not.toBe("gate-could-not-run");
  }, 30_000);

  it("a build gate whose compiler is missing is an un-runnable gate, not a broken build", async () => {
    // Same principle on the build tier: `tsc` not installed is not "this run
    // broke the build", and reporting it as one sends the fix loop after code
    // that is fine.
    const cwd = makeTempDir("muonroi-floor-buildcold-");

    const result = await runVerifyFloor({
      cwd,
      runId: "cold-4",
      forceEnable: true,
      commandsOverride: {
        build: [emit("'tsc' is not recognized as an internal or external command,")],
        test: [],
      },
    });

    expect(result.verdict).toBe("fail");
    expect(result.delta?.failureKind).toBe("gate-could-not-run");
    expect(result.delta?.failureKind).not.toBe("build-failed");
  }, 30_000);
});

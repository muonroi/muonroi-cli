import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyVerifyFloor,
  isStyleGate,
  resolveFloorCommands,
  runFloorCommand,
  runVerifyFloor,
} from "../verify-floor.js";

/**
 * These tests execute REAL processes in REAL temp directories. Nothing about the
 * floor is mocked: the whole value of the module is that an exit code decides
 * the verdict, and a mocked spawn would assert nothing about that.
 *
 * Commands are `node -e ...` one-liners so the suite stays hermetic and fast
 * (no package manager, no network, no repo dependency).
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "verify-floor-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writePkg(scripts: Record<string, string>, opts: { lockfile?: boolean } = {}): void {
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts }), "utf8");
  if (opts.lockfile !== false) writeFileSync(join(cwd, "bun.lock"), "", "utf8");
}

const PASSING = 'node -e "process.exit(0)"';
const FAILING = 'node -e "process.exit(1)"';

describe("resolveFloorCommands — discovery, not hardcoding", () => {
  it("derives build+test commands from the project's own package.json scripts", () => {
    writePkg({
      build: "tsc",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      lint: "biome check src/",
    });

    const cmds = resolveFloorCommands(cwd);

    // Names come from the fixture's scripts — the module hardcodes none of them.
    expect(cmds.build).toEqual(["bun run build", "bun run typecheck"]);
    // `lint` is a STYLE gate and does not block by default.
    expect(cmds.test).toEqual(["bun run test"]);
  });

  it("promotes style gates to blocking when MUONROI_SPRINT_FLOOR_STYLE_GATES=1", () => {
    writePkg({ test: "vitest run", lint: "biome check src/", check: "tsc -b" });
    const prev = process.env.MUONROI_SPRINT_FLOOR_STYLE_GATES;
    process.env.MUONROI_SPRINT_FLOOR_STYLE_GATES = "1";
    try {
      expect(resolveFloorCommands(cwd).test).toEqual(["bun run test", "bun run check", "bun run lint"]);
    } finally {
      if (prev === undefined) delete process.env.MUONROI_SPRINT_FLOOR_STYLE_GATES;
      else process.env.MUONROI_SPRINT_FLOOR_STYLE_GATES = prev;
    }
  });

  it("classifies lint/check scripts as style gates and test scripts as correctness gates", () => {
    expect(isStyleGate("bun run lint")).toBe(true);
    expect(isStyleGate("npm run check")).toBe(true);
    expect(isStyleGate("bun run test")).toBe(false);
    expect(isStyleGate("pytest -q")).toBe(false);
  });

  it("follows the project's package manager rather than assuming one", () => {
    writePkg({ test: "jest" }, { lockfile: false });
    writeFileSync(join(cwd, "package-lock.json"), "{}", "utf8");

    expect(resolveFloorCommands(cwd).test).toEqual(["npm run test"]);
  });

  it("returns no commands for a directory with no recognisable project", () => {
    const cmds = resolveFloorCommands(cwd);
    expect(cmds.build).toEqual([]);
    expect(cmds.test).toEqual([]);
  });
});

describe("runFloorCommand — exit codes are authoritative", () => {
  it("marks a zero-exit command ok", () => {
    const check = runFloorCommand("build", PASSING, cwd, 30_000);
    expect(check.exitCode).toBe(0);
    expect(check.ok).toBe(true);
  });

  it("marks a non-zero-exit command NOT ok", () => {
    const check = runFloorCommand("build", FAILING, cwd, 30_000);
    expect(check.exitCode).toBe(1);
    expect(check.ok).toBe(false);
  });

  it("rejects a test command that exits 0 while executing zero tests", () => {
    // Reuses detectNoTestsExecuted: a green exit code with no executed tests is
    // absence of evidence, not evidence of correctness.
    const check = runFloorCommand("test", 'node -e "console.log(\'No test files found, exiting\')"', cwd, 30_000);
    expect(check.exitCode).toBe(0);
    expect(check.ok).toBe(false);
    expect(check.noTests?.kind).toBe("empty_selection");
  });

  it("does not apply the zero-test rule to build commands", () => {
    const check = runFloorCommand("build", 'node -e "console.log(\'No test files found, exiting\')"', cwd, 30_000);
    expect(check.ok).toBe(true);
    expect(check.noTests).toBeUndefined();
  });

  it("treats an unspawnable command as NOT ok", () => {
    const check = runFloorCommand("build", "definitely-not-a-real-binary-xyz --version", cwd, 30_000);
    expect(check.ok).toBe(false);
  });
});

describe("runVerifyFloor", () => {
  it("passes when every discovered gate exits 0", async () => {
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [PASSING], test: [PASSING] },
      timeoutMs: 30_000,
    });
    expect(res.verdict).toBe("pass");
    expect(res.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails when a build gate exits non-zero, and never pays for the test tier", async () => {
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [FAILING], test: [PASSING] },
      timeoutMs: 30_000,
    });

    expect(res.verdict).toBe("fail");
    // Fail-fast: the expensive test tier is skipped once a gate is already red.
    expect(res.checks).toHaveLength(1);
    expect(res.checks[0].kind).toBe("build");
    expect(res.detail).toContain("Deterministic verify floor FAILED");
  });

  it("fails when the test gate exits non-zero", async () => {
    const res = await runVerifyFloor({
      cwd,
      forceEnable: true,
      commandsOverride: { build: [PASSING], test: [FAILING] },
      timeoutMs: 30_000,
    });
    expect(res.verdict).toBe("fail");
    expect(res.checks.map((c) => c.kind)).toEqual(["build", "test"]);
  });

  it("reports unavailable — not pass, not fail — when nothing is discoverable", async () => {
    const res = await runVerifyFloor({ cwd, forceEnable: true, timeoutMs: 30_000 });
    expect(res.verdict).toBe("unavailable");
    expect(res.unavailableReason).toBe("no-commands-discovered");
    expect(res.detail).toContain("no exit code behind it");
  });

  it("discovers and executes the project's real scripts end to end", async () => {
    writePkg({ typecheck: FAILING });

    const res = await runVerifyFloor({ cwd, forceEnable: true, timeoutMs: 60_000 });

    expect(res.commandsDiscovered.build).toEqual(["bun run typecheck"]);
    expect(res.verdict).toBe("fail");
  }, 60_000);
});

describe("applyVerifyFloor", () => {
  const floor = (verdict: "pass" | "fail" | "unavailable") =>
    ({ verdict, checks: [], commandsDiscovered: { build: [], test: [] }, elapsedMs: 1, detail: "d" }) as never;

  it("downgrades a claimed PASS when the floor failed", () => {
    const out = applyVerifyFloor("PASS", floor("fail"));
    expect(out.verdict).toBe("FAIL");
    expect(out.downgraded).toBe(true);
  });

  it("leaves a PASS standing when the floor passed", () => {
    expect(applyVerifyFloor("PASS", floor("pass")).verdict).toBe("PASS");
  });

  it("does not manufacture a FAIL when the floor could not run, but says so", () => {
    const out = applyVerifyFloor("PASS", floor("unavailable"));
    expect(out.verdict).toBe("PASS");
    expect(out.downgraded).toBe(false);
    expect(out.note).toBe("d");
  });

  it("never upgrades a non-PASS verdict", () => {
    expect(applyVerifyFloor("FAIL", floor("pass")).verdict).toBe("FAIL");
    expect(applyVerifyFloor("ERROR", floor("pass")).verdict).toBe("ERROR");
  });
});

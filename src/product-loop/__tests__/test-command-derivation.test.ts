/**
 * The done-gate's engineering floor must judge `hasTests` from the SAME
 * disk-derived source the deterministic verify floor actually executes.
 *
 * ## The measured case this file reproduces
 *
 * Run `muc2joffe506` on `D:\sources\CompanyLibs\qa-platform`, sprint 1, finished
 * `2026-09-24T06:24:32.474Z`. `sprints/1-outcome.json`, verbatim:
 *
 *     {"sprintN": 1, "pass": false, "score": 0, "verify": "FAIL",
 *      "failedCondition": "engineering_floor", "reason": "no_test_commands",
 *      "criteriaMet": 0, "criteriaPartial": 0, "criteriaUnmet": 4,
 *      "finishedAt": "2026-09-24T06:24:32.474Z"}
 *
 * At that moment, on that same disk, `resolveFloorCommands(cwd)` returned
 * `{build: ["cd frontend && npm run build"],
 *   test: ["cd backend && \".venv/Scripts/python.exe\" -m pytest"]}`
 * and `sprints/1-verify.md` shows the floor RAN a test command:
 *
 *     - [build] `cd frontend && npm run build` → OK (22974ms)
 *     - [test] `npm run test` → NO-TESTS-EXECUTED (empty_selection: collected 0 items / 1 error) (11030ms)
 *
 * So a test command existed, the floor executed one, and the gate one layer up
 * still scored the sprint `no_test_commands` — because the recipe it read was
 * the verify sub-agent's, whose `testCommands` was `[]`. The stored recipe
 * `qa-platform/.muonroi-cli/environment.json` (last written 2026-09-23 21:29,
 * never re-derived) carries the same empty array with
 * `ecosystem: "node-python-docker"`.
 *
 * `verify-floor.ts:28-29` states why the floor does not trust that source:
 * "a model that emitted `testCommands: []` would silently disarm its own gate".
 * The floor defends against exactly this; the done-gate was handed the
 * undefended value.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolResult, VerifyRecipe } from "../../types/index.js";
import { evaluateDoneGate } from "../done-gate.js";
import { classifyTestCommands, mergeDerivedTestCommands } from "../test-command-signal.js";
import type { Criterion, DoneGateContext, RoleSlot } from "../types.js";
import { resolveFloorCommands } from "../verify-floor.js";
import type { VerifyVerdict } from "../verify-result.js";

/**
 * The real derived strings, measured on `D:\sources\CompanyLibs\qa-platform` and
 * reproduced byte-for-byte by the temp tree below. The quoting is not
 * decoration: an unquoted `.venv/Scripts/python.exe` never launches under
 * cmd.exe (see `quoteInterpreter`, src/verify/pytest-detect.ts:283).
 */
const REAL_DERIVED_TEST_COMMAND = 'cd backend && ".venv/Scripts/python.exe" -m pytest';
const REAL_DERIVED_BUILD_COMMAND = "cd frontend && npm run build";

/**
 * The recipe that actually reached `evaluateDoneGate` on run `muc2joffe506`,
 * copied from the stored `qa-platform/.muonroi-cli/environment.json` (written
 * 2026-09-23 21:29 and never re-derived). Its `testCommands` is empty, its
 * `buildCommands` names a script that is NOT the build the floor later derived,
 * and its install line carries an absolute host path — kept verbatim rather than
 * tidied, because the tidy version is not what the gate was handed.
 */
const STORED_QA_PLATFORM_RECIPE: VerifyRecipe = {
  ecosystem: "node-python-docker",
  appKind: "fullstack-web-app",
  appLabel: "qa-platform",
  shellInitCommands: ["export DEBIAN_FRONTEND=noninteractive", 'export PATH="/usr/local/bin:$PATH"'],
  bootstrapCommands: [],
  installCommands: [
    "cd frontend && npm ci",
    "cd /d/sources/CompanyLibs/qa-platform/backend && python3 -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt",
  ],
  buildCommands: ["npm run verify"],
  testCommands: [],
  startCommand: "docker compose up -d",
  startPort: "9090",
  smokeKind: "http",
  smokeTarget: "http://127.0.0.1:9090",
  evidence: [],
  notes: [],
};

/** Four unmet criteria, matching `criteriaUnmet: 4` in the real outcome record. */
const UNMET_CRITERIA: Criterion[] = [1, 2, 3, 4].map((n) => ({
  id: `c${n}`,
  status: "unmet" as const,
}));

function gateCtx(recipe: VerifyRecipe | null, verifyVerdict: VerifyVerdict): DoneGateContext {
  return {
    lastVerify: { success: verifyVerdict === "PASS", output: "" } as ToolResult,
    verifyVerdict,
    recipe,
    criteria: UNMET_CRITERIA,
    history: [],
    roleAssignments: new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>(),
    llm: {
      generate: async () => {
        throw new Error("the engineering floor must short-circuit before any LLM call");
      },
    } as unknown as DoneGateContext["llm"],
    respondToPreflight: (async () => {
      throw new Error("the engineering floor must short-circuit before any approval prompt");
    }) as unknown as DoneGateContext["respondToPreflight"],
  };
}

/**
 * qa-platform's shape, reduced to what the detectors read: a Node frontend with
 * a build script, and a backend that is a pytest root by `conftest.py` +
 * `requirements.txt` declaring pytest, with the Windows venv interpreter that
 * makes the derived command carry its real quoted path.
 */
function makeQaPlatformTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "qa-platform-"));
  mkdirSync(path.join(root, "frontend"), { recursive: true });
  writeFileSync(
    path.join(root, "frontend", "package.json"),
    `${JSON.stringify({ name: "frontend", scripts: { build: "next build" } }, null, 2)}\n`,
  );
  mkdirSync(path.join(root, "backend", ".venv", "Scripts"), { recursive: true });
  writeFileSync(path.join(root, "backend", ".venv", "Scripts", "python.exe"), "");
  writeFileSync(path.join(root, "backend", "requirements.txt"), "fastapi==0.115.0\npytest==8.3.3\n");
  writeFileSync(path.join(root, "backend", "conftest.py"), "import os\nimport sys\n");
  return root;
}

/** A tree with genuinely nothing to run: a library with no test declaration anywhere. */
function makeNoTestsTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "no-tests-"));
  writeFileSync(path.join(root, "README.md"), "# docs only\n");
  writeFileSync(path.join(root, "notes.txt"), "no manifest, no runner, nothing to execute\n");
  return root;
}

describe("done-gate hasTests is judged from the disk, not from the model's recipe", () => {
  let qaPlatform: string;
  let noTests: string;

  beforeAll(() => {
    qaPlatform = makeQaPlatformTree();
    noTests = makeNoTestsTree();
  });

  afterAll(() => {
    for (const dir of [qaPlatform, noTests]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[test-command-derivation] temp tree cleanup failed for ${dir}: ${message}`);
      }
    }
  });

  it("the premise: the disk probe the floor already runs yields the real pytest command", () => {
    // Pinned so a detector regression is caught HERE rather than as a mystery
    // `no_test_commands` three layers up, which is how muc2joffe506 presented.
    const derived = resolveFloorCommands(qaPlatform);
    expect(derived.test).toContain(REAL_DERIVED_TEST_COMMAND);
    expect(derived.build).toContain(REAL_DERIVED_BUILD_COMMAND);
  });

  it("the defect: the model's own recipe alone scores the sprint no_test_commands", async () => {
    // Exactly what run muc2joffe506 recorded. This is the INPUT the gate was
    // handed, kept as a pin: nothing about the model's recipe changed, only
    // whether the disk's facts are merged into it before the gate reads it.
    const verdict = await evaluateDoneGate(gateCtx(STORED_QA_PLATFORM_RECIPE, "PASS"));
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("no_test_commands");
  });

  it("the fix: the recipe carrying the run's derived commands is NOT no_test_commands", async () => {
    const derived = resolveFloorCommands(qaPlatform);
    const merged = mergeDerivedTestCommands(STORED_QA_PLATFORM_RECIPE, derived.test);
    expect(merged?.testCommands).toEqual([REAL_DERIVED_TEST_COMMAND]);
    expect(merged?.testCommandsSource).toBe("disk-derived");

    const verdict = await evaluateDoneGate(gateCtx(merged, "PASS"));
    expect(verdict.reason).not.toBe("no_test_commands");
  });

  it("a tree with genuinely no tests still yields no_test_commands", async () => {
    const derived = resolveFloorCommands(noTests);
    expect(derived.test).toEqual([]);

    const merged = mergeDerivedTestCommands({ ...STORED_QA_PLATFORM_RECIPE }, derived.test);
    expect(merged?.testCommands).toEqual([]);
    expect(merged?.testCommandsSource).toBeNull();

    const verdict = await evaluateDoneGate(gateCtx(merged, "PASS"));
    expect(verdict.failedCondition).toBe("engineering_floor");
    expect(verdict.reason).toBe("no_test_commands");
  });

  it("a test command only the MODEL knows survives the merge", async () => {
    // The detector cannot derive a smoke suite driven by a bespoke script; a
    // model that legitimately knows one must not lose it. This is why the merge
    // is a union and not a replacement.
    const modelOnly = "./scripts/run-contract-suite.sh --against staging";
    const recipe: VerifyRecipe = { ...STORED_QA_PLATFORM_RECIPE, testCommands: [modelOnly] };
    const merged = mergeDerivedTestCommands(recipe, resolveFloorCommands(qaPlatform).test);

    expect(merged?.testCommands).toContain(modelOnly);
    expect(merged?.testCommands).toContain(REAL_DERIVED_TEST_COMMAND);
    expect(merged?.testCommandsSource).toBe("both");

    const verdict = await evaluateDoneGate(gateCtx(merged, "PASS"));
    expect(verdict.reason).not.toBe("no_test_commands");
  });

  it("a model recipe cannot disarm the gate by emitting an empty testCommands", () => {
    // The anti-gaming property, stated as the floor states it: the derived set
    // is ADDED unconditionally, so omission cannot subtract from it.
    const derived = resolveFloorCommands(qaPlatform);
    const disarmed = mergeDerivedTestCommands({ ...STORED_QA_PLATFORM_RECIPE, testCommands: [] }, derived.test);
    expect(classifyTestCommands(disarmed)).toEqual({
      state: "present",
      commands: [REAL_DERIVED_TEST_COMMAND],
      source: "disk-derived",
    });
  });
});

describe("classifyTestCommands / mergeDerivedTestCommands", () => {
  const base: VerifyRecipe = { ...STORED_QA_PLATFORM_RECIPE };

  it("no recipe is `none`, and the merge never manufactures one", () => {
    expect(classifyTestCommands(null)).toEqual({ state: "none" });
    expect(classifyTestCommands(undefined)).toEqual({ state: "none" });
    // `no_recipe` is a DIFFERENT floor failure, and inventing a recipe here
    // would convert it into a pass on commands nobody asked for.
    expect(mergeDerivedTestCommands(null, ["npm test"])).toBeNull();
  });

  it("an unstamped record with commands classifies as `unknown` provenance", () => {
    // Records persisted before `testCommandsSource` existed land here. The gate's
    // DECISION never depends on provenance — only its audit line does — so an
    // unstamped legacy recipe still opens the floor exactly as it did before.
    expect(classifyTestCommands({ ...base, testCommands: ["dotnet test"] })).toEqual({
      state: "present",
      commands: ["dotnet test"],
      source: "unknown",
    });
  });

  it("a blank string is not a command", () => {
    expect(classifyTestCommands({ ...base, testCommands: ["   ", ""] })).toEqual({ state: "none" });
  });

  it("a derived command the model already listed is not duplicated", () => {
    const merged = mergeDerivedTestCommands({ ...base, testCommands: ["npm run test"] }, ["npm run test"]);
    expect(merged?.testCommands).toEqual(["npm run test"]);
    expect(merged?.testCommandsSource).toBe("both");
  });

  it("the model's commands keep their order and come first", () => {
    const merged = mergeDerivedTestCommands({ ...base, testCommands: ["b", "a"] }, ["a", "c"]);
    expect(merged?.testCommands).toEqual(["b", "a", "c"]);
  });

  it("an empty derived set leaves a model-asserted recipe stamped as such", () => {
    const merged = mergeDerivedTestCommands({ ...base, testCommands: ["dotnet test"] }, []);
    expect(merged?.testCommands).toEqual(["dotnet test"]);
    expect(merged?.testCommandsSource).toBe("model-asserted");
  });

  it("the merge does not mutate the recipe it was given", () => {
    const recipe: VerifyRecipe = { ...base, testCommands: [] };
    mergeDerivedTestCommands(recipe, ["cd backend && python -m pytest"]);
    expect(recipe.testCommands).toEqual([]);
    expect(recipe.testCommandsSource).toBeUndefined();
  });
});

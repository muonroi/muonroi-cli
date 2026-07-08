import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeMissingPlanTargets,
  detectExistingPlanTargets,
  extractPlanTargetPaths,
  getImplRecheckEnabled,
  IMPL_EXECUTION_DIRECTIVE,
  persistSprintPlan,
  readPersistedSprintPlan,
  sprintPlanPath,
} from "../sprint-runner.js";

async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `sprint-plan-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("sprint plan persistence (Wave 2)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a persisted plan (persist → read same synthesis)", async () => {
    const p = sprintPlanPath(dir, 1);
    const synthesis = "## Agreed Architecture\n\nImplement src/council/engine.ts\n";
    await persistSprintPlan(p, synthesis);
    expect(await readPersistedSprintPlan(p)).toBe(synthesis.trim());
  });

  it("readPersistedSprintPlan returns '' when the file is absent", async () => {
    expect(await readPersistedSprintPlan(sprintPlanPath(dir, 2))).toBe("");
  });

  it("persistSprintPlan is a no-op for empty/whitespace synthesis (no file written)", async () => {
    const p = sprintPlanPath(dir, 3);
    await persistSprintPlan(p, "   \n  ");
    expect(await readPersistedSprintPlan(p)).toBe("");
  });

  it("keys the plan by sprint number (distinct paths → independent persistence)", async () => {
    await persistSprintPlan(sprintPlanPath(dir, 1), "plan one");
    await persistSprintPlan(sprintPlanPath(dir, 2), "plan two");
    expect(await readPersistedSprintPlan(sprintPlanPath(dir, 1))).toBe("plan one");
    expect(await readPersistedSprintPlan(sprintPlanPath(dir, 2))).toBe("plan two");
  });
});

describe("detectExistingPlanTargets (Wave 3)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mktmp();
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("returns only the plan's named target files that already exist on disk", async () => {
    await fs.mkdir(path.join(cwd, "src/council"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/council/engine.ts"), "export const x = 1;\n", "utf8");
    const plan =
      "Implement `src/council/engine.ts` and create src/council/adapters/gsdAdapter.ts plus tests/parity.test.ts.";
    const found = await detectExistingPlanTargets(plan, cwd);
    // engine.ts exists → returned; the not-yet-created files are excluded.
    expect(found).toContain("src/council/engine.ts");
    expect(found).not.toContain("src/council/adapters/gsdAdapter.ts");
    expect(found).not.toContain("tests/parity.test.ts");
  });

  it("returns [] on a greenfield plan (no target file exists yet)", async () => {
    const plan = "Create src/engine/events.ts and src/engine/types.ts from scratch.";
    expect(await detectExistingPlanTargets(plan, cwd)).toEqual([]);
  });

  it("caps the number of returned paths", async () => {
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rel = `src/f${i}.ts`;
      await fs.writeFile(path.join(cwd, rel), "//\n", "utf8");
      names.push(rel);
    }
    const plan = names.join(" and ");
    const found = await detectExistingPlanTargets(plan, cwd, 3);
    expect(found.length).toBeLessThanOrEqual(3);
  });

  it("ignores non-target-root path tokens (e.g. node_modules)", async () => {
    await fs.mkdir(path.join(cwd, "node_modules/foo"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules/foo/index.ts"), "//\n", "utf8");
    const plan = "reference node_modules/foo/index.ts";
    expect(await detectExistingPlanTargets(plan, cwd)).toEqual([]);
  });
});

describe("computeMissingPlanTargets (4A completeness re-check)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mktmp();
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("returns plan targets that do NOT exist on disk (unaddressed items)", async () => {
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/done.ts"), "//\n", "utf8");
    const plan = "Implement src/done.ts and src/missing.ts and tests/gap.test.ts";
    const missing = await computeMissingPlanTargets(plan, cwd);
    expect(missing).toContain("src/missing.ts");
    expect(missing).toContain("tests/gap.test.ts");
    expect(missing).not.toContain("src/done.ts");
  });

  it("returns [] when every named target landed (nothing to re-check)", async () => {
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/a.ts"), "//\n", "utf8");
    await fs.writeFile(path.join(cwd, "src/b.ts"), "//\n", "utf8");
    const plan = "create src/a.ts and src/b.ts";
    expect(await computeMissingPlanTargets(plan, cwd)).toEqual([]);
  });

  it("is the exact complement of detectExistingPlanTargets over the plan's targets", async () => {
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src/here.ts"), "//\n", "utf8");
    const plan = "src/here.ts and src/gone.ts";
    const all = extractPlanTargetPaths(plan).sort();
    const existing = await detectExistingPlanTargets(plan, cwd);
    const missing = await computeMissingPlanTargets(plan, cwd);
    expect([...existing, ...missing].sort()).toEqual(all);
    expect(existing).toEqual(["src/here.ts"]);
    expect(missing).toEqual(["src/gone.ts"]);
  });
});

describe("getImplRecheckEnabled (4A flag)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MUONROI_SPRINT_IMPL_RECHECK;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MUONROI_SPRINT_IMPL_RECHECK;
    else process.env.MUONROI_SPRINT_IMPL_RECHECK = prev;
  });

  it("defaults to ON", () => {
    delete process.env.MUONROI_SPRINT_IMPL_RECHECK;
    expect(getImplRecheckEnabled()).toBe(true);
  });

  it("is disabled only by the explicit '0' opt-out", () => {
    process.env.MUONROI_SPRINT_IMPL_RECHECK = "0";
    expect(getImplRecheckEnabled()).toBe(false);
    process.env.MUONROI_SPRINT_IMPL_RECHECK = "1";
    expect(getImplRecheckEnabled()).toBe(true);
  });
});

describe("IMPL_EXECUTION_DIRECTIVE (4A role + self-verify framing)", () => {
  it("keeps the imperative execution instruction and adds a reviewer self-verify clause", () => {
    expect(IMPL_EXECUTION_DIRECTIVE).toMatch(/EXECUTE the sprint plan/);
    expect(IMPL_EXECUTION_DIRECTIVE.toLowerCase()).toContain("edit");
    expect(IMPL_EXECUTION_DIRECTIVE).toMatch(/do not merely restate/i);
    expect(IMPL_EXECUTION_DIRECTIVE.toLowerCase()).toContain("implementer");
    expect(IMPL_EXECUTION_DIRECTIVE.toLowerCase()).toMatch(/self-verify|every target file named in the plan/);
  });
});

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectExistingPlanTargets,
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

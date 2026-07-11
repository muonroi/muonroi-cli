import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planningRoot } from "../../gsd/paths.js";
import { foldPlanningIntoFlow } from "../fold-planning.js";

describe("fold-planning", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fold-planning-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function seedPlanning() {
    const p = path.join(cwd, ".planning");
    await fs.mkdir(path.join(p, "phases", "01-init"), { recursive: true });
    await fs.writeFile(path.join(p, "config.json"), '{"model_profile":"x"}', "utf8");
    await fs.writeFile(path.join(p, "ROADMAP.md"), "# Roadmap\n", "utf8");
    await fs.writeFile(path.join(p, "phases", "01-init", "PLAN.md"), "# Plan\nbody\n", "utf8");
  }

  it("copies .planning into .muonroi-flow/planning, non-destructively", async () => {
    await seedPlanning();
    const res = await foldPlanningIntoFlow(cwd);
    expect(res.migrated).toBe(true);
    expect(res.filesCopied).toBe(3);

    // Original left in place.
    expect(await fs.readFile(path.join(cwd, ".planning", "config.json"), "utf8")).toContain("model_profile");
    // Copy present with identical content.
    expect(await fs.readFile(path.join(cwd, ".muonroi-flow", "planning", "config.json"), "utf8")).toContain(
      "model_profile",
    );
    expect(await fs.readFile(path.join(cwd, ".muonroi-flow", "planning", "phases", "01-init", "PLAN.md"), "utf8")).toBe(
      "# Plan\nbody\n",
    );
  });

  it("is idempotent — marker guard skips a second fold", async () => {
    await seedPlanning();
    const first = await foldPlanningIntoFlow(cwd);
    expect(first.migrated).toBe(true);
    const second = await foldPlanningIntoFlow(cwd);
    expect(second.migrated).toBe(false);
    expect(second.skipReason).toBe("already-migrated");
  });

  it("skips when there is no .planning source", async () => {
    const res = await foldPlanningIntoFlow(cwd);
    expect(res.migrated).toBe(false);
    expect(res.skipReason).toBe("no-source");
  });

  it("planningRoot prefers .planning while it exists, folds only as fallback", async () => {
    await seedPlanning();
    await foldPlanningIntoFlow(cwd);
    // .planning still present → canonical wins (no desync with the subprocess writer).
    expect(planningRoot(cwd)).toBe(path.join(cwd, ".planning"));

    // Simulate Part B removing the subprocess writer's tree.
    await fs.rm(path.join(cwd, ".planning"), { recursive: true, force: true });
    expect(planningRoot(cwd)).toBe(path.join(cwd, ".muonroi-flow", "planning"));
  });
});

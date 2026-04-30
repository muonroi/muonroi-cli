import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ensureFlowDir } from "../../../flow/scaffold.js";
import {
  createRun,
  getActiveRunId,
  setActiveRunId,
  loadRun,
  updateRunFile,
} from "../../../flow/run-manager.js";
import type { SectionMap } from "../../../flow/parser.js";
import type { SlashContext } from "../registry.js";

// Import handler — also triggers self-registration
import { handlePlanSlash } from "../plan.js";

function makeCtx(cwd: string): SlashContext {
  return {
    cwd,
    tenantId: "local",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
  };
}

describe("/plan slash command", () => {
  let tmpDir: string;
  let flowDir: string;
  let ctx: SlashContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-test-"));
    flowDir = await ensureFlowDir(tmpDir);
    ctx = makeCtx(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when no active run", async () => {
    const result = await handlePlanSlash(["build", "something"], ctx);
    expect(result).toContain("No active run");
    expect(result).toContain("/discuss");
  });

  it("blocks when unresolved gray areas exist", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    // Add open gray areas
    const grayAreas: SectionMap = {
      preamble: "",
      sections: new Map([
        [
          "Gray Areas",
          "G1 [open] Should we use X or Y?\nG2 [resolved] Token budget -> 80%\nG3 [open] What about Z?",
        ],
      ]),
    };
    await updateRunFile(flowDir, run.id, "gray-areas.md", grayAreas);

    const result = await handlePlanSlash(["my plan content"], ctx);
    expect(result).toContain("blocked");
    expect(result).toContain("G1");
    expect(result).toContain("G3");
    expect(result).not.toContain("G2"); // resolved, should not appear in block list
    expect(result).toContain("Resolution path");
  });

  it("writes plan to roadmap.md when no open gray areas", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    // All gray areas resolved
    const grayAreas: SectionMap = {
      preamble: "",
      sections: new Map([
        ["Gray Areas", "G1 [resolved] Token budget -> 80%"],
      ]),
    };
    await updateRunFile(flowDir, run.id, "gray-areas.md", grayAreas);

    const result = await handlePlanSlash(
      ["Build", "auth", "system", "with", "JWT"],
      ctx,
    );
    expect(result).toContain("Plan created");
    expect(result).toContain(run.id);

    // Verify roadmap.md has plan content
    const loaded = await loadRun(flowDir, run.id);
    const planContent = loaded!.roadmap.sections.get("Plan");
    expect(planContent).toContain("Build auth system with JWT");
  });

  it("writes plan when no gray areas exist at all", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const result = await handlePlanSlash(["Simple", "plan"], ctx);
    expect(result).toContain("Plan created");

    const loaded = await loadRun(flowDir, run.id);
    const planContent = loaded!.roadmap.sections.get("Plan");
    expect(planContent).toContain("Simple plan");
  });
});

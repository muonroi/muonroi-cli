import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRun, getActiveRunId, loadRun, setActiveRunId } from "../../../flow/run-manager.js";
import { ensureFlowDir } from "../../../flow/scaffold.js";
// Import handler — also triggers self-registration
import { handleDiscussSlash } from "../discuss.js";
import type { SlashContext } from "../registry.js";

function makeCtx(cwd: string): SlashContext {
  return {
    cwd,
    tenantId: "local",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
  };
}

describe("/discuss slash command", () => {
  let tmpDir: string;
  let flowDir: string;
  let ctx: SlashContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "discuss-test-"));
    flowDir = await ensureFlowDir(tmpDir);
    ctx = makeCtx(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new run when no active run and args provided", async () => {
    const result = await handleDiscussSlash(["build", "auth", "system"], ctx);
    expect(result).toMatch(/^Run .+ created\. Describe your task\.$/);

    // Verify run was set active
    const activeId = await getActiveRunId(flowDir);
    expect(activeId).not.toBeNull();
  });

  it("returns error when no active run and no args", async () => {
    const result = await handleDiscussSlash([], ctx);
    expect(result).toContain("No active run");
    expect(result).toContain("/discuss");
  });

  it("adds gray area entry when active run and args provided", async () => {
    // Create and set active run
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const result = await handleDiscussSlash(["Should", "we", "use", "X", "or", "Y?"], ctx);
    expect(result).toContain("G1");
    expect(result).toContain("added");

    // Verify gray-areas.md has the entry
    const loaded = await loadRun(flowDir, run.id);
    expect(loaded).not.toBeNull();
    const gaContent = loaded!.grayAreas.sections.get("Gray Areas");
    expect(gaContent).toContain("G1 [open] Should we use X or Y?");
  });

  it("increments gray area IDs on successive additions", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    await handleDiscussSlash(["First question?"], ctx);
    const result2 = await handleDiscussSlash(["Second question?"], ctx);
    expect(result2).toContain("G2");

    const loaded = await loadRun(flowDir, run.id);
    const gaContent = loaded!.grayAreas.sections.get("Gray Areas") ?? "";
    expect(gaContent).toContain("G1 [open] First question?");
    expect(gaContent).toContain("G2 [open] Second question?");
  });

  it("lists gray areas when active run and no args", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    await handleDiscussSlash(["What about X?"], ctx);
    await handleDiscussSlash(["What about Y?"], ctx);

    const result = await handleDiscussSlash([], ctx);
    expect(result).toContain("G1");
    expect(result).toContain("G2");
    expect(result).toContain("What about X?");
    expect(result).toContain("What about Y?");
  });

  it("returns 'No gray areas' when active run, no args, and no entries", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const result = await handleDiscussSlash([], ctx);
    expect(result).toContain("No gray areas recorded yet");
  });
});

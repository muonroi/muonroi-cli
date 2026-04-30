import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ensureFlowDir } from "../../../flow/scaffold.js";
import {
  createRun,
  setActiveRunId,
  loadRun,
  updateRunFile,
} from "../../../flow/run-manager.js";
import type { SectionMap } from "../../../flow/parser.js";
import type { SlashContext } from "../registry.js";

// Import handler — also triggers self-registration
import { handleExecuteSlash } from "../execute.js";

function makeCtx(cwd: string): SlashContext {
  return {
    cwd,
    tenantId: "local",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-20250514",
  };
}

describe("/execute slash command", () => {
  let tmpDir: string;
  let flowDir: string;
  let ctx: SlashContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "execute-test-"));
    flowDir = await ensureFlowDir(tmpDir);
    ctx = makeCtx(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when no active run", async () => {
    const result = await handleExecuteSlash([], ctx);
    expect(result).toContain("No active run");
    expect(result).toContain("/discuss");
  });

  it("returns error when no plan in roadmap.md", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const result = await handleExecuteSlash([], ctx);
    expect(result).toContain("No plan found");
    expect(result).toContain("/plan");
  });

  it("reads plan from roadmap.md and returns it for execution", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    // Write plan to roadmap.md
    const roadmap: SectionMap = {
      preamble: "",
      sections: new Map([
        ["Plan", "1. Build auth\n2. Add JWT\n3. Test endpoints"],
      ]),
    };
    await updateRunFile(flowDir, run.id, "roadmap.md", roadmap);

    const result = await handleExecuteSlash([], ctx);
    expect(result).toContain(`Executing run ${run.id}`);
    expect(result).toContain("Build auth");
    expect(result).toContain("Add JWT");
    expect(result).toContain("Test endpoints");
  });

  it("sets state.md Status to 'executing'", async () => {
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const roadmap: SectionMap = {
      preamble: "",
      sections: new Map([["Plan", "Do the thing"]]),
    };
    await updateRunFile(flowDir, run.id, "roadmap.md", roadmap);

    await handleExecuteSlash([], ctx);

    // Verify state.md has Status = executing
    const loaded = await loadRun(flowDir, run.id);
    const status = loaded!.state.sections.get("Status");
    expect(status).toBe("executing");
  });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningArtifact } from "../paths.js";

describe("gsd workflow tools registry", () => {
  let tmp: string;
  const prev = process.env.MUONROI_GSD_NATIVE;

  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-tools-"));
    process.env.MUONROI_GSD_NATIVE = "1";
  });

  afterEach(() => {
    process.env.MUONROI_GSD_NATIVE = prev;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("registers gsd_* tools when native flag on", () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    expect(tools.gsd_status).toBeDefined();
    expect(tools.gsd_plan).toBeDefined();
    expect(tools.gsd_plan_review).toBeDefined();
    expect(tools.gsd_execute).toBeDefined();
    expect(tools.gsd_ship).toBeDefined();
  });

  it("gsd_execute blocked before plan-verify at standard depth", async () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    const exec = tools.gsd_execute as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await exec.execute({});
    const parsed = JSON.parse(out) as { blocked?: boolean; reason?: string };
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toContain("plan-verify");
  });

  it("gsd_execute allowed after plan-review council pass", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const planBody = "# Plan\n\n1. Edit src/foo.ts\n2. Step two\n3. Acceptance: tests pass\n";
    writeFileSync(planningArtifact(tmp, "PLAN.md"), planBody, "utf8");

    const tools = createBuiltinTools(bash, "agent", {
      modelId: "deepseek-v4-flash",
      depthTier: "standard",
    });
    const review = tools.gsd_plan_review as unknown as { execute: () => Promise<string> };
    await review.execute();

    const exec = tools.gsd_execute as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await exec.execute({});
    const parsed = JSON.parse(out) as { blocked?: boolean };
    expect(parsed.blocked).toBe(false);
  });

  it("gsd_verify rejects pass without evidence", async () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    const verify = tools.gsd_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await verify.execute({ passed: true });
    const parsed = JSON.parse(out) as { ok?: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("evidence");
  });

  it("gsd_ship writes SHIP.md after verify pass", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const planBody = "# Plan\n\n1. Edit src/foo.ts\n2. Step two\n3. Acceptance: tests pass\n";
    writeFileSync(planningArtifact(tmp, "PLAN.md"), planBody, "utf8");

    const tools = createBuiltinTools(bash, "agent", {
      modelId: "deepseek-v4-flash",
      depthTier: "quick",
    });
    const verify = tools.gsd_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    await verify.execute({ passed: true, evidence: "bun test — all green" });

    const ship = tools.gsd_ship as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await ship.execute({ notes: ["ready"] });
    const parsed = JSON.parse(out) as { ok?: boolean; blocked?: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.blocked).not.toBe(true);
    expect(existsSync(planningArtifact(tmp, "SHIP.md"))).toBe(true);
  });
});

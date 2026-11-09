import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { filterExecutionTools } from "../../orchestrator/orchestration-policy.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningArtifact } from "../paths.js";
import { VERDICT_OUTPUT_CONTRACT } from "../verdict-schema.js";
import { buildFlowStatusPayload, canExecute, canShip } from "../workflow-engine.js";

describe("flow workflow tools registry", () => {
  let tmp: string;
  const prev = process.env.MUONROI_FLOW_NATIVE;

  beforeAll(async () => {
    await loadCatalog();
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flow-tools-"));
    process.env.MUONROI_FLOW_NATIVE = "1";
  });

  afterEach(() => {
    process.env.MUONROI_FLOW_NATIVE = prev;
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("registers flow_* tools when native flag on", () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    expect(tools.flow_status).toBeDefined();
    expect(tools.flow_plan).toBeDefined();
    expect(tools.flow_plan_review).toBeDefined();
    expect(tools.flow_execute).toBeDefined();
    expect(tools.flow_ship).toBeDefined();
  });
  it("returns bounded machine-readable review concerns and a recovery action without unlocking or writing state", () => {
    ensurePlanningWorkspace(tmp, "test-model");
    writeFileSync(
      planningArtifact(tmp, "PLAN-REVIEW.md"),
      "# PLAN-REVIEW\nReview id: fixture-review\nRevision cycle: 1\n",
    );
    writeFileSync(
      planningArtifact(tmp, "PLAN-VERIFY.md"),
      "# PLAN-VERIFY\nverdict: revise\nverdictSource: structured\nverdictParseFailed: no\n\n## Concerns\n- Name the exact command and timeout.\n- Use at most three simultaneous workers.\n",
    );
    const before = readFileSync(planningArtifact(tmp, "STATE.md"), "utf8");
    const status = buildFlowStatusPayload(tmp, "standard");
    expect(status.gates.canExecute.allowed).toBe(false);
    expect(status.review).toMatchObject({
      verdict: "revise",
      reviewId: "fixture-review",
      recordedRevisionCycle: 1,
      nextAction: "revise_plan",
      revisionRequired: true,
      parseFailed: false,
      concerns: ["Name the exact command and timeout.", "Use at most three simultaneous workers."],
    });
    expect(readFileSync(planningArtifact(tmp, "STATE.md"), "utf8")).toBe(before);
  });
  it("reads status in a fresh workspace without creating planning state", async () => {
    const bash = new BashTool(tmp);
    try {
      const tools = createBuiltinTools(bash, "agent", {
        modelId: "test-model",
        depthTier: "heavy",
        executionRole: "orchestrator",
      });
      expect(
        JSON.parse((await tools.flow_status!.execute!({}, { toolCallId: "fresh-status", messages: [] })) as string)
          .gates,
      ).toBeDefined();
      const status = JSON.parse(
        (await tools.flow_status!.execute!({}, { toolCallId: "scope-status", messages: [] })) as string,
      );
      expect(status.gateScope.canExecute).toContain("flow_execute only");
      expect(status.gateScope.workerDispatch).toContain("own model, role, permission and concurrency");
      expect(status.gateScope.workerDispatch).toContain("Heavy-depth mutation admission");
      expect(status.gateScope.workerDispatch).toContain("worker_models, worker_capabilities");
      expect(existsSync(planningArtifact(tmp, "STATE.md"))).toBe(false);
    } finally {
      await bash.cleanup();
    }
  });
  it.each([
    "quick",
    "standard",
    "heavy",
  ] as const)("%s root planning descriptions name only tools in its actual inventory", async (depth) => {
    const bash = new BashTool(tmp);
    try {
      const native = createBuiltinTools(bash, "agent", {
        modelId: "test-model",
        depthTier: depth,
        executionRole: "orchestrator",
      });
      const tools = filterExecutionTools(native, native, "orchestrator");
      const inventory = Object.keys(tools);
      expect(inventory).toContain("flow_plan");
      expect(tools.flow_plan_review).toBeDefined(); // quick wakes can complete an owned heavy review
      for (const name of ["flow_plan", "flow_plan_review"]) {
        const advertised = tools[name]?.description?.match(/\bflow_[a-z_]+\b/g) ?? [];
        console.info(
          "root planning inventory",
          JSON.stringify({
            depth,
            tool: name,
            advertised,
            inventory: inventory.filter((tool) => tool.startsWith("flow_")),
          }),
        );
        for (const reference of advertised) expect(inventory).toContain(reference);
      }
      // The orchestrator records phase transitions and verification itself (session
      // 55c5b65b6938 could not close a run without flow_verify); workers never get them.
      for (const name of ["flow_execute", "flow_verify", "flow_ship"]) {
        expect(tools[name], name).toBeDefined();
        const advertised = tools[name]?.description?.match(/\bflow_[a-z_]+\b/g) ?? [];
        for (const reference of advertised) expect(inventory).toContain(reference);
      }
      expect(existsSync(planningArtifact(tmp, "STATE.md"))).toBe(false);
    } finally {
      await bash.cleanup();
    }
  });
  it("root FLOW status projects action advice while preserving state, artifacts and refusal guards", async () => {
    ensurePlanningWorkspace(tmp, "test-model");
    writeFileSync(planningArtifact(tmp, "PLAN-VERIFY.md"), "verdict: revise\n", "utf8");
    const statePath = planningArtifact(tmp, "STATE.md");
    const stateBefore = readFileSync(statePath, "utf8");
    const original = buildFlowStatusPayload(tmp, "standard");
    const executeGate = canExecute(tmp, "standard");
    const shipGate = canShip(tmp, "standard");
    const tools = createBuiltinTools(new BashTool(tmp), "agent", {
      modelId: "test-model",
      depthTier: "standard",
      executionRole: "orchestrator",
    });
    expect(tools.flow_plan!.description).not.toContain("flow_execute");
    expect(tools.flow_plan_review!.description).not.toContain("flow_execute");
    const status = JSON.parse(
      (await tools.flow_status!.execute!({}, { toolCallId: "root-status", messages: [] })) as string,
    );
    expect(status.state).toEqual(original.state);
    expect(status.artifacts).toEqual(original.artifacts);
    expect(status.gates.canExecute.allowed).toBe(executeGate.allowed);
    expect(status.gates.canShip.allowed).toBe(shipGate.allowed);
    expect(JSON.stringify(status.gates)).not.toMatch(/flow_execute|flow_verify|flow_ship/);
    expect(status.nextActions.join(" ")).toContain("delegate");
    expect(status.nextActions.join(" ")).toContain("Do not clear state");
    expect(canExecute(tmp, "standard")).toEqual(executeGate);
    expect(canShip(tmp, "standard")).toEqual(shipGate);
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(planningArtifact(tmp, "PLAN-VERIFY.md"), "utf8")).toBe("verdict: revise\n");
    for (const executionRole of ["worker", "infrastructure", undefined] as const) {
      const other = createBuiltinTools(new BashTool(tmp), "agent", {
        modelId: "test-model",
        depthTier: "standard",
        executionRole,
      });
      const payload = JSON.parse(
        (await other.flow_status!.execute!({}, { toolCallId: "other-status", messages: [] })) as string,
      );
      expect(payload.gates).toEqual(original.gates);
      expect(payload.nextActions).toBeUndefined();
    }
  });

  it("flow_execute blocked before plan-verify at standard depth", async () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    const exec = tools.flow_execute as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await exec.execute({});
    const parsed = JSON.parse(out) as { blocked?: boolean; reason?: string };
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toContain("plan-verify");
  });

  it.each(["flow_plan_review", "flow_verify"])("threads the owning SDK cancellation through %s", async (name) => {
    const leader = await import("../../council/leader.js");
    const resolution = vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: "test-leader" });
    ensurePlanningWorkspace(tmp, "test-model");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), "# Plan\n1. Implement change\n2. Verify tests\n", "utf8");
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const debate = vi.fn(async (_topic: string, signal?: AbortSignal, _contract?: string) => {
      childSignal = signal;
      controller.abort(new DOMException("Owning tool cancelled", "AbortError"));
      return '```council-verdict\n{"verdict":"approve","concerns":[]}\n```';
    });
    const tools = createBuiltinTools(new BashTool(tmp), "agent", {
      modelId: "test-model",
      depthTier: "standard",
      runDebate: debate,
    });
    const execute = tools[name].execute as (...args: any[]) => Promise<unknown>;
    try {
      await expect(
        execute(
          { passed: true, evidence: "tests passed" },
          { toolCallId: "cancel-review", messages: [], abortSignal: controller.signal },
        ),
      ).rejects.toThrow("Owning tool cancelled");
      expect(childSignal).toBe(controller.signal);
      expect(debate).toHaveBeenCalledTimes(1);
      expect(debate.mock.calls[0]?.[2]).toBe(VERDICT_OUTPUT_CONTRACT);
      expect(existsSync(planningArtifact(tmp, name === "flow_verify" ? "VERIFY-COUNCIL.md" : "PLAN-VERIFY.md"))).toBe(
        false,
      );
    } finally {
      resolution.mockRestore();
    }
  });

  it("flow_execute allowed after plan-review council pass", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const planBody = "# Plan\n\n1. Edit src/foo.ts\n2. Step two\n3. Acceptance: tests pass\n";
    writeFileSync(planningArtifact(tmp, "PLAN.md"), planBody, "utf8");

    const tools = createBuiltinTools(bash, "agent", {
      modelId: "deepseek-v4-flash",
      depthTier: "standard",
    });
    const review = tools.flow_plan_review as unknown as { execute: () => Promise<string> };
    await review.execute();

    const exec = tools.flow_execute as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await exec.execute({});
    const parsed = JSON.parse(out) as { blocked?: boolean };
    expect(parsed.blocked).toBe(false);
  });

  it("flow_verify rejects pass without evidence", async () => {
    const bash = new BashTool(tmp);
    const tools = createBuiltinTools(bash, "agent", { modelId: "test-model", depthTier: "standard" });
    const verify = tools.flow_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await verify.execute({ passed: true });
    const parsed = JSON.parse(out) as { ok?: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("evidence");
  });

  it("flow_verify runs verify-council when passed=true at heavy depth and honors its verdict", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const planBody = "# Plan\n\n## Acceptance\n- returns a token\n";
    writeFileSync(planningArtifact(tmp, "PLAN.md"), planBody, "utf8");

    const runDebate = async () =>
      '```council-verdict\n{"verdict":"revise","concerns":["missing null-token guard"],"evidence":[],"rationale":"gap"}\n```';

    const tools = createBuiltinTools(bash, "agent", {
      modelId: "deepseek-v4-flash",
      depthTier: "heavy",
      runDebate,
    });
    const verify = tools.flow_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await verify.execute({ passed: true, evidence: "42 tests passed" });
    const parsed = JSON.parse(out) as { ok?: boolean; phase?: string; passed?: boolean; councilConcerns?: string[] };
    expect(parsed.phase).toBe("debug");
    expect(parsed.passed).toBe(false);
    expect(parsed.councilConcerns?.join(" ")).toContain("null-token");
    expect(existsSync(planningArtifact(tmp, "VERIFY-COUNCIL.md"))).toBe(true);
  });

  it("flow_verify skips council on passed=false (deterministic fail → debug, no council)", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const tools = createBuiltinTools(bash, "agent", { modelId: "deepseek-v4-flash", depthTier: "heavy" });
    const verify = tools.flow_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await verify.execute({ passed: false });
    const parsed = JSON.parse(out) as { phase?: string };
    expect(parsed.phase).toBe("debug");
    expect(existsSync(planningArtifact(tmp, "VERIFY-COUNCIL.md"))).toBe(false);
  });

  it("flow_ship writes SHIP.md after verify pass", async () => {
    const bash = new BashTool(tmp);
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const planBody = "# Plan\n\n1. Edit src/foo.ts\n2. Step two\n3. Acceptance: tests pass\n";
    writeFileSync(planningArtifact(tmp, "PLAN.md"), planBody, "utf8");

    const tools = createBuiltinTools(bash, "agent", {
      modelId: "deepseek-v4-flash",
      depthTier: "quick",
    });
    const verify = tools.flow_verify as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    await verify.execute({ passed: true, evidence: "bun test — all green" });

    const ship = tools.flow_ship as unknown as {
      execute: (input: Record<string, unknown>) => Promise<string>;
    };
    const out = await ship.execute({ notes: ["ready"] });
    const parsed = JSON.parse(out) as { ok?: boolean; blocked?: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.blocked).not.toBe(true);
    expect(existsSync(planningArtifact(tmp, "SHIP.md"))).toBe(true);
  });
});

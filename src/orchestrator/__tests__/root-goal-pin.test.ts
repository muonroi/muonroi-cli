import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerContextLoader } from "../../tools/context-load.js";
import { ensurePlanningWorkspace } from "../../workflow/config-bridge.js";
import { planningArtifact } from "../../workflow/paths.js";
import { readCompletionScope } from "../../workflow/workflow-engine.js";
import { TaskContext } from "../task-context.js";
import { retainWorkingContext, WorkingContext } from "../working-context.js";

// Goals main wrote, in order, in session 4edc02516a92 (tool_calls.context_load args, seq 107/199/559/671).
const DRIFT = [
  "Build a TCIS Docs MCP server package (stdio JSON-RPC, search+read repo docs) and get its PLAN.md approved through the plan-review gate.",
  "Investigate the Git source-snapshot ETIMEDOUT blocking flow_plan_review revalidate",
  "Fix scanner classifier (R1), digest (R2) and gate (R3) defects in scan_corpus.py",
  "Sửa wording gate sai trong scan_corpus.py (C9), tái tạo artifact, commit — HOÀN TẤT",
];

const history: ModelMessage[] = [
  { role: "user", content: "build the MCP docs server" },
  { role: "assistant", content: "planning" },
  { role: "user", content: "continue" },
];

const write = (
  w: WorkingContext,
  extra: Record<string, unknown> = {},
  facts?: Parameters<WorkingContext["update"]>[1],
) =>
  w.update(
    { action: "update", expected_revision: w.snapshot().revision, task_id: "tcis-mcp-docs", goal: "wave", ...extra },
    facts,
  );

const asToolHistory = (receipt: unknown): ModelMessage[] => [
  ...history,
  {
    role: "assistant",
    content: [{ type: "tool-call", toolName: "context_load", toolCallId: "ledger", input: { topic: "working_set" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "context_load",
        toolCallId: "ledger",
        output: { type: "text", value: JSON.stringify(receipt) },
      },
    ],
  },
];

describe("host-pinned root goal", () => {
  it("pins the first goal and keeps it through the session-4edc02516a92 wave drift", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    for (const goal of DRIFT) expect(write(w, { goal }).error).toBeUndefined();
    const state = w.snapshot();
    expect(state.root_goal).toBe(DRIFT[0]);
    expect(state.goal).toBe(DRIFT[3]);
    expect(state.root_status).toBe("open");
    expect(w.block()).toContain(DRIFT[0]);
    expect(w.block()).toContain('"root_status":"open"');
  });

  it("refuses rewriting an open root_goal and leaves the ledger untouched", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "Build TCIS.MCP.Docs MCP stdio server", goal: "Wave 1 preflight" });
    const before = w.snapshot();
    const refused = write(w, { root_goal: "Fix scanner wording", goal: "C9" });
    expect(refused.error).toContain('root_goal is pinned to "Build TCIS.MCP.Docs MCP stdio server"');
    expect(w.snapshot()).toEqual(before);
    // Restating the same root is accepted.
    expect(write(w, { root_goal: "Build TCIS.MCP.Docs MCP stdio server", goal: "Wave 2" }).error).toBeUndefined();
  });

  it("keeps an open root across reset unless it is explicitly released", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT_TASK" });
    w.update({ action: "reset", expected_revision: w.snapshot().revision });
    expect(w.active()).toBe(false);
    expect(w.snapshot().root_goal).toBe("ROOT_TASK");
    expect(w.block()).toContain("ROOT_TASK");
    expect(write(w, { root_goal: "OTHER" }).error).toContain("pinned");
    w.update({ action: "reset", expected_revision: w.snapshot().revision, release_root_reason: "User switched task" });
    expect(w.snapshot().root_goal).toBe("");
    expect(w.snapshot().released_root).toEqual({ goal: "ROOT_TASK", reason: "User switched task" });
    expect(write(w, { goal: "NEW_TASK" }).error).toBeUndefined();
    expect(w.snapshot().root_goal).toBe("NEW_TASK");
    expect(write(w, { release_root_reason: "x" }).error).toContain('action="reset"');
  });

  it("loads legacy working-context/v1 receipts and pins their earliest goal on the next write", () => {
    const legacy = {
      kind: "working-context/v1",
      owner: "owner",
      cwd: new WorkingContext("owner", "/fixture").snapshot().cwd,
      revision: 3,
      task_id: "legacy",
      goal: "LEGACY_GOAL",
      constraints: [],
      decisions: ["LEGACY_DECISION"],
      open_items: [],
      keep_tool_ids: [],
      keep_turn_ids: [],
      archive: [],
      archive_through: null,
      replace_checkpoint: false,
    };
    const w = new WorkingContext("owner", "/fixture", asToolHistory(legacy));
    expect(w.active()).toBe(true);
    expect(w.snapshot().revision).toBe(3);
    expect(w.snapshot().root_goal).toBe("");
    expect(w.block()).toContain("LEGACY_DECISION");
    expect(write(w, { goal: "LATER_WAVE" }).error).toBeUndefined();
    expect(w.snapshot().root_goal).toBe("LEGACY_GOAL");
    // New receipts round-trip through history and the compaction carrier with the pin intact.
    const restored = new WorkingContext("owner", "/fixture", asToolHistory(w.snapshot()));
    expect(restored.snapshot()).toEqual(w.snapshot());
    const carried = retainWorkingContext(asToolHistory(w.snapshot()), "owner", "/fixture")!;
    expect(new WorkingContext("owner", "/fixture", [carried]).snapshot().root_goal).toBe("LEGACY_GOAL");
  });

  it("rejects receipts with a malformed root instead of trusting them", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT" });
    const forged = { ...w.snapshot(), revision: 99, root_status: "done" };
    expect(new WorkingContext("owner", "/fixture", asToolHistory(forged)).active()).toBe(false);
  });

  it("still restores legacy task-context/v1 stage receipts unchanged", () => {
    const owner = "owner";
    const cwd = new TaskContext(owner, "/fixture").snapshot().cwd;
    const receipt = { kind: "task-context/v1", owner, cwd, stage: "implement", revision: 4, handoff: "LEGACY_HANDOFF" };
    const context = new TaskContext(owner, "/fixture", asToolHistory(receipt), true, "orient", () => true);
    expect(context.snapshot()).toMatchObject({ stage: "implement", revision: 4, handoff: "LEGACY_HANDOFF" });
  });
});

describe("host-gated root completion", () => {
  it("refuses complete while open_items remain, naming the root goal", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT_TASK", open_items: ["Implement server", "Add tests"] });
    const refused = write(w, { root_status: "complete" });
    expect(refused.error).toContain('root goal "ROOT_TASK"');
    expect(refused.error).toContain("Implement server");
    expect(w.snapshot().root_status).toBe("open");
  });

  it.each([
    "missing",
    "unstructured",
    "recorded_fail",
  ] as const)("refuses complete when FLOW implementationVerification=%s", (verification) => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT_TASK" });
    const refused = write(w, { root_status: "complete", open_items: [] }, () => ({
      declaredPlanScope: "TCIS.MCP.Docs server",
      implementationVerification: verification,
    }));
    expect(refused.error).toContain(`implementationVerification=${verification}`);
    expect(refused.error).toContain('"TCIS.MCP.Docs server"');
    expect(refused.error).toContain('"ROOT_TASK"');
    expect(w.snapshot().root_status).toBe("open");
  });

  it("accepts complete with no open items and a recorded pass, then pins the next task's root", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT_TASK" });
    const done = write(w, { root_status: "complete" }, () => ({
      declaredPlanScope: "x",
      implementationVerification: "recorded_pass",
    }));
    expect(done.error).toBeUndefined();
    expect(w.snapshot().root_status).toBe("complete");
    expect(write(w, { goal: "NEXT_USER_TASK" }).error).toBeUndefined();
    expect(w.snapshot()).toMatchObject({ root_goal: "NEXT_USER_TASK", root_status: "open" });
  });

  it("without a native plan only open_items gate completion", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    write(w, { root_goal: "ROOT_TASK" });
    expect(write(w, { root_status: "complete" }, () => null).error).toBeUndefined();
  });
});

describe("context_load tool boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const setup = () => {
    const cwd = mkdtempSync(join(tmpdir(), "root-goal-"));
    roots.push(cwd);
    const tools: ToolSet = {};
    const context = new TaskContext("owner", cwd);
    registerContextLoader(tools, context, () => cwd, "orchestrator");
    const run = async (input: unknown) =>
      JSON.parse((await tools.context_load!.execute!(input as never, { toolCallId: "c", messages: [] })) as string);
    return { cwd, context, run };
  };

  it("refuses ledger fields sent without topic instead of silently dropping them (session 4edc02516a92 shape)", async () => {
    const { context, run } = setup();
    // Exact argument shape of seq 671: action/goal/decisions/open_items/handoff with stage, no topic.
    const result = await run({
      action: "update",
      goal: DRIFT[3],
      stage: "verify",
      decisions: ["C9 fix complete"],
      open_items: [],
      handoff: "Task complete.",
    });
    expect(result.kind).toBe("task-context/v1");
    expect(result.error).toContain('topic "stage" does not store action, goal, decisions, open_items');
    expect(context.snapshot()).toMatchObject({ stage: "orient", handoff: "" });
    expect(context.working.active()).toBe(false);
    // A plain stage selection still works.
    expect((await run({ stage: "verify", handoff: "next" })).error).toBeUndefined();
  });

  it("refuses root completion against the real native FLOW completion scope until VERIFY.md records a pass", async () => {
    const { cwd, context, run } = setup();
    ensurePlanningWorkspace(cwd, "fixture-model");
    writeFileSync(planningArtifact(cwd, "PLAN.md"), "# TCIS.MCP.Docs MCP stdio server\n\n## 7. Definition of Done\n");
    writeFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "verdict: pass\n");
    context.completionFacts = () => readCompletionScope(cwd);
    const inspected = await run({ topic: "working_set", action: "inspect" });
    const pinned = await run({
      topic: "working_set",
      action: "update",
      expected_revision: inspected.revision,
      task_id: "tcis",
      root_goal: "Build TCIS.MCP.Docs MCP stdio server",
      goal: "Fix scanner wording (C9)",
    });
    expect(pinned.error).toBeUndefined();
    const claim = {
      topic: "working_set",
      action: "update",
      task_id: "tcis",
      goal: DRIFT[3],
      root_status: "complete",
    };
    const refused = await run({ ...claim, expected_revision: pinned.revision });
    expect(refused.error).toContain("implementationVerification=missing");
    expect(refused.error).toContain('"TCIS.MCP.Docs MCP stdio server"');
    expect(refused.error).toContain('root goal "Build TCIS.MCP.Docs MCP stdio server"');
    expect(context.working.snapshot().root_status).toBe("open");
    writeFileSync(planningArtifact(cwd, "VERIFY.md"), "verdict: pass\n\nAll DoD items evidenced.\n");
    const accepted = await run({ ...claim, expected_revision: pinned.revision });
    expect(accepted.error).toBeUndefined();
    expect(accepted.root_status).toBe("complete");
    expect(accepted.root_goal).toBe("Build TCIS.MCP.Docs MCP stdio server");
  });
});

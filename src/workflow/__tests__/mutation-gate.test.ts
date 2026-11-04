import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateMutationGate } from "../mutation-gate.js";

function seed(cwd: string, phase: string, verdict: string, depth = "heavy") {
  const d = join(cwd, ".planning");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "STATE.md"),
    `# STATE\n\n| Field | Value |\n|---|---|\n| Phase | ${phase} |\n| Depth | ${depth} |\n`,
    "utf8",
  );
  writeFileSync(join(d, "PLAN-VERIFY.md"), `verdict: ${verdict}\n`, "utf8");
}
const on = { hardGateEnabled: true };

describe("evaluateMutationGate (delegates to canExecute, depth from SDK STATE)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "gate-"));
  });

  it.each([
    "worker_models",
    "worker_capabilities",
  ])("allows native %s discovery while heavy mutations remain locked", (toolName) => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName })).toEqual({ blocked: false, reason: "" });
    for (const mutation of ["write_file", "edit_file", "bash", "task", "unknown_tool"]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName: mutation }).blocked).toBe(true);
    }
  });

  it("explains a mutation-capable task refusal without blocking catalog discovery or suggesting force", () => {
    seed(cwd, "plan", "revise", "heavy");
    const decision = evaluateMutationGate(cwd, {
      ...on,
      toolName: "task",
      input: { agent: "general", background: true },
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("mutation-capable worker");
    expect(decision.reason).toContain("worker_models");
    expect(decision.reason).toContain("not a provider authentication or permission-mode failure");
    expect(decision.reason).not.toContain("force:true");
  });

  it.each([
    "context_load",
    "search_session_history",
    "retrieve_tool_result",
    "list_tools",
    "list_mcp_servers",
    "describe_tool",
    "wait_for_diagnostics",
    "impact_of_change",
  ])("allows %s to inspect feedback evidence under heavy/revise without granting edit access", (toolName) => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName })).toEqual({ blocked: false, reason: "" });
    for (const mutation of ["edit_file", "write_file", "bash", "task", "unknown_tool"]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName: mutation }).blocked).toBe(true);
    }
  });

  it("blocks edit_file at heavy depth before plan-review passes", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(true);
  });
  it("admits the exact built-in explore task without unlocking other workers or shell", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(
      evaluateMutationGate(cwd, {
        ...on,
        toolName: "task",
        input: {
          agent: "explore",
          background: true,
          description: "Runtime smoke test",
          prompt: 'Return only: "alive" and the current timestamp. Do nothing else.',
        },
      }).blocked,
    ).toBe(false);
    for (const agent of ["general", "verify", "computer", "Explore", "custom-explore", undefined, {}, ["explore"]]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName: "task", input: { agent } }).blocked).toBe(true);
    }
    for (const toolName of ["bash", "write_file", "edit_file", "unknown_tool"]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName, input: { agent: "explore" } }).blocked).toBe(true);
    }
  });
  it("permits bounded local tests and offline non-emitting selfverify without opening mutation access", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "verification_run" }).blocked).toBe(false);
    expect(
      evaluateMutationGate(cwd, { ...on, toolName: "selfverify_start", input: { mode: "tier1", emit: false } }).blocked,
    ).toBe(false);
    for (const input of [{ mode: "agentic", emit: false }, { mode: "tier1", emit: true }, { mode: "tier1" }]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName: "selfverify_start", input }).blocked).toBe(true);
    }
    for (const toolName of ["bash", "task", "write_file", "edit_file"]) {
      expect(evaluateMutationGate(cwd, { ...on, toolName }).blocked).toBe(true);
    }
  });
  it("allows edit_file once canExecute allows (phase=execute + verdict=pass)", () => {
    seed(cwd, "execute", "pass", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("never gates quick depth (canExecute fast-path)", () => {
    seed(cwd, "plan", "revise", "quick");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("standard depth is advisory (not blocked) but carries GATE_DIRECTIVE in reason", () => {
    // standard is the default tier; hard-blocking every default bash/edit until a
    // plan-review pass over-reaches. The directive still nudges; the gate does not block.
    seed(cwd, "plan", "revise", "standard");
    const editGate = evaluateMutationGate(cwd, { ...on, toolName: "edit_file" });
    expect(editGate.blocked).toBe(false);
    expect(editGate.reason).toContain("FLOW requires a reviewed plan");
    const bashGate = evaluateMutationGate(cwd, { ...on, toolName: "bash" });
    expect(bashGate.blocked).toBe(false);
    expect(bashGate.reason).toContain("FLOW requires a reviewed plan");
  });
  it("never gates flow_*/respond_*/read tools", () => {
    seed(cwd, "plan", "revise", "heavy");
    for (const t of ["flow_plan", "respond_report", "read_file", "grep"])
      expect(evaluateMutationGate(cwd, { ...on, toolName: t }).blocked).toBe(false);
  });
  it("allows bounded background research and human clarification without unlocking mutations", () => {
    seed(cwd, "plan", "revise", "heavy");
    for (const toolName of ["delegate", "ask_user", "delegation_kill", "todo_write", "delegation_ack"])
      expect(evaluateMutationGate(cwd, { ...on, toolName }).blocked, toolName).toBe(false);
    for (const toolName of ["task", "bash", "write_file", "edit_file", "unknown_tool"])
      expect(evaluateMutationGate(cwd, { ...on, toolName }).blocked, toolName).toBe(true);
  });
  it("never gates when disabled or directAnswer", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { toolName: "edit_file", hardGateEnabled: false }).blocked).toBe(false);
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file", directAnswer: true }).blocked).toBe(false);
  });
  it("fails open when depth is unknown (no .planning → null depth)", () => {
    // fresh cwd, no STATE.md → readState depth null → gate must NOT block (over-block forbidden)
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
});

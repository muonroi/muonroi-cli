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

  it("blocks edit_file at heavy depth before plan-review passes", () => {
    seed(cwd, "plan", "revise", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(true);
  });
  it("allows edit_file once canExecute allows (phase=execute + verdict=pass)", () => {
    seed(cwd, "execute", "pass", "heavy");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("never gates quick depth (canExecute fast-path)", () => {
    seed(cwd, "plan", "revise", "quick");
    expect(evaluateMutationGate(cwd, { ...on, toolName: "edit_file" }).blocked).toBe(false);
  });
  it("never gates gsd_*/respond_*/read tools", () => {
    seed(cwd, "plan", "revise", "heavy");
    for (const t of ["gsd_plan", "respond_report", "read_file", "grep"])
      expect(evaluateMutationGate(cwd, { ...on, toolName: t }).blocked).toBe(false);
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

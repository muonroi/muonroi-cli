/**
 * The agent operating contract used to carry a council line ("call
 * convene_council for high-stakes calls … you MAY confirm via ask_user").
 * Every reader of this contract is a non-orchestrator role — the main
 * orchestrator receives ORCHESTRATOR_CONTRACT instead (prompts.ts) — and
 * those roles are refused convene_council at the tool boundary
 * (orchestration-policy.ts WORKER_FORBIDDEN). The line therefore named a tool
 * its reader can never call; it is gone, and these tests pin both halves.
 */
import { describe, expect, it } from "vitest";
import { filterExecutionTools } from "../../orchestrator/orchestration-policy.js";
import { AGENT_OPERATING_CONTRACT, buildContractSection } from "../agent-operating-contract.js";

describe("agent-operating-contract — no council line", () => {
  it("does not name convene_council", () => {
    expect(AGENT_OPERATING_CONTRACT).not.toContain("convene_council");
    expect(buildContractSection()).not.toContain("convene_council");
  });

  it("matches the tool boundary: worker and infrastructure roles never receive convene_council", () => {
    const native = { convene_council: { execute: async () => "" }, read_file: { execute: async () => "" } };
    for (const role of ["worker", "infrastructure"] as const) {
      const granted = filterExecutionTools(native, native, role);
      expect(Object.keys(granted)).toEqual(["read_file"]);
    }
  });

  it("stays within the front-loaded primacy budget (<2000 chars)", () => {
    expect(AGENT_OPERATING_CONTRACT.length).toBeLessThan(2000);
  });

  it("is emitted at the front of the contract section (primacy)", () => {
    expect(buildContractSection().startsWith("[AGENT OPERATING CONTRACT")).toBe(true);
  });
});

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { DelegationManager } from "../../src/orchestrator/delegations.js";

const ORCHESTRATOR_PATH = path.resolve(__dirname, "../../src/orchestrator/orchestrator.ts");

describe("delegation system preservation (CORE-04)", () => {
  it("DelegationManager class exists and is constructable", () => {
    expect(DelegationManager).toBeDefined();
    const dm = new DelegationManager(() => "/tmp");
    expect(dm).toBeInstanceOf(DelegationManager);
  });

  it("orchestrator imports DelegationManager from delegations module", () => {
    const content = readFileSync(ORCHESTRATOR_PATH, "utf8");
    const hasImport =
      content.includes('import { DelegationManager }') ||
      content.includes('from "./delegations"') ||
      content.includes("from './delegations'");
    expect(hasImport).toBe(true);
  });

  it("orchestrator uses private delegations field", () => {
    const content = readFileSync(ORCHESTRATOR_PATH, "utf8");
    expect(content).toContain("this.delegations");
  });

  it("delegation tools referenced in orchestrator", () => {
    const content = readFileSync(ORCHESTRATOR_PATH, "utf8");
    // "task" is referenced as a usage source string
    expect(content).toContain('"task"');
    // delegation functions exist in orchestrator (runDelegation, listDelegations, readDelegation)
    expect(content).toContain("runDelegation");
    expect(content).toContain("listDelegations");
    expect(content).toContain("readDelegation");
  });
});

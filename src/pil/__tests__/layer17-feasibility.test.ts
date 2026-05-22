import { describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import type { ClarifiedIntent, ProjectContext } from "../discovery-types.js";
import { checkFeasibility } from "../layer17-feasibility.js";

const PROJECT: ProjectContext = {
  language: "typescript",
  framework: null,
  packageManager: null,
  domain: null,
  boundedContexts: [{ path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: [] }],
  eePatterns: [],
  relevantModules: [],
  scannedAt: Date.now(),
  cwd: "/proj",
};

describe("checkFeasibility()", () => {
  it("returns no warnings when scope files exist", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["src/auth/"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, () => true);
    expect(result.viable).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns warning when scope file does not exist", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["src/billing/pay.ts"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, () => false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("src/billing/pay.ts");
  });

  it("still returns viable=true even with warnings", async () => {
    const intent: ClarifiedIntent = { outcome: "done", scope: ["missing.ts"], constraints: [], gaps: [] };
    const result = await checkFeasibility(intent, PROJECT, () => false);
    expect(result.viable).toBe(true);
  });
});

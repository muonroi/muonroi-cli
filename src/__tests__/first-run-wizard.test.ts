import { describe, it, expect } from "vitest";

describe("first-run wizard wiring", () => {
  it("runResearchOnboarding is reachable from the mcp module", async () => {
    const mod = await import("../mcp/research-onboarding.js");
    expect(typeof mod.runResearchOnboarding).toBe("function");
    expect(typeof mod.runResearchMigrationPrompt).toBe("function");
  });
});

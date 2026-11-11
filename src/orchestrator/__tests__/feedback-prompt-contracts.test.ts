import { describe, expect, it } from "vitest";
import { NATIVE_CAPABILITIES } from "../../pil/native-capabilities-workbook.js";
import { buildRateLimitRule } from "../../utils/background-jobs.js";
import { MODE_PROMPTS } from "../prompts.js";

describe("evidence-based CLI guidance", () => {
  it("does not supply fixed request costs or force delegation after two rounds", () => {
    expect(MODE_PROMPTS.agent).not.toMatch(/~17K|MAX 2 LLM ROUND TRIPS|\$0\.00[346]/);
    expect(MODE_PROMPTS.agent).toContain("Dependent calls");
  });
  it("distinguishes exhausted retry waits from exhausted account credit", () => {
    const rule = buildRateLimitRule({ provider: "fixture", maxParallelAgents: 2 });
    expect(rule).not.toContain("the budget is exhausted");
    expect(rule).toContain("does not prove");
    expect(rule).toContain("do NOT respawn at once or launch probe agents");
  });
  it("describes retained child instructions and filtered capabilities precisely", () => {
    expect(NATIVE_CAPABILITIES).toContain("retain repository custom instructions");
    expect(NATIVE_CAPABILITIES).toContain("skills catalog is omitted");
    expect(NATIVE_CAPABILITIES).not.toContain("verify=full E2E smoke");
  });
});

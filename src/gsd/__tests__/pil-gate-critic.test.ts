import { describe, expect, it } from "vitest";
import { mergeCriticVerdicts, runGateCritics } from "../pil-gate-critic.js";

const bundle = { conversationDigest: "", eeContext: "", priorPlan: "", projectHints: "", totalChars: 0 };

describe("mergeCriticVerdicts (downgrade-only, worst-wins)", () => {
  it("a critic cannot upgrade needs-user to adequate", () => {
    expect(mergeCriticVerdicts("needs-user", ["adequate", "adequate"])).toBe("needs-user");
  });
  it("a critic downgrades enriched to needs-user", () => {
    expect(mergeCriticVerdicts("enriched", ["adequate", "needs-user"])).toBe("needs-user");
  });
  it("all-adequate stays adequate", () => {
    expect(mergeCriticVerdicts("adequate", ["adequate", "adequate", "adequate"])).toBe("adequate");
  });
});

describe("runGateCritics", () => {
  it("runs 3 critics and applies the worst verdict", async () => {
    let calls = 0;
    const res = await runGateCritics({
      draftBrief: "Likely area: src/state/ (confirm via grep before anchoring)",
      draftVerdict: "enriched",
      bundle,
      runCritic: async () => {
        calls++;
        const verdict = calls === 2 ? "needs-user" : "enriched";
        return `\`\`\`gate-critic\n{"verdict":"${verdict}","strippedBrief":"trimmed"}\n\`\`\``;
      },
    });
    expect(calls).toBe(3);
    expect(res.verdict).toBe("needs-user");
  });

  it("parse failure is conservative (needs-user, keeps producer brief)", async () => {
    const res = await runGateCritics({
      draftBrief: "keep me",
      draftVerdict: "enriched",
      bundle,
      runCritic: async () => "no fenced block here",
    });
    expect(res.verdict).toBe("needs-user");
    expect(res.brief).toContain("keep me");
  });
});

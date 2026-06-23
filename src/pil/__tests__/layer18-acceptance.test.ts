import { describe, expect, it } from "vitest";
import type { ClarifiedIntent, FeasibilityResult } from "../discovery-types.js";
import { buildAcceptanceCard } from "../layer18-acceptance.js";

describe("buildAcceptanceCard()", () => {
  it("builds card with intent, outcome, scope, and warnings", () => {
    const intent: ClarifiedIntent = { outcome: "error gone", scope: ["src/auth/jwt.ts"], constraints: [], gaps: [] };
    const feasibility: FeasibilityResult = {
      viable: true,
      warnings: ["oauth.ts also handles tokens"],
      adjustedScope: ["src/auth/jwt.ts"],
    };
    const card = buildAcceptanceCard("Fix JWT validation returning 401", intent, feasibility);
    expect(card.intentStatement).toBe("Fix JWT validation returning 401");
    expect(card.outcome).toBe("error gone");
    expect(card.scope).toEqual(["src/auth/jwt.ts"]);
    expect(card.warnings).toEqual(["oauth.ts also handles tokens"]);
  });
});

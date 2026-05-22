import { describe, expect, it } from "vitest";
import type {
  AcceptanceCardData,
  BoundedContext,
  ClarifiedIntent,
  ClarityDimension,
  ClarityGap,
  DiscoveryInteractionHandler,
  DiscoveryResult,
  FeasibilityResult,
  ProjectContext,
  RelevantModule,
} from "../discovery-types.js";

describe("discovery-types", () => {
  it("ProjectContext is structurally valid", () => {
    const ctx: ProjectContext = {
      language: "typescript",
      framework: "next",
      packageManager: "bun",
      domain: "web",
      boundedContexts: [
        { path: "src/auth/", name: "auth", entryFiles: ["src/auth/index.ts"], exportedSymbols: ["login"] },
      ],
      eePatterns: ["jwt-validation"],
      relevantModules: [{ path: "src/auth/jwt.ts", relevance: "matches keyword auth", exists: true }],
      scannedAt: Date.now(),
      cwd: "/tmp/proj",
    };
    expect(ctx.language).toBe("typescript");
  });

  it("ClarityDimension union covers all 3 values", () => {
    const dims: ClarityDimension[] = ["outcome", "scope", "constraint"];
    expect(dims).toHaveLength(3);
  });

  it("DiscoveryResult has all required fields", () => {
    const result: DiscoveryResult = {
      raw: "fix auth",
      projectContext: {
        language: null,
        framework: null,
        packageManager: null,
        domain: null,
        boundedContexts: [],
        eePatterns: [],
        relevantModules: [],
        scannedAt: 0,
        cwd: "",
      },
      clarifiedIntent: { outcome: "", scope: [], constraints: [], gaps: [] },
      feasibility: { viable: true, warnings: [], adjustedScope: [] },
      interviewed: false,
      intentStatement: "",
      outcome: "",
      scope: [],
      feasibilityWarnings: [],
      accepted: true,
      taskType: "debug",
      confidence: 0.9,
      domain: "typescript",
      outputStyle: "balanced",
      discoveryMs: 100,
    };
    expect(result.accepted).toBe(true);
  });
});

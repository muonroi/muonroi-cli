import { describe, expect, it } from "vitest";
import type { DiscoveryResult, ModelCard, ProjectContext } from "../discovery-types.js";

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

  it("ModelCard has all required fields", () => {
    const card: ModelCard = {
      question: "What auth method?",
      options: [
        { label: "OAuth", kind: "choice", isCancel: false, isAdjust: false },
        { label: "API keys", kind: "choice" },
        { label: "Custom", kind: "freetext" },
      ],
      defaultIndex: 0,
    };
    expect(card.question).toBe("What auth method?");
    expect(card.options).toHaveLength(3);
  });

  it("DiscoveryResult has all required fields including interviewTranscript", () => {
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
      interviewTranscript: [],
    };
    expect(result.accepted).toBe(true);
    expect(result.interviewTranscript).toEqual([]);
  });
});

import * as os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { runLoopDriver } from "../loop-driver.js";
import type { DriverContext } from "../types.js";

// Mock gather phase dispatcher
vi.mock("../gather.js", () => ({
  runGatherPhase: vi.fn(),
  clarifiedSpecFromContext: vi.fn(),
}));
vi.mock("../../council/debate.js", () => ({
  runDebate: vi.fn(),
}));
vi.mock("../../council/preflight.js", () => ({
  runPreflight: vi.fn(),
}));

// Mock artifact-io
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn().mockResolvedValue(null),
  writeArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { runDebate } from "../../council/debate.js";
import { runPreflight } from "../../council/preflight.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";

beforeAll(async () => {
  await loadCatalog();
});

describe("runLoopDriver", () => {
  let ctx: DriverContext;
  let mockLLM: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLLM = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({ idea: "Test", persona: "User" })),
      research: vi.fn().mockResolvedValue("Mock research findings"),
    };

    ctx = {
      runId: "test-run",
      flowDir: os.tmpdir(),
      idea: "Test Idea",
      sessionModelId: getTestModels().balanced,
      llm: mockLLM,
      flags: {
        maxCost: 100,
        maxSprints: 5,
        doneThreshold: 0.8,
      },
      respondToQuestion: vi.fn().mockResolvedValue("Mock answer"),
      respondToPreflight: vi.fn().mockResolvedValue(true),
    };
  });

  it("should complete the happy path: gather -> research -> scoping -> approved", async () => {
    // 1. Mock gather phase: returns 6/6 resolved
    const mockClarifiedSpec = {
      problemStatement: "Test Idea",
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: [
        { id: "persona", question: "q1", answer: "a1" },
        { id: "core-features", question: "q2", answer: "a2" },
        { id: "non-functional", question: "q3", answer: "a3" },
        { id: "tech-constraints", question: "q4", answer: "a4" },
        { id: "success-metric", question: "q5", answer: "a5" },
        { id: "cost-tolerance", question: "q6", answer: "a6" },
      ],
      resolved: {
        persona: "answered",
        "core-features": "answered",
        "non-functional": "answered",
        "tech-constraints": "answered",
        "success-metric": "answered",
        "cost-tolerance": "answered",
      },
    };
    const mockProjectContext = {
      version: 1,
      schemaName: "project-context",
      generatedAt: "",
      idea: "Test Idea",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
      userOverrides: [],
    };
    (runGatherPhase as any).mockResolvedValue(mockProjectContext);
    (clarifiedSpecFromContext as any).mockReturnValue(mockClarifiedSpec);

    // 2. Mock Debate
    const mockDebateState = {
      spec: mockClarifiedSpec,
      exchangeLogs: new Map(),
      runningSummary: "Debate summary",
      roundCount: 1,
      researchFindings: "Some findings",
    };
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runDebate as any).mockImplementation(async function* () {
      return mockDebateState;
    });

    // 3. Mock Preflight
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runPreflight as any).mockImplementation(async function* () {
      return true; // Approved
    });

    const gen = runLoopDriver(ctx);
    const chunks: any[] = [];
    let result: any;

    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      chunks.push(value);
    }

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");

    // Verify transitions
    expect(runGatherPhase).toHaveBeenCalled();
    expect(clarifiedSpecFromContext).toHaveBeenCalled();
    expect(runDebate).toHaveBeenCalled();
    expect(runPreflight).toHaveBeenCalled();

    // Verify phase starts
    const phaseIds = chunks.filter((c) => c.type === "council_phase").map((c) => c.councilPhase.phaseId);
    expect(phaseIds).toContain("loop:gather");
    expect(phaseIds).toContain("loop:research");
    expect(phaseIds).toContain("loop:scoping");
  });

  it("should halt if gather fails to resolve enough dimensions", async () => {
    // Mock gather phase: only 2/6 resolved
    const mockClarifiedSpec = {
      problemStatement: "Test Idea",
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: [
        { id: "persona", question: "q1", answer: "a1" },
        { id: "core-features", question: "q2", answer: "a2" },
      ],
      resolved: {
        persona: "answered",
        "core-features": "answered",
      },
    };
    const mockProjectContext = {
      version: 1,
      schemaName: "project-context",
      generatedAt: "",
      idea: "Test Idea",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
      userOverrides: [],
    };
    (runGatherPhase as any).mockResolvedValue(mockProjectContext);
    (clarifiedSpecFromContext as any).mockReturnValue(mockClarifiedSpec);

    const gen = runLoopDriver(ctx);
    let result: any;
    const chunks: any[] = [];

    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      chunks.push(value);
    }

    expect(result.success).toBe(false);
    expect(result.stage).toBe("halted");
    expect(result.reason).toBe("insufficient_resolution");

    // Should NOT have called debate or preflight
    expect(runDebate).not.toHaveBeenCalled();
    expect(runPreflight).not.toHaveBeenCalled();

    // Should have emitted a council_question for manual answers
    expect(chunks.some((c) => c.type === "council_question")).toBe(true);
  });

  it("should halt if preflight is rejected", async () => {
    // 1. Mock gather phase: returns 5/6 resolved (cost-tolerance missing)
    const mockClarifiedSpec5 = {
      rawQA: [{ id: "persona", question: "q", answer: "a" }],
      resolved: {
        persona: "answered",
        "core-features": "answered",
        "non-functional": "answered",
        "tech-constraints": "answered",
        "success-metric": "answered",
      }, // 5/6 resolved — passes the <=1 unresolved gate
    };
    const mockProjectContext2 = {
      version: 1,
      schemaName: "project-context",
      generatedAt: "",
      idea: "Test Idea",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
      userOverrides: [],
    };
    (runGatherPhase as any).mockResolvedValue(mockProjectContext2);
    (clarifiedSpecFromContext as any).mockReturnValue(mockClarifiedSpec5);

    // 2. Mock Debate
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runDebate as any).mockImplementation(async function* () {
      return { runningSummary: "S", spec: { rawQA: [{}] } };
    });

    // 3. Mock Preflight: REJECTED
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runPreflight as any).mockImplementation(async function* () {
      return false;
    });

    const gen = runLoopDriver(ctx);
    let result: any;

    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
    }

    expect(result.success).toBe(false);
    expect(result.stage).toBe("halted");
    expect(result.reason).toBe("user_rejected_spec");
  });
});

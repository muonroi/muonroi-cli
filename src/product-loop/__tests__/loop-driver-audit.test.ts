import * as os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverContext } from "../types.js";

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
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn().mockResolvedValue(null),
  writeArtifact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../storage/index.js", () => ({
  logInteraction: vi.fn(),
}));

import { runDebate } from "../../council/debate.js";
import { runPreflight } from "../../council/preflight.js";
import { logInteraction } from "../../storage/index.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";
import { runLoopDriver } from "../loop-driver.js";

const mockSpec = {
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

const mockProjectCtx = {
  version: 1,
  schemaName: "project-context",
  generatedAt: "",
  idea: "Test Idea",
  detection: {},
  context: {},
  recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
  userOverrides: [],
};

function buildCtx(): DriverContext {
  return {
    runId: "audit-run",
    sessionId: "audit-session",
    flowDir: os.tmpdir(),
    idea: "Build a todo app",
    sessionModelId: "claude-sonnet-4-6",
    // biome-ignore lint/suspicious/noExplicitAny: mock surface
    llm: { generate: vi.fn().mockResolvedValue("{}"), research: vi.fn().mockResolvedValue("findings") } as any,
    flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.8 },
    respondToQuestion: vi.fn().mockResolvedValue("Mock answer"),
    respondToPreflight: vi.fn().mockResolvedValue(true),
  };
}

async function drain(gen: AsyncGenerator<unknown, unknown, unknown>): Promise<unknown> {
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

describe("loop-driver audit logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (runGatherPhase as ReturnType<typeof vi.fn>).mockResolvedValue(mockProjectCtx);
    (clarifiedSpecFromContext as ReturnType<typeof vi.fn>).mockReturnValue(mockSpec);
    // biome-ignore lint/correctness/useYield: mock generator returns immediately
    (runPreflight as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return true;
    });
  });

  // Issue #4 follow-up: the runDebate path is the one /ideal actually hits;
  // runCouncil only fires for sprint planning. A council_summary row must
  // land in interaction_logs after a successful debate.
  it("writes a council_summary row after runDebate completes", async () => {
    const debateState = {
      spec: mockSpec,
      exchangeLogs: new Map(),
      runningSummary: "We picked Muonroi.BaseTemplate. Multi-tenancy via TenantId filter.",
      roundCount: 2,
      researchFindings: "Source: bb-recipes / multi-tenant pattern",
      active: [
        { role: "research", model: "deepseek", position: "Use BB modular monolith template" },
        { role: "implement", model: "deepseek", position: "Wire shadcn + harness-react" },
      ],
    };
    // biome-ignore lint/correctness/useYield: mock generator returns immediately
    (runDebate as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return debateState;
    });

    await drain(runLoopDriver(buildCtx()));

    const calls = (logInteraction as ReturnType<typeof vi.fn>).mock.calls;
    const summary = calls.find(
      (args) =>
        args[1] === "council" && (args[2] as { eventSubtype?: string } | undefined)?.eventSubtype === "council_summary",
    );
    expect(summary).toBeDefined();
    expect(summary![0]).toBe("audit-session");

    const data = (summary![2] as { data: Record<string, unknown> }).data;
    expect(data.topic).toBe("Build a todo app");
    expect(data.roundCount).toBe(2);
    expect(data.participantCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(data.stances)).toBe(true);
    expect(data.summaryExcerpt).toContain("Muonroi.BaseTemplate");
    expect((data.summaryExcerpt as string).length).toBeLessThanOrEqual(1500);
    expect(data.researchFindingsExcerpt).toContain("multi-tenant");
  });

  // Without this row, a runDebate exception unwinds silently and the session
  // looks like "research = 0 word" in the DB — exactly the symptom that
  // motivated this audit pass.
  it("writes a council_error row when runDebate throws", async () => {
    const boom = new Error("provider 502 after retry budget");
    // biome-ignore lint/correctness/useYield: throwing generator — no yield needed
    (runDebate as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      throw boom;
    });

    await expect(drain(runLoopDriver(buildCtx()))).rejects.toThrow("provider 502");

    const calls = (logInteraction as ReturnType<typeof vi.fn>).mock.calls;
    const errRow = calls.find(
      (args) =>
        args[1] === "council" &&
        (args[2] as { eventSubtype?: string } | undefined)?.eventSubtype === "council_error" &&
        (args[2] as { data?: { stage?: string } } | undefined)?.data?.stage === "debate",
    );
    expect(errRow).toBeDefined();
    expect(errRow![0]).toBe("audit-session");
    const data = (errRow![2] as { data: Record<string, unknown> }).data;
    expect(data.phase).toBe("research");
    expect(data.error).toContain("provider 502");
    expect(typeof data.elapsedMs).toBe("number");
  });

  // logInteraction throwing must never blow up the driver — audit is best-effort.
  it("survives logInteraction failures (best-effort)", async () => {
    (logInteraction as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("db locked");
    });
    const debateState = {
      spec: mockSpec,
      exchangeLogs: new Map(),
      runningSummary: "x",
      roundCount: 1,
      researchFindings: "",
      active: [],
    };
    // biome-ignore lint/correctness/useYield: mock generator returns immediately
    (runDebate as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return debateState;
    });

    const result = (await drain(runLoopDriver(buildCtx()))) as { stage?: string; success?: boolean };
    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
  });
});

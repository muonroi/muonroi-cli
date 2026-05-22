import * as os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
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
  recordUsageEvent: vi.fn(),
}));

import { runDebate } from "../../council/debate.js";
import { runPreflight } from "../../council/preflight.js";
import { logInteraction, recordUsageEvent } from "../../storage/index.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";
import { runLoopDriver } from "../loop-driver.js";

beforeAll(async () => {
  await loadCatalog();
});

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
    sessionModelId: getTestModels().balanced,
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

  // Persist each speaker turn so forensics replay doesn't depend on TUI
  // scrollback (the only copy today — messages/usage_events stay empty
  // for the debate path).
  it("writes a council_message row for each speaker turn", async () => {
    const debateState = {
      spec: mockSpec,
      exchangeLogs: new Map(),
      runningSummary: "summary",
      roundCount: 1,
      researchFindings: "",
      active: [],
    };
    // biome-ignore lint/correctness/useYield: explicit yield via control flow
    (runDebate as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      yield {
        type: "council_message",
        councilMessage: {
          kind: "debate",
          speaker: { role: "research", model: "deepseek-flash" },
          partner: { role: "verify" },
          round: 1,
          text: "Researcher position text".repeat(300), // ~7KB to test cap
          attempts: 2,
          toolCalls: [{ name: "tavily_search" }],
        },
      };
      yield {
        type: "council_message",
        councilMessage: {
          kind: "debate",
          speaker: { role: "verify", model: "deepseek-pro" },
          partner: { role: "research" },
          round: 1,
          text: "Cost-Controller response",
          attempts: 1,
          failureReason: null,
        },
      };
      return debateState;
    });

    await drain(runLoopDriver(buildCtx()));

    const calls = (logInteraction as ReturnType<typeof vi.fn>).mock.calls;
    const messageRows = calls.filter(
      (args) =>
        args[1] === "council" && (args[2] as { eventSubtype?: string } | undefined)?.eventSubtype === "council_message",
    );
    expect(messageRows).toHaveLength(2);

    const first = (messageRows[0]![2] as { data: Record<string, unknown> }).data;
    expect(first.phase).toBe("research");
    expect(first.kind).toBe("debate");
    expect(first.speakerRole).toBe("research");
    expect(first.speakerModel).toBe("deepseek-flash");
    expect(first.partnerRole).toBe("verify");
    expect(first.round).toBe(1);
    expect(first.attempts).toBe(2);
    expect(first.toolCalls).toEqual(["tavily_search"]);
    expect((first.textExcerpt as string).length).toBeLessThanOrEqual(4000);
    expect(first.textLength).toBeGreaterThan(4000);

    const second = (messageRows[1]![2] as { data: Record<string, unknown> }).data;
    expect(second.speakerRole).toBe("verify");
    expect(second.attempts).toBe(1);
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

  // Wrapped CouncilLLM must record usage_events when the underlying debate
  // implementation invokes its onUsage callback. Without this, /ideal runs
  // ship with zero token accounting (the exact symptom we hit in 8a35be).
  it("records a usage_events row for each council LLM call", async () => {
    const debateState = {
      spec: mockSpec,
      exchangeLogs: new Map(),
      runningSummary: "x",
      roundCount: 1,
      researchFindings: "",
      active: [],
    };
    // Simulate the actual CouncilLLM by capturing the wrapped onUsage callback
    // and firing it with a usage payload. We need to access ctx.llm AFTER it's
    // been wrapped by wrapLLMForUsageTracking, so we drive runDebate through
    // its mocked generator.
    const ctx = buildCtx();
    const innerDebate = vi
      .fn()
      .mockImplementation(
        (
          _model: string,
          _system: string,
          _prompt: string,
          _signal: unknown,
          _trace: unknown,
          _opts: unknown,
          onUsage: ((u: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) => void) | undefined,
        ) => {
          onUsage?.({ inputTokens: 1200, outputTokens: 800, cachedInputTokens: 400 });
          return Promise.resolve({ text: "response", toolCalls: [] });
        },
      );
    // biome-ignore lint/suspicious/noExplicitAny: assigning to mock llm
    (ctx.llm as any).debate = innerDebate;

    // biome-ignore lint/correctness/useYield: mock generator returns immediately
    (runDebate as ReturnType<typeof vi.fn>).mockImplementation(async function* (
      _spec: unknown,
      runOpts: { topic: string; conversationContext: string; leaderModelId: string; participants: unknown[] },
      llm: {
        debate: (
          m: string,
          s: string,
          p: string,
          sig?: unknown,
          tr?: unknown,
          o?: unknown,
          onUsage?: (u: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) => void,
        ) => Promise<{ text: string }>;
      },
    ) {
      // Drive ONE debate call through the wrapped llm to trigger the recorder.
      await llm.debate("deepseek-flash", "sys", "prompt", undefined, undefined, undefined);
      void runOpts;
      return debateState;
    });

    await drain(runLoopDriver(ctx));

    const calls = (recordUsageEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0]!;
    expect(first[0]).toBe("audit-session"); // sessionId
    expect(first[1]).toBe("council"); // source
    expect(first[2]).toBe("deepseek-flash"); // modelId
    expect(first[3]).toEqual({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 400 });
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

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

import { runDiscovery } from "../discovery.js";
import { clearDiscoveryCache } from "../discovery-cache.js";
import type { DiscoveryInteractionHandler } from "../discovery-types.js";

afterEach(() => clearDiscoveryCache());

const mockHandler: DiscoveryInteractionHandler = {
  askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" }),
  showAcceptance: vi.fn().mockResolvedValue("accept"),
};

describe("runDiscovery()", () => {
  it("auto-passes on high-confidence specific prompt", async () => {
    const result = await runDiscovery(
      "fix TypeError in src/auth/login.ts:42",
      {
        taskType: "debug",
        confidence: 0.9,
        complexity: "low",
        domain: "typescript",
        outputStyle: "balanced",
        intentKind: "task",
      },
      process.cwd(),
      null,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });

  it("skips all discovery when the user explicitly says don't ask (EN + VI)", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "x", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const l1 = {
      taskType: "analyze" as const,
      confidence: 0.6, // low enough that discovery would normally interview
      complexity: "low" as const,
      domain: null,
      outputStyle: null,
      intentKind: "task" as const,
    };
    const enResult = await runDiscovery("analyze the orchestrator, just answer, don't ask", l1, process.cwd(), handler);
    expect(enResult.interviewed).toBe(false);
    expect(enResult.accepted).toBe(true);

    const viResult = await runDiscovery("phân tích orchestrator, đừng hỏi, trả lời thẳng", l1, process.cwd(), handler);
    expect(viResult.interviewed).toBe(false);
    expect(viResult.accepted).toBe(true);

    expect(handler.askQuestion).not.toHaveBeenCalled();
  });

  it("interviews user on vague prompt with handler", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const result = await runDiscovery(
      "fix auth",
      {
        taskType: "debug",
        confidence: 0.6,
        complexity: "low",
        domain: "typescript",
        outputStyle: null,
        intentKind: "task",
      },
      process.cwd(),
      handler,
    );
    expect(result.interviewed).toBe(true);
    expect(result.accepted).toBe(true);
    expect(handler.askQuestion).toHaveBeenCalled();
  });

  it("skips interview but still passes when handler is null (headless)", async () => {
    const result = await runDiscovery(
      "fix auth",
      {
        taskType: "debug",
        confidence: 0.6,
        complexity: "low",
        domain: "typescript",
        outputStyle: null,
        intentKind: "task",
      },
      process.cwd(),
      null,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });

  it("sets accepted=false when user cancels", async () => {
    const handler: DiscoveryInteractionHandler = {
      // PIL-L6 fix — debug now autofills outcome, so only the scope gap is
      // asked. First call = scope gap, second call = acceptance card.
      askQuestion: vi
        .fn()
        .mockResolvedValueOnce({ questionId: "q1", text: "done", kind: "choice" })
        .mockResolvedValue({ questionId: "q-acc", text: "cancel", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("cancel"),
    };
    const result = await runDiscovery(
      "fix auth",
      {
        taskType: "debug",
        confidence: 0.6,
        complexity: "low",
        domain: "typescript",
        outputStyle: null,
        intentKind: "task",
      },
      process.cwd(),
      handler,
    );
    expect(result.accepted).toBe(false);
  });

  it("does not swallow the original request into a generic outcome for a general prompt (B2)", async () => {
    // B2 — answering the (now-skipped) generic outcome askcard used to collapse
    // the intent to "general: Task completed", discarding the user's prompt.
    // The scope gap may still fire; the outcome must derive from the raw text.
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Task completed", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const result = await runDiscovery(
      "make the dashboard feel less cluttered",
      {
        taskType: "general",
        confidence: 0.6,
        complexity: "low",
        domain: null,
        outputStyle: null,
        intentKind: "task",
      },
      process.cwd(),
      handler,
    );
    expect(result.intentStatement).not.toBe("general: Task completed");
    expect(result.outcome).not.toBe("Task completed");
    // The original request must survive into the resolved outcome.
    expect(result.outcome.toLowerCase()).toContain("dashboard");
  });

  it("skips discovery entirely for chitchat", async () => {
    const result = await runDiscovery(
      "hi",
      { taskType: null, confidence: 0.5, complexity: "low", domain: null, outputStyle: null, intentKind: "chitchat" },
      process.cwd(),
      mockHandler,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
  });
});

describe("runDiscovery() — outcome autofill override (path-leak vs legit slash)", () => {
  const analyzeL1 = {
    taskType: "analyze" as const,
    confidence: 0.6,
    complexity: "low" as const,
    domain: null,
    outputStyle: null,
    intentKind: "task" as const,
  };

  // A handler that always picks `text` for both the interview answer and the
  // acceptance card (any non-"cancel"/"adjust" text accepts).
  const pickAnswer = (text: string): DiscoveryInteractionHandler => ({
    askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text, kind: "choice" }),
    showAcceptance: vi.fn().mockResolvedValue("accept"),
  });

  it("preserves a user outcome answer containing '/' (does not clobber with the autofilled default)", async () => {
    // Regression: the override matched ANY '/' (bare `\/` regex alt +
    // `.includes("/")`), silently replacing a legit answer like
    // "support both REST/GraphQL endpoints" with the analyze default.
    const userAnswer = "support both REST/GraphQL endpoints";
    const proposer = vi
      .fn()
      .mockResolvedValue([
        "Which API surface should the analysis target? [MODEL RECS: support both REST/GraphQL endpoints | REST only]",
      ]);
    const result = await runDiscovery(
      "review the API layer",
      analyzeL1,
      process.cwd(),
      pickAnswer(userAnswer),
      null,
      proposer,
    );
    expect(result.outcome).toBe(userAnswer);
    expect(result.outcome).not.toBe("Detailed analysis with concrete improvement recommendations");
  });

  it("preserves another 'or'-style slash answer (validate input/output schemas)", async () => {
    const userAnswer = "validate input/output schemas";
    const proposer = vi.fn().mockResolvedValue(["What should the analysis verify?"]);
    const result = await runDiscovery(
      "review the API layer",
      analyzeL1,
      process.cwd(),
      pickAnswer(userAnswer),
      null,
      proposer,
    );
    expect(result.outcome).toBe(userAnswer);
  });

  it("still overwrites a genuinely path-leaked outcome with the autofilled default", async () => {
    // Guard against over-correction: a real filesystem-path leak (scope-option
    // shape "src/cli (cli)") must STILL be replaced by the inferred outcome.
    const proposer = vi.fn().mockResolvedValue(["What scope? [MODEL RECS: src/cli (cli)]"]);
    const result = await runDiscovery(
      "review the API layer",
      analyzeL1,
      process.cwd(),
      pickAnswer("src/cli (cli)"),
      null,
      proposer,
    );
    expect(result.outcome).toBe("Detailed analysis with concrete improvement recommendations");
  });

  it("treats the 'provide my own details' meta-option as no-answer, not a literal outcome", async () => {
    // The default meta-option ("I will provide my own details / constraints")
    // is a 'no specific answer' sentinel — it must not survive verbatim as the
    // outcome. With no inferred default available (generate), it falls back to
    // the raw-derived intent rather than the sentinel string.
    const sentinel = "I will provide my own details / constraints";
    const proposer = vi.fn().mockResolvedValue(["What outcome do you expect?"]);
    const result = await runDiscovery(
      "build the user dashboard widget",
      { ...analyzeL1, taskType: "generate" },
      process.cwd(),
      pickAnswer(sentinel),
      null,
      proposer,
    );
    expect(result.outcome).not.toBe(sentinel);
    expect(result.outcome.toLowerCase()).toContain("dashboard");
  });
});

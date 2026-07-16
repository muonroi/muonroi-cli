import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ee/bridge.js", () => ({
  searchByText: vi.fn().mockResolvedValue([]),
}));

let capturedPrompt = "";
vi.mock("ai", () => ({
  generateText: vi.fn(async ({ prompt }: { prompt: string }) => {
    capturedPrompt = prompt;
    return { text: "[]" };
  }),
}));
vi.mock("../../providers/runtime.js", () => ({
  resolveModelRuntime: vi.fn(() => ({ model: {} })),
}));

import { createModelClarificationProposer, runDiscovery } from "../discovery.js";
import { clearDiscoveryCache } from "../discovery-cache.js";
import type { DiscoveryInteractionHandler, ModelCard } from "../discovery-types.js";

afterEach(() => clearDiscoveryCache());

const mockHandler: DiscoveryInteractionHandler = {
  askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" }),
};

describe("runDiscovery()", () => {
  it("proceeds without interview when the model proposes no cards", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "x", kind: "choice" }),
    };
    const proposer = vi.fn().mockResolvedValue([]);
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
      handler,
      null,
      proposer,
    );
    expect(proposer).toHaveBeenCalled();
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
    expect(handler.askQuestion).not.toHaveBeenCalled();
  });

  it("does NOT interview when no proposer is wired", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "x", kind: "choice" }),
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
      null,
      null,
    );
    expect(result.interviewed).toBe(false);
    expect(result.accepted).toBe(true);
    expect(handler.askQuestion).not.toHaveBeenCalled();
  });

  it("interviews user when the model proposes cards", async () => {
    const askQuestion = vi.fn().mockResolvedValue({ questionId: "q1", text: "Error disappears", kind: "choice" });
    const handler: DiscoveryInteractionHandler = { askQuestion };
    const modelCards: ModelCard[] = [
      {
        question: "What outcome do you expect?",
        options: [
          { label: "Error disappears", kind: "choice" },
          { label: "Not sure", kind: "freetext" },
        ],
        defaultIndex: 0,
      },
    ];
    const proposer = vi.fn().mockResolvedValue(modelCards);
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
      null,
      proposer,
    );
    expect(result.interviewed).toBe(true);
    expect(result.accepted).toBe(true);
    expect(handler.askQuestion).toHaveBeenCalled();
    expect(result.interviewTranscript).toHaveLength(1);
    expect(result.interviewTranscript[0]!.question).toBe("What outcome do you expect?");
    expect(result.interviewTranscript[0]!.answer).toBe("Error disappears");
  });

  it("records multiple cards in the interview transcript", async () => {
    const askQuestion = vi
      .fn()
      .mockResolvedValueOnce({ questionId: "q1", text: "OAuth", kind: "choice" })
      .mockResolvedValueOnce({ questionId: "q2", text: "src/auth/", kind: "choice" });
    const handler: DiscoveryInteractionHandler = { askQuestion };
    const modelCards: ModelCard[] = [
      {
        question: "Which auth method?",
        options: [
          { label: "OAuth", kind: "choice" },
          { label: "API Keys", kind: "choice" },
        ],
        defaultIndex: 0,
      },
      {
        question: "Which module?",
        options: [
          { label: "src/auth/", kind: "choice" },
          { label: "src/user/", kind: "choice" },
        ],
        defaultIndex: 0,
      },
    ];
    const proposer = vi.fn().mockResolvedValue(modelCards);
    const result = await runDiscovery(
      "add authentication",
      {
        taskType: "generate",
        confidence: 0.6,
        complexity: "low",
        domain: null,
        outputStyle: null,
        intentKind: "task",
      },
      process.cwd(),
      handler,
      null,
      proposer,
    );
    expect(result.interviewTranscript).toHaveLength(2);
    expect(result.interviewTranscript[0]!.question).toBe("Which auth method?");
    expect(result.interviewTranscript[0]!.answer).toBe("OAuth");
    expect(result.interviewTranscript[1]!.question).toBe("Which module?");
    expect(result.interviewTranscript[1]!.answer).toBe("src/auth/");
  });

  it("sets accepted=false when user picks a cancel option", async () => {
    const askQuestion = vi
      .fn()
      .mockResolvedValueOnce({ questionId: "q1", text: "Cancel this request", kind: "choice" });
    const handler: DiscoveryInteractionHandler = { askQuestion };
    const modelCards: ModelCard[] = [
      {
        question: "What outcome?",
        options: [
          { label: "Proceed", kind: "choice" },
          { label: "Cancel this request", kind: "choice", isCancel: true },
        ],
        defaultIndex: 0,
      },
    ];
    const proposer = vi.fn().mockResolvedValue(modelCards);
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
      null,
      proposer,
    );
    expect(result.accepted).toBe(false);
  });

  it("skips all discovery when the user explicitly says don't ask (EN + VI)", async () => {
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "x", kind: "choice" }),
    };
    const l1 = {
      taskType: "analyze" as const,
      confidence: 0.6,
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

describe("createModelClarificationProposer() prompt", () => {
  it("does NOT inject the scoreSufficiency regex hint for a vague/underspecified prompt", async () => {
    const proposer = createModelClarificationProposer("test-model");
    await proposer({ raw: "todo app", l1: { taskType: "generate", confidence: 0.5 } });
    expect(capturedPrompt).not.toContain("local heuristic flags this prompt as underspecified");
  });
});

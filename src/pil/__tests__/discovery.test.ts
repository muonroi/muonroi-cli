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

  it("skips discovery for low-signal general prompts (no concrete task detected)", async () => {
    // A conversational/question prompt that the classifier could not pin to a
    // concrete task type lands as taskType="general" + intentKind=null. It must
    // NOT trigger task-style clarification askcards ("expected outcome" /
    // "which codebase part") — those are a TASK feature. Regression for the
    // "Tính 17*23" misroute (a trivial math question fell into the interview).
    const handler: DiscoveryInteractionHandler = {
      askQuestion: vi.fn().mockResolvedValue({ questionId: "q1", text: "x", kind: "choice" }),
      showAcceptance: vi.fn().mockResolvedValue("accept"),
    };
    const result = await runDiscovery(
      "Tính 17*23, kèm 1 câu lý do ngắn.",
      { taskType: "general", confidence: 0.6, complexity: "low", domain: null, outputStyle: null, intentKind: null },
      process.cwd(),
      handler,
    );
    expect(result.interviewed).toBe(false);
    expect(handler.askQuestion).not.toHaveBeenCalled();
  });
});

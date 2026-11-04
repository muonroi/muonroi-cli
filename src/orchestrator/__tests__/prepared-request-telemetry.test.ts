import { describe, expect, it, vi } from "vitest";
import { logInteraction } from "../../storage/interaction-log.js";
import { createPromptMeasurer, recordPreparedRequest } from "../prompt-breakdown.js";

vi.mock("../../storage/interaction-log.js", () => ({ logInteraction: vi.fn() }));

describe("prepared request numeric evidence", () => {
  it("records call/step provenance and measured components without prompt content", async () => {
    const measure = await createPromptMeasurer("SYSTEM_SENTINEL", {});
    const measured = measure([
      { role: "user", content: "USER_SENTINEL" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "result",
            toolName: "read",
            output: { type: "text", value: "PRIVATE_RESULT_SENTINEL" },
          },
        ],
      },
    ]);
    recordPreparedRequest(
      {
        sessionId: "child",
        modelId: "fixture",
        callId: "call-1",
        stepNumber: 2,
        contextWindowTokens: 12000,
        reservedOutputTokens: 2048,
        requestPhase: "preflight",
      },
      { ...measured, contextBudgetBlocked: 1 },
    );
    expect(logInteraction).toHaveBeenCalledWith(
      "child",
      "prompt_breakdown",
      expect.objectContaining({
        model: "fixture",
        eventSubtype: "prepared",
        data: expect.objectContaining({
          callId: "call-1",
          stepNumber: 2,
          systemChars: 15,
          toolsChars: 0,
          reservedOutputTokens: 2048,
          requestPhase: "preflight",
          contextBudgetBlocked: 1,
        }),
      }),
    );
    expect(measured.historyChars + measured.toolResultsChars).toBe(measured.messagesChars);
    expect(JSON.stringify(vi.mocked(logInteraction).mock.calls)).not.toContain("SENTINEL");
  });
});

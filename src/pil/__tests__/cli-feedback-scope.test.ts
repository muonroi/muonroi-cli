import { describe, expect, it, vi } from "vitest";
import { generateTextStreamed } from "../../providers/streamed-generate.js";
import { createModelClarificationProposer } from "../discovery.js";
import { isMetaAnalysisPrompt } from "../layer6-output.js";

vi.mock("../../providers/runtime.js", () => ({ resolveModelRuntime: () => ({ model: {} }) }));
vi.mock("../../providers/streamed-generate.js", () => ({
  generateTextStreamed: vi.fn().mockResolvedValue({ text: "[]" }),
}));

describe("CLI self-evaluation in a consumer repository", () => {
  it("does not equate the working repository with CLI source or its application logs", async () => {
    const raw = "Evaluate this CLI as an agent running inside it";
    expect(isMetaAnalysisPrompt(raw)).toBe(true);
    await createModelClarificationProposer("fixture")({ raw, l1: { taskType: "analyze", confidence: 1 } });
    const prompt = String(vi.mocked(generateTextStreamed).mock.calls.at(-1)?.[0].prompt);
    expect(prompt).not.toContain("Scope is always the full project root");
    expect(prompt).toContain("consumer repository");
    expect(prompt).toContain("usage_forensics");
  });
});

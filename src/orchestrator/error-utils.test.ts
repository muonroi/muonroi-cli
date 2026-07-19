import { describe, expect, it } from "vitest";

import { InputCeilingExceededError } from "../providers/model-gate";
import { isContextLimitError } from "./error-utils";

describe("isContextLimitError", () => {
  it("recognizes provider context-limit messages", () => {
    expect(isContextLimitError(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextLimitError(new Error("prompt is too large for the model window"))).toBe(true);
    expect(isContextLimitError(new Error("too many tokens"))).toBe(true);
  });

  it("recognizes the gate's typed InputCeilingExceededError (H4)", () => {
    const err = new InputCeilingExceededError("subagent", 200_000, 128_000, {
      system: 100,
      history: 700_000,
      toolResults: 100_000,
    });
    expect(isContextLimitError(err)).toBe(true);
  });

  it("does not misclassify unrelated errors", () => {
    expect(isContextLimitError(new Error("401 unauthorized"))).toBe(false);
    expect(isContextLimitError(new Error("network timeout"))).toBe(false);
  });
});

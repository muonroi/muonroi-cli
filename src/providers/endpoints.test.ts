import { describe, expect, it } from "vitest";
import { apiBaseFor, OPENAI_COMPATIBLE_BASE_URLS } from "./endpoints.js";

describe("StepFun endpoints", () => {
  it("uses the documented standard OpenAI-compatible API base URL", () => {
    expect(apiBaseFor("stepfun")).toBe("https://api.stepfun.ai/v1");
    expect(OPENAI_COMPATIBLE_BASE_URLS.stepfun).toBe("https://api.stepfun.ai/v1");
  });
});

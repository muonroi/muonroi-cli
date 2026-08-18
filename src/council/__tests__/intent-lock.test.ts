import { describe, expect, it } from "vitest";
import { resolveRunKind } from "../index.js";

const EVAL_SYNTHESIS = '```json\n{ "type": "evaluation", "summary": "x" }\n```';

describe("resolveRunKind", () => {
  it("the locked kind wins over the synthesis JSON", () => {
    expect(resolveRunKind("implementation_plan", EVAL_SYNTHESIS)).toBe("implementation_plan");
  });

  it("falls back to the synthesis JSON when nothing was locked", () => {
    expect(resolveRunKind(undefined, EVAL_SYNTHESIS)).toBe("evaluation");
  });

  it("falls back to evaluation when neither is available", () => {
    expect(resolveRunKind(undefined, "no json here")).toBe("evaluation");
  });
});

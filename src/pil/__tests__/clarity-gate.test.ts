import { describe, expect, it } from "vitest";
import { canInferOutcome, countFileReferences, hasExplicitScope, shouldAutoPass } from "../clarity-gate.js";

describe("canInferOutcome()", () => {
  it("returns false for null taskType", () => {
    expect(canInferOutcome(null, "do something")).toBe(false);
  });
  it("returns false for general taskType", () => {
    expect(canInferOutcome("general", "fix stuff")).toBe(false);
  });
  it("returns true when prompt has error reference", () => {
    expect(canInferOutcome("debug", "fix the TypeError in login")).toBe(true);
  });
  it("returns true when prompt has file:line reference", () => {
    expect(canInferOutcome("debug", "fix auth.ts:42")).toBe(true);
  });
  it("returns true when prompt has target state verb", () => {
    expect(canInferOutcome("refactor", "should return a Promise")).toBe(true);
  });
  it("returns true when prompt has add pattern", () => {
    expect(canInferOutcome("generate", "add validation to login form")).toBe(true);
  });
  it("returns false for vague prompt with valid taskType", () => {
    expect(canInferOutcome("debug", "fix auth")).toBe(false);
  });
});

describe("countFileReferences()", () => {
  it("counts .ts and .tsx files", () => {
    expect(countFileReferences("fix login.ts and dashboard.tsx")).toBe(2);
  });
  it("returns 0 for no file refs", () => {
    expect(countFileReferences("fix the auth module")).toBe(0);
  });
  it("ignores non-code extensions", () => {
    expect(countFileReferences("see report.pdf")).toBe(0);
  });
});

describe("hasExplicitScope()", () => {
  it("detects src/ paths", () => {
    expect(hasExplicitScope("refactor src/auth/jwt.ts")).toBe(true);
  });
  it("detects lib/ paths", () => {
    expect(hasExplicitScope("update lib/utils")).toBe(true);
  });
  it("returns false for no path", () => {
    expect(hasExplicitScope("refactor the code")).toBe(false);
  });
});

describe("shouldAutoPass()", () => {
  it("auto-passes high-confidence + specific file + inferrable outcome", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "debug", complexity: "low" },
        "fix TypeError in src/auth/login.ts:42",
      ),
    ).toBe(true);
  });
  it("rejects low confidence", () => {
    expect(
      shouldAutoPass({ confidence: 0.6, taskType: "debug", complexity: "low" }, "fix TypeError in login.ts:42"),
    ).toBe(false);
  });
  it("rejects vague prompt despite high confidence", () => {
    expect(shouldAutoPass({ confidence: 0.9, taskType: "debug", complexity: "low" }, "fix auth")).toBe(false);
  });
  it("rejects high complexity", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "refactor", complexity: "high" },
        "refactor src/auth/login.ts should return Promise",
      ),
    ).toBe(false);
  });
  it("auto-passes with explicit scope path even without file extension", () => {
    expect(
      shouldAutoPass(
        { confidence: 0.9, taskType: "refactor", complexity: "medium" },
        "refactor src/auth/ module to return Promises",
      ),
    ).toBe(true);
  });
});

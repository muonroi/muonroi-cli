import { describe, expect, it } from "vitest";
import { resolveMockLlmDir } from "../delegations.js";

// A fixture-backed parent must hand its background workers the SAME fixture dir
// it loaded itself. Commander keeps the last occurrence of a repeated
// single-value option, and the harness helper passes a default dir before the
// spec's own (tests/harness/helpers.ts), so first-match forwarding sent workers
// to a different fixture than the parent.
describe("resolveMockLlmDir", () => {
  it("returns undefined when the flag is absent", () => {
    expect(resolveMockLlmDir(["bun", "src/index.ts", "--agent-mode"])).toBeUndefined();
  });

  it("forwards the last --mock-llm <dir>, matching what the parent loaded", () => {
    expect(
      resolveMockLlmDir([
        "bun",
        "src/index.ts",
        "--mock-llm",
        "/fixtures/default",
        "-k",
        "x",
        "--mock-llm",
        "/spec/fix",
      ]),
    ).toBe("/spec/fix");
  });

  it("handles the --mock-llm=<dir> form and mixed forms, last wins", () => {
    expect(resolveMockLlmDir(["bun", "e", "--mock-llm=/a"])).toBe("/a");
    expect(resolveMockLlmDir(["bun", "e", "--mock-llm=/a", "--mock-llm", "/b"])).toBe("/b");
    expect(resolveMockLlmDir(["bun", "e", "--mock-llm", "/a", "--mock-llm=/b"])).toBe("/b");
  });

  it("ignores a trailing flag with no value", () => {
    expect(resolveMockLlmDir(["bun", "e", "--mock-llm", "/a", "--mock-llm"])).toBe("/a");
  });
});

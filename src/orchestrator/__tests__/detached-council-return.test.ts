import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestModels, registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { Agent } from "../orchestrator.js";

const councilFixture = vi.hoisted(() => ({ result: "COUNCIL_SAVED_ADVICE", failure: false }));
vi.mock("../../council/index.js", () => ({
  runCouncil: async function* () {
    if (councilFixture.failure) throw new Error("actual council fixture error");
    yield { type: "content", content: councilFixture.result };
    yield { type: "done" };
    return councilFixture.result;
  },
  extractReadableSynthesis: (value: string) => value,
  buildNeutralPostCouncilContinuation: (value: string) => `Continue from ${value}`,
}));
beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});
afterEach(() => {
  vi.restoreAllMocks();
  councilFixture.result = "COUNCIL_SAVED_ADVICE";
  councilFixture.failure = false;
});
describe("detached council return-only lifecycle", () => {
  it("passes the host evidence sink into the real council LLM factory", async () => {
    const module = await import("../../council/llm.js");
    const factory = vi.spyOn(module, "createCouncilLLM");
    const cwd = mkdtempSync(join(tmpdir(), "council-evidence-sink-"));
    const agent = new Agent("fixture-key", undefined, getTestModels().fast, 2, {
      persistSession: false,
      executionRole: "infrastructure",
    });
    vi.spyOn((agent as any).bash, "getCwd").mockReturnValue(cwd);
    const onCouncilToolResult = vi.fn();
    try {
      for await (const _chunk of agent.runCouncilV2("Host evidence", {
        infrastructure: true,
        skipClarification: true,
        skipPil: true,
        suppressPostDebate: true,
        returnOnly: true,
        onCouncilToolResult,
      })) {
        /* drain */
      }
      expect(factory.mock.calls[0]?.[4]).toBe(onCouncilToolResult);
    } finally {
      await agent.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it.each([
    "success",
    "empty",
    "failure",
  ])("preserves %s advice/error without starting a no-session main turn", async (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), "council-return-only-"));
    const agent = new Agent("fixture-key", undefined, getTestModels().fast, 2, {
      persistSession: false,
      executionRole: "infrastructure",
    });
    const internal = agent as any;
    vi.spyOn(internal.bash, "getCwd").mockReturnValue(cwd);
    const process = vi.spyOn(agent, "processMessage").mockImplementation(async function* () {
      yield* [];
      throw new Error("UNINTENDED_NO_SESSION_CONTINUATION");
    });
    const cleanup = vi.spyOn(internal.councilManager, "releasePendingWaits");
    if (scenario === "empty") councilFixture.result = "";
    if (scenario === "failure") councilFixture.failure = true;
    try {
      const chunks = [];
      let failure: unknown;
      try {
        for await (const chunk of agent.runCouncilV2("Explicit background advice", {
          infrastructure: true,
          skipClarification: true,
          skipPil: true,
          suppressPostDebate: true,
          suppressPreDebateCards: true,
          returnOnly: true,
        }))
          chunks.push(chunk);
      } catch (err) {
        failure = err;
      }
      expect(process).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
      expect(internal.abortController).toBeNull();
      if (scenario === "success") {
        expect(agent.getCouncilSynthesis()).toBe("COUNCIL_SAVED_ADVICE");
        expect(chunks.some((c) => c.type === "error")).toBe(false);
        expect(chunks.at(-1)?.type).toBe("done");
      }
      if (scenario === "failure") expect(String(failure)).toContain("actual council fixture error");
      if (scenario === "empty") expect(agent.getCouncilSynthesis() ?? "").toBe("");
    } finally {
      await agent.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

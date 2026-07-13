/**
 * clarifier-research-first.test.ts
 *
 * Research-first grounding (Task #9): the clarifier researches the topic BEFORE
 * asking any question, so the question-generator targets evidence-based gray
 * areas instead of guessing blind. The research brief is appended to the
 * conversationContext that every round's clarify prompt reads. Both /council and
 * /ideal (which reuses this clarifier) inherit it from one code path.
 *
 * Default ON; opt out with MUONROI_CLARIFY_RESEARCH_FIRST=0. Never blocks the
 * interview — a missing research method or a failing research call degrades to
 * the prior clarify-first behaviour.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { runClarification } from "../clarifier.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "../types.js";

async function drain(gen: AsyncGenerator<StreamChunk, ClarifiedSpec, unknown>): Promise<ClarifiedSpec> {
  let res: IteratorResult<StreamChunk, ClarifiedSpec>;
  do {
    res = await gen.next();
  } while (!res.done);
  return res.value;
}

const answer: QuestionResponder = vi.fn().mockResolvedValue("some answer");

const SPEC_JSON = JSON.stringify({
  problemStatement: "Build X",
  constraints: [],
  successCriteria: ["A works", "B works", "C works"],
  scope: "in: X; out: Y",
});

afterEach(() => {
  process.env.MUONROI_CLARIFY_RESEARCH_FIRST = undefined;
});

describe("clarifier research-first grounding", () => {
  it("researches BEFORE asking, and injects the brief into the clarify prompt", async () => {
    const order: string[] = [];
    const research = vi.fn(async () => {
      order.push("research");
      return "FINDING: the storage schema is unspecified and forks the design.";
    });
    const generate = vi.fn(async (_model: string, system: string, prompt: string) => {
      order.push("generate");
      if (system.includes("debate facilitator")) return JSON.stringify({ ready: true, confidence: 0.9, gaps: [] });
      if (system.includes("synthesizing") || system.includes("extracting")) return SPEC_JSON;
      // clarify_questions: the prompt MUST already carry the research brief.
      expect(prompt).toContain("## Scope Research");
      expect(prompt).toContain("storage schema is unspecified");
      return JSON.stringify([{ question: "Which storage schema?", why: "research flagged it", isRequired: true }]);
    });
    const llm = { generate, research } as unknown as CouncilLLM;

    const spec = await drain(runClarification("Build X", "leader-model", "", answer, llm));

    // Research ran, and it ran before the first generate (clarify) call.
    expect(research).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("research");
    expect(order.indexOf("research")).toBeLessThan(order.indexOf("generate"));
    expect(spec.successCriteria.length).toBeGreaterThanOrEqual(3);
  });

  it("skips research when MUONROI_CLARIFY_RESEARCH_FIRST=0", async () => {
    process.env.MUONROI_CLARIFY_RESEARCH_FIRST = "0";
    const research = vi.fn(async () => "brief");
    const generate = vi.fn(async (_m: string, system: string) => {
      if (system.includes("debate facilitator")) return JSON.stringify({ ready: true, confidence: 0.9, gaps: [] });
      if (system.includes("synthesizing") || system.includes("extracting")) return SPEC_JSON;
      return "[]";
    });
    const llm = { generate, research } as unknown as CouncilLLM;

    await drain(runClarification("Build X", "leader-model", "", answer, llm));
    expect(research).not.toHaveBeenCalled();
  });

  it("does not block the interview when research throws", async () => {
    const research = vi.fn(async () => {
      throw new Error("research upstream 500");
    });
    const generate = vi.fn(async (_m: string, system: string, prompt: string) => {
      if (system.includes("debate facilitator")) return JSON.stringify({ ready: true, confidence: 0.9, gaps: [] });
      if (system.includes("synthesizing") || system.includes("extracting")) return SPEC_JSON;
      // No scope research section when research failed — clarify still runs.
      expect(prompt).not.toContain("## Scope Research");
      return "[]";
    });
    const llm = { generate, research } as unknown as CouncilLLM;

    const spec = await drain(runClarification("Build X", "leader-model", "", answer, llm));
    expect(research).toHaveBeenCalledTimes(1);
    expect(spec.problemStatement).toBeTruthy();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { judgeReadiness, MAX_CLARIFY_ROUNDS, runClarification } from "../clarifier.js";
import type { ClarifiedSpec, CouncilLLM, QuestionResponder } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain the generator and return the final ClarifiedSpec. */
async function _drain(gen: AsyncGenerator<StreamChunk, ClarifiedSpec, unknown>): Promise<ClarifiedSpec> {
  let result: ClarifiedSpec | undefined;
  let done = false;
  while (!done) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      done = true;
    }
  }
  return result!;
}

/** Count "clarification_round active" phase events emitted by the generator. */
async function countRounds(
  gen: AsyncGenerator<StreamChunk, ClarifiedSpec, unknown>,
): Promise<{ rounds: number; spec: ClarifiedSpec }> {
  let rounds = 0;
  let spec: ClarifiedSpec | undefined;
  let done = false;
  while (!done) {
    const next = await gen.next();
    if (next.done) {
      spec = next.value;
      done = true;
    } else if (
      next.value.type === "council_phase" &&
      (next.value as any).councilPhase?.kind === "clarification_round" &&
      (next.value as any).councilPhase?.state === "active"
    ) {
      rounds++;
    }
  }
  return { rounds, spec: spec! };
}

// ---------------------------------------------------------------------------
// Shared mock responder — always answers "some answer"
// ---------------------------------------------------------------------------
const alwaysAnswer: QuestionResponder = vi.fn().mockResolvedValue("some answer");

// ---------------------------------------------------------------------------
// Test A: judgeReadiness returns ready=true after round 1 → loop exits early
// ---------------------------------------------------------------------------
describe("P5 ready-gate: Test A — judge ready after round 1", () => {
  it("exits loop after 1 round and populates spec.ready + spec.confidenceScore", async () => {
    // First call: returns a clarification question
    // Second call (judgeReadiness): returns ready=true
    // Spec synthesis call: returns a valid spec JSON
    let callCount = 0;
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // clarify_questions round 1
          return JSON.stringify([{ question: "What is the target platform?", why: "Scope clarity", isRequired: true }]);
        }
        if (callCount === 2) {
          // judgeReadiness verdict — ready after round 1
          return JSON.stringify({ ready: true, confidence: 0.9, gaps: [] });
        }
        // spec_synthesis
        return JSON.stringify({
          problemStatement: "Build a todo app",
          constraints: ["web only"],
          successCriteria: ["User can add tasks", "User can mark done"],
          scope: "Single user, local storage",
        });
      }),
    } as any;

    const gen = runClarification("Build a todo app", "leader-model", "", alwaysAnswer, mockLLM);
    const { rounds, spec } = await countRounds(gen);

    expect(rounds).toBe(1);
    expect(spec.ready).toBe(true);
    expect(spec.confidenceScore).toBeGreaterThan(0);
    expect(spec.clarifyHistory).toHaveLength(1);
    expect(spec.remainingGaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test B: judge returns ready=false for 3 rounds, then ready=true on round 4
// ---------------------------------------------------------------------------
describe("P5 ready-gate: Test B — judge ready at round 4", () => {
  it("runs 4 rounds and history has 4 entries", async () => {
    let callCount = 0;
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockImplementation(async () => {
        callCount++;
        // Pattern: clarify_q → judge → clarify_q → judge → ... (interleaved)
        // Calls: 1=q1, 2=judge1(not ready), 3=q2, 4=judge2(not ready),
        //        5=q3, 6=judge3(not ready), 7=q4, 8=judge4(ready), 9=synthesis
        const judgeCallNums = [2, 4, 6, 8];
        if (judgeCallNums.includes(callCount)) {
          const isLastJudge = callCount === 8;
          return JSON.stringify({
            ready: isLastJudge,
            confidence: isLastJudge ? 0.85 : 0.4,
            gaps: isLastJudge ? [] : ["Target platform not specified.", "Authentication method unclear."],
          });
        }
        if (callCount === 9) {
          // spec synthesis
          return JSON.stringify({
            problemStatement: "Build a todo app",
            constraints: [],
            successCriteria: ["Tasks can be added"],
            scope: "Web app",
          });
        }
        // clarify_questions
        return JSON.stringify([{ question: `Question ${callCount}`, why: "Gap", isRequired: true }]);
      }),
    } as any;

    const gen = runClarification("Build a todo app", "leader-model", "", alwaysAnswer, mockLLM);
    const { rounds, spec } = await countRounds(gen);

    expect(rounds).toBe(4);
    expect(spec.clarifyHistory).toHaveLength(4);
    expect(spec.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test C: judge always returns ready=false → loop caps at MAX_CLARIFY_ROUNDS
// ---------------------------------------------------------------------------
describe("P5 ready-gate: Test C — hard cap at MAX_CLARIFY_ROUNDS", () => {
  it(`caps at ${MAX_CLARIFY_ROUNDS} rounds, spec.ready=false, remainingGaps non-empty`, async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockImplementation(async (_modelId: string, system: string) => {
        // Distinguish clarify prompt (system contains "clarification questions")
        // from judge prompt (system contains "debate facilitator")
        // from synthesis prompt (system contains "synthesizing")
        if (system.includes("debate facilitator")) {
          return JSON.stringify({ ready: false, confidence: 0.2, gaps: ["Gap A.", "Gap B."] });
        }
        if (system.includes("synthesizing") || system.includes("extracting")) {
          return JSON.stringify({
            problemStatement: "Build something",
            constraints: [],
            successCriteria: ["Something works"],
            scope: "TBD",
          });
        }
        // clarify_questions
        return JSON.stringify([{ question: "Some question?", why: "Gap", isRequired: true }]);
      }),
    } as any;

    const gen = runClarification("Build something vague", "leader-model", "", alwaysAnswer, mockLLM);
    const { rounds, spec } = await countRounds(gen);

    expect(rounds).toBe(MAX_CLARIFY_ROUNDS);
    expect(spec.ready).toBe(false);
    expect(spec.remainingGaps?.length ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test E: clarifier asks ZERO questions → spec.ready=true, judge NOT called
// (de-robotized prompt now commonly returns [] — the gate must reflect that,
//  not stay at its not-ready default, and must not pay for a judge LLM call.)
// ---------------------------------------------------------------------------
describe("P5 ready-gate: Test E — zero questions ⇒ ready without a judge call", () => {
  it("marks spec.ready=true and skips the readiness judge when the clarifier asks nothing", async () => {
    let callCount = 0;
    const generate = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return "[]"; // clarify round 0: nothing to ask
      // spec synthesis (if reached) — no judge call should occur on this path
      return JSON.stringify({
        problemStatement: "Add a retry to the EE bridge",
        constraints: [],
        successCriteria: ["Retries once on transient failure"],
        scope: "EE bridge only",
      });
    });
    const mockLLM: CouncilLLM = { generate } as any;

    const gen = runClarification(
      "Add a retry to the EE bridge",
      "leader-model",
      "## Current Project\nTypeScript CLI",
      alwaysAnswer,
      mockLLM,
    );
    const spec = await _drain(gen);

    expect(spec.ready).toBe(true);
    expect(spec.confidenceScore).toBe(1);
    expect(spec.remainingGaps).toEqual([]);
    expect(spec.clarifyHistory).toEqual([]);
    // The readiness judge ("debate facilitator" system prompt) must NOT fire.
    const judgeCalled = generate.mock.calls.some(
      ([, system]: any[]) => typeof system === "string" && system.includes("debate facilitator"),
    );
    expect(judgeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test D: judgeReadiness unit tests
// ---------------------------------------------------------------------------
describe("P5 ready-gate: Test D — judgeReadiness unit", () => {
  const baseSpec: ClarifiedSpec = {
    problemStatement: "Build a REST API for a todo app",
    constraints: ["TypeScript only"],
    successCriteria: ["CRUD endpoints work", "Auth required"],
    scope: "Backend only, no UI",
    rawQA: [],
  };

  it("returns ready=true when LLM says so with detailed Q&A", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({ ready: true, confidence: 0.95, gaps: [] })),
    } as any;

    const qa = [
      { question: "What platform?", answer: "Web — Node.js backend" },
      { question: "Auth method?", answer: "JWT" },
      { question: "Database?", answer: "PostgreSQL" },
    ];

    const result = await judgeReadiness(baseSpec, "Build a REST API", qa, mockLLM, "leader-model", false);
    expect(result.ready).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.gaps).toHaveLength(0);
  });

  it("returns ready=false when topic only, no Q&A", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify({
          ready: false,
          confidence: 0.15,
          gaps: ["Deployment target not specified.", "Auth approach unknown."],
        }),
      ),
    } as any;

    const partialSpec: ClarifiedSpec = {
      problemStatement: "todo app",
      constraints: [],
      successCriteria: [],
      scope: "",
      rawQA: [],
    };

    const result = await judgeReadiness(partialSpec, "todo app", [], mockLLM, "leader-model", false);
    expect(result.ready).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it("clamps confidence to [0, 1]", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ ready: false, confidence: 1.8, gaps: ["Something missing."] })),
    } as any;

    const result = await judgeReadiness(baseSpec, "topic", [], mockLLM, "model", false);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("forces gaps=[] when ready=true regardless of LLM output", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockResolvedValue(
        // LLM contradicts itself: ready=true but also provides gaps
        JSON.stringify({ ready: true, confidence: 0.9, gaps: ["Some gap that shouldn't be here."] }),
      ),
    } as any;

    const result = await judgeReadiness(baseSpec, "topic", [], mockLLM, "model", false);
    expect(result.ready).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it("handles LLM failure gracefully — returns ready=false, confidence=0", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockRejectedValue(new Error("network error")),
    } as any;

    const result = await judgeReadiness(baseSpec, "topic", [], mockLLM, "model", false);
    expect(result.ready).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("handles malformed JSON from LLM — returns ready=false", async () => {
    const mockLLM: CouncilLLM = {
      generate: vi.fn().mockResolvedValue("not json at all"),
    } as any;

    const result = await judgeReadiness(baseSpec, "topic", [], mockLLM, "model", false);
    expect(result.ready).toBe(false);
  });
});

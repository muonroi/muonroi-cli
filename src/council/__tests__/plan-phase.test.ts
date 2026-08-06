import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planningArtifact } from "../../gsd/paths.js";
import { canExecute, readPlanVerifyVerdict, readState, setStateField } from "../../gsd/workflow-engine.js";
import type { StreamChunk } from "../../types/index.js";
import {
  buildPlannerPrompt,
  buildReviewPrompt,
  mergeReviewVerdicts,
  parsePlannerPhases,
  runPlannerPhase,
  runPlanReview,
} from "../plan-phase.js";
import type { CouncilLLM, CouncilParticipant } from "../types.js";

const MODEL_OUTPUT = `Here is the plan.

\`\`\`json
{
  "phases": [
    {
      "id": "P0",
      "title": "Sentinel E2E",
      "steps": ["Add the spy"],
      "files": ["src/council/index.ts"],
      "acceptance": ["Sentinel wins end to end"],
      "verify": "bunx vitest run src/council/__tests__/"
    }
  ]
}
\`\`\``;

describe("parsePlannerPhases", () => {
  it("extracts phases and defaults done to false", () => {
    const phases = parsePlannerPhases(MODEL_OUTPUT);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
    expect(phases[0].done).toBe(false);
    expect(phases[0].verify).toContain("vitest");
  });

  it("returns an empty array on unparseable output rather than throwing", () => {
    expect(parsePlannerPhases("the model rambled")).toEqual([]);
  });

  it("drops a phase with no acceptance criteria — an ungateable phase is not a phase", () => {
    const raw =
      '```json\n{"phases":[{"id":"P0","title":"t","steps":["s"],"files":[],"acceptance":[],"verify":""}]}\n```';
    expect(parsePlannerPhases(raw)).toEqual([]);
  });

  it("drops a null element inside a well-formed phases array instead of throwing", () => {
    const raw =
      '```json\n{"phases":[null,{"id":"P0","title":"t","steps":[],"files":[],"acceptance":["a"],"verify":""}]}\n```';
    expect(() => parsePlannerPhases(raw)).not.toThrow();
    const phases = parsePlannerPhases(raw);
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
  });

  it("drops an undefined/array/primitive element inside phases instead of throwing", () => {
    const raw = JSON.stringify({
      phases: [
        undefined,
        ["not", "an", "object"],
        "just a string",
        42,
        { id: "P0", title: "t", steps: [], files: [], acceptance: ["a"], verify: "" },
      ],
    });
    expect(() => parsePlannerPhases("```json\n" + raw + "\n```")).not.toThrow();
    const phases = parsePlannerPhases("```json\n" + raw + "\n```");
    expect(phases).toHaveLength(1);
    expect(phases[0].id).toBe("P0");
  });

  it("returns an empty array when phases is present but not an array", () => {
    const raw = '```json\n{"phases":"not-an-array"}\n```';
    expect(parsePlannerPhases(raw)).toEqual([]);
  });

  it("coerces a non-array steps/files field to an empty array rather than throwing", () => {
    const raw = JSON.stringify({
      phases: [
        {
          id: "P0",
          title: "t",
          steps: "do the thing", // malformed: string instead of string[]
          files: "src/x.ts", // malformed: string instead of string[]
          acceptance: ["it works"],
          verify: "",
        },
      ],
    });
    const phases = parsePlannerPhases("```json\n" + raw + "\n```");
    expect(phases).toHaveLength(1);
    expect(phases[0].steps).toEqual([]);
    expect(phases[0].files).toEqual([]);
    expect(phases[0].acceptance).toEqual(["it works"]);
  });

  it("drops a phase whose id is a number rather than a string", () => {
    const raw = JSON.stringify({
      phases: [{ id: 0, title: "t", steps: [], files: [], acceptance: ["a"], verify: "" }],
    });
    expect(parsePlannerPhases("```json\n" + raw + "\n```")).toEqual([]);
  });
});

describe("buildPlannerPrompt", () => {
  it("carries the synthesis and demands the phase contract", () => {
    const p = buildPlannerPrompt("topic", "SYNTHESIS-BODY", "EXCHANGES");
    expect(p).toContain("SYNTHESIS-BODY");
    expect(p).toContain("acceptance");
    expect(p).toContain("verify");
  });
});

/** Minimal CouncilLLM fake — only `generate` is exercised by runPlannerPhase. */
function fakeLlm(reply: string | (() => string)): CouncilLLM {
  return {
    generate: async () => (typeof reply === "function" ? reply() : reply),
    research: async () => {
      throw new Error("not implemented in fakeLlm");
    },
    debate: async () => {
      throw new Error("not implemented in fakeLlm");
    },
  };
}

async function drain<T>(gen: AsyncGenerator<StreamChunk, T, unknown>): Promise<{ chunks: StreamChunk[]; result: T }> {
  const chunks: StreamChunk[] = [];
  let step = await gen.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await gen.next();
  }
  return { chunks, result: step.value };
}

describe("runPlannerPhase", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("writes .planning/PLAN.md and returns its phases when the planner emits a gateable phase", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm: fakeLlm(MODEL_OUTPUT),
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.phases).toHaveLength(1);
    expect(result?.planPath).toBe(planningArtifact(cwd, "PLAN.md"));
    expect(existsSync(result!.planPath)).toBe(true);
    expect(readFileSync(result!.planPath, "utf8")).toContain("Sentinel E2E");

    const doneChunk = chunks.find(
      (c) => c.type === "council_phase" && c.councilPhase?.phaseId === "phase:plan" && c.councilPhase?.state === "done",
    );
    expect(doneChunk).toBeDefined();
  });

  it("writes NO plan and returns null when every phase is dropped for missing acceptance criteria", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const noCriteria =
      '```json\n{"phases":[{"id":"P0","title":"t","steps":["s"],"files":[],"acceptance":[],"verify":""}]}\n```';
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm: fakeLlm(noCriteria),
      }),
    );

    expect(result).toBeNull();
    expect(existsSync(planningArtifact(cwd, "PLAN.md"))).toBe(false);

    const errorChunk = chunks.find(
      (c) =>
        c.type === "council_phase" && c.councilPhase?.phaseId === "phase:plan" && c.councilPhase?.state === "error",
    );
    expect(errorChunk).toBeDefined();
  });

  it("returns null and emits a phase error when the planner call throws", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-phase-"));
    const llm: CouncilLLM = {
      generate: async () => {
        throw new Error("upstream 500");
      },
      research: async () => {
        throw new Error("not implemented in fakeLlm");
      },
      debate: async () => {
        throw new Error("not implemented in fakeLlm");
      },
    };
    const { chunks, result } = await drain(
      runPlannerPhase({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "test-model",
        llm,
      }),
    );

    expect(result).toBeNull();
    expect(existsSync(planningArtifact(cwd, "PLAN.md"))).toBe(false);
    const errorChunk = chunks.find((c) => c.type === "council_phase" && c.councilPhase?.state === "error");
    expect(errorChunk?.councilPhase?.errorMessage).toContain("upstream 500");
  });
});

describe("mergeReviewVerdicts", () => {
  it("any block blocks, and its concerns survive", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "block", concerns: ["unsafe migration"] },
    ]);
    expect(m.verdict).toBe("block");
    expect(m.concerns).toContain("unsafe migration");
  });

  it("any revise (absent a block) means revise", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "revise", concerns: ["no rollback"] },
    ]);
    expect(m.verdict).toBe("revise");
  });

  it("unanimous approve approves", () => {
    const m = mergeReviewVerdicts([
      { role: "a", verdict: "approve", concerns: [] },
      { role: "b", verdict: "approve", concerns: [] },
    ]);
    expect(m.verdict).toBe("approve");
    expect(m.concerns).toEqual([]);
  });

  it("no reviewers is a revise, never a silent approve", () => {
    expect(mergeReviewVerdicts([]).verdict).toBe("revise");
  });
});

describe("buildReviewPrompt", () => {
  it("carries the plan body, the stance name/lens, the topic, the synthesis, the participant's own position, and the verdict output contract", () => {
    const p = buildReviewPrompt(
      "PLAN-BODY-TEXT",
      "Cost Skeptic",
      "does this cost too much?",
      "TOPIC-DISTINCTIVE-MARKER",
      "SYNTHESIS-DISTINCTIVE-MARKER",
      "POSITION-DISTINCTIVE-MARKER",
    );
    expect(p).toContain("PLAN-BODY-TEXT");
    expect(p).toContain("Cost Skeptic");
    expect(p).toContain("does this cost too much?");
    expect(p).toContain("TOPIC-DISTINCTIVE-MARKER");
    expect(p).toContain("SYNTHESIS-DISTINCTIVE-MARKER");
    expect(p).toContain("POSITION-DISTINCTIVE-MARKER");
    expect(p).toContain("council-verdict");
    // The prompt must not claim a memory it does not have — the debate exchange
    // transcript is deliberately NOT injected (Finding 3: lowest marginal value
    // for the highest token cost, running once per panelist per revision cycle).
    expect(p).not.toContain("already hold the debate context");
  });

  it("bounds an oversized synthesis and position instead of shipping them unbounded", () => {
    const hugeSynthesis = "S".repeat(20_000);
    const hugePosition = "P".repeat(20_000);
    const p = buildReviewPrompt("plan", "stance", "lens", "topic", hugeSynthesis, hugePosition);
    // Both blocks were truncated — the full prompt is nowhere near the ~40,000
    // chars it would be if either injected block were passed through unbounded.
    expect(p.length).toBeLessThan(20_000);
  });
});

/** Minimal CouncilLLM fake that returns a scripted queue of replies, one per generate() call, in call order. */
function queuedLlm(replies: string[]): CouncilLLM {
  const queue = [...replies];
  return {
    generate: async () => queue.shift() ?? "",
    research: async () => {
      throw new Error("not implemented in queuedLlm");
    },
    debate: async () => {
      throw new Error("not implemented in queuedLlm");
    },
  };
}

function participant(role: string, model: string, stanceName: string, lens: string, position = ""): CouncilParticipant {
  return { role: role as CouncilParticipant["role"], model, position, stance: { name: stanceName, lens } };
}

function verdictBlock(verdict: "approve" | "revise" | "block", concerns: string[] = []): string {
  return ["```council-verdict", JSON.stringify({ verdict, concerns, evidence: [], rationale: "test" }), "```"].join(
    "\n",
  );
}

function seedPlan(cwd: string, body = "# PLAN — test\n\n## P0 — Do it\n\n**Acceptance:**\n- it works\n"): string {
  const planPath = planningArtifact(cwd, "PLAN.md");
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, body, "utf8");
  return planPath;
}

describe("runPlanReview", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("folds the stance's concrete focus into the reviewer prompt when present", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    let seenPrompt = "";
    const llm: CouncilLLM = {
      generate: async (_modelId, _system, prompt) => {
        seenPrompt = prompt;
        return verdictBlock("approve");
      },
      research: async () => {
        throw new Error("not implemented");
      },
      debate: async () => {
        throw new Error("not implemented");
      },
    };
    await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [
          {
            role: "architect" as CouncilParticipant["role"],
            model: "model-a",
            position: "",
            stance: { name: "Cost Skeptic", lens: "does this cost too much?", focus: "Cite numbers with sources only" },
          },
        ],
        llm,
      }),
    );

    expect(seenPrompt).toContain("Cite numbers with sources only");
  });

  it("threads the topic and synthesis into every reviewer's prompt, and each participant's OWN position — not another's", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    const seenPrompts: string[] = [];
    const llm: CouncilLLM = {
      generate: async (_modelId, _system, prompt) => {
        seenPrompts.push(prompt);
        return verdictBlock("approve");
      },
      research: async () => {
        throw new Error("not implemented");
      },
      debate: async () => {
        throw new Error("not implemented");
      },
    };
    await drain(
      runPlanReview({
        cwd,
        topic: "TOPIC-DISTINCTIVE-MARKER",
        synthesis: "SYNTHESIS-DISTINCTIVE-MARKER",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [
          participant("architect", "model-a", "Architect", "structure", "ARCHITECT-POSITION-MARKER"),
          participant("skeptic", "model-b", "Skeptic", "risk", "SKEPTIC-POSITION-MARKER"),
        ],
        llm,
      }),
    );

    expect(seenPrompts).toHaveLength(2);

    // Both reviewers see the same topic and synthesis...
    expect(seenPrompts[0]).toContain("TOPIC-DISTINCTIVE-MARKER");
    expect(seenPrompts[0]).toContain("SYNTHESIS-DISTINCTIVE-MARKER");
    expect(seenPrompts[1]).toContain("TOPIC-DISTINCTIVE-MARKER");
    expect(seenPrompts[1]).toContain("SYNTHESIS-DISTINCTIVE-MARKER");

    // ...but each sees only ITS OWN position, never the other's — a reviewer
    // must not be shown a debate position it did not itself argue.
    expect(seenPrompts[0]).toContain("ARCHITECT-POSITION-MARKER");
    expect(seenPrompts[0]).not.toContain("SKEPTIC-POSITION-MARKER");
    expect(seenPrompts[1]).toContain("SKEPTIC-POSITION-MARKER");
    expect(seenPrompts[1]).not.toContain("ARCHITECT-POSITION-MARKER");
  });

  it("unanimous approve writes PLAN-REVIEW.md and sets Plan Verified so readState round-trips true", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    const { chunks, result } = await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [participant("architect", "model-a", "Architect", "structure")],
        llm: queuedLlm([verdictBlock("approve")]),
      }),
    );

    expect(result.verdict).toBe("approve");
    expect(result.planVerified).toBe(true);
    expect(result.reviewPath).toBe(planningArtifact(cwd, "PLAN-REVIEW.md"));
    expect(existsSync(result.reviewPath)).toBe(true);
    expect(readFileSync(result.reviewPath, "utf8")).toContain("architect");

    // The field name is "Plan Verified" — confirm it round-trips through readState,
    // not just that setStateField was called with some string.
    expect(readState(cwd).planVerified).toBe(true);

    const doneChunk = chunks.find(
      (c) =>
        c.type === "council_phase" &&
        c.councilPhase?.phaseId === "phase:plan-review" &&
        c.councilPhase?.state === "done",
    );
    expect(doneChunk).toBeDefined();
  });

  it("any block stops immediately, clears a stale Plan Verified: yes, and does not re-enter the planner", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    // Seed a stale "yes" from a hypothetical prior approved run in this same cwd —
    // without this, readState(cwd).planVerified is false-by-default (no STATE.md
    // yet) and the assertion below cannot distinguish "correctly cleared" from
    // "never got set in the first place".
    setStateField(cwd, "Plan Verified", "yes");
    const llm = queuedLlm([verdictBlock("approve"), verdictBlock("block", ["unsafe migration"])]);
    const { result } = await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [
          participant("architect", "model-a", "Architect", "structure"),
          participant("skeptic", "model-b", "Skeptic", "risk"),
        ],
        llm,
      }),
    );

    expect(result.verdict).toBe("block");
    expect(result.planVerified).toBe(false);
    expect(result.concerns).toContain("unsafe migration");
    expect(readState(cwd).planVerified).toBe(false);
  });

  it("a reviewer with no extractable structured verdict counts as revise with a recorded concern", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Only one reviewer, budget exhausted after the default retry — the raw text
    // below has no fenced council-verdict / json block extractStructuredVerdict can parse.
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "0";
    try {
      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [participant("architect", "model-a", "Architect", "structure")],
          llm: queuedLlm(["I have opinions but no verdict block."]),
        }),
      );

      expect(result.verdict).toBe("revise");
      expect(result.concerns.some((c) => c.includes("did not emit a structured verdict"))).toBe(true);
      expect(result.planVerified).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });

  it("a reviewer call that throws is logged and counted as revise, never crashes the run", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "0";
    try {
      const llm: CouncilLLM = {
        generate: async () => {
          throw new Error("upstream 500");
        },
        research: async () => {
          throw new Error("not implemented");
        },
        debate: async () => {
          throw new Error("not implemented");
        },
      };
      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [participant("architect", "model-a", "Architect", "structure")],
          llm,
        }),
      );

      expect(result.verdict).toBe("revise");
      expect(result.concerns.some((c) => c.includes("upstream 500"))).toBe(true);
      const loggedStanceName = errSpy.mock.calls.some((call) => String(call[0]).includes("Architect"));
      expect(loggedStanceName).toBe(true);
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });

  it("an empty reviewer set merges to revise and clears a stale Plan Verified: yes", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    // Seed a stale "yes" — see the "any block" test above for why this is required
    // to make the readState assertion below capable of failing.
    setStateField(cwd, "Plan Verified", "yes");
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "0";
    try {
      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [],
          llm: queuedLlm([]),
        }),
      );

      expect(result.verdict).toBe("revise");
      expect(result.planVerified).toBe(false);
      expect(readState(cwd).planVerified).toBe(false);
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });

  it("on revise, re-enters the planner with the merged concerns folded in, bounded by the retry budget", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd, "# PLAN — test\n\n## P0 — Original\n\n**Acceptance:**\n- original\n");
    // Pin the retry budget explicitly rather than relying on the ambient default
    // (1) — a developer with MUONROI_PLAN_REVIEW_DEBATE_RETRIES exported to
    // something else in their shell would otherwise get a spurious failure here.
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "1";
    try {
      // Budget 1 → 2 total review attempts: revise, then approve. The 2nd
      // generate() call is the planner re-entry (queued between the two review
      // calls) and must echo the concern text back so we can prove it was
      // folded into the planner prompt.
      const seenPlannerPrompts: string[] = [];
      let call = 0;
      const llm: CouncilLLM = {
        generate: async (_modelId, _system, prompt) => {
          call += 1;
          if (call === 1) return verdictBlock("revise", ["no rollback plan"]);
          if (call === 2) {
            seenPlannerPrompts.push(prompt);
            return [
              "```json",
              JSON.stringify({
                phases: [
                  {
                    id: "P0",
                    title: "Revised",
                    steps: ["s"],
                    files: [],
                    acceptance: ["revised acceptance"],
                    verify: "",
                  },
                ],
              }),
              "```",
            ].join("\n");
          }
          return verdictBlock("approve");
        },
        research: async () => {
          throw new Error("not implemented");
        },
        debate: async () => {
          throw new Error("not implemented");
        },
      };

      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [participant("architect", "model-a", "Architect", "structure")],
          llm,
        }),
      );

      expect(result.verdict).toBe("approve");
      expect(result.planVerified).toBe(true);
      expect(seenPlannerPrompts[0]).toContain("no rollback plan");
      // The plan was actually rewritten by the re-entered planner.
      expect(readFileSync(planningArtifact(cwd, "PLAN.md"), "utf8")).toContain("Revised");
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });

  it("revise repeated past the retry budget stops, reports revise, and clears a stale Plan Verified: yes", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-review-"));
    seedPlan(cwd);
    // Seed a stale "yes" — see the "any block" test above for why this is required
    // to make the readState assertion below capable of failing.
    setStateField(cwd, "Plan Verified", "yes");
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "1";
    try {
      let generateCalls = 0;
      let plannerCalls = 0;
      const llm: CouncilLLM = {
        generate: async (_modelId, _system, prompt) => {
          generateCalls += 1;
          // Planner re-entry prompts ask for the json phase contract; reviewer
          // prompts ask for the council-verdict contract. Route on that so this
          // fake can serve an unbounded number of rounds without going out of sync.
          if (prompt.includes("Emit ONE fenced json block")) {
            plannerCalls += 1;
            return [
              "```json",
              JSON.stringify({
                phases: [
                  { id: "P0", title: `Round ${plannerCalls}`, steps: [], files: [], acceptance: ["a"], verify: "" },
                ],
              }),
              "```",
            ].join("\n");
          }
          return verdictBlock("revise", ["still not good enough"]);
        },
        research: async () => {
          throw new Error("not implemented");
        },
        debate: async () => {
          throw new Error("not implemented");
        },
      };

      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [participant("architect", "model-a", "Architect", "structure")],
          llm,
        }),
      );

      expect(result.verdict).toBe("revise");
      expect(result.planVerified).toBe(false);
      // The outcome's own `planVerified: false` is hardcoded on every non-approve
      // return, so it proves nothing about the actual on-disk state — assert
      // readState directly to prove the stale "yes" seeded above was really cleared.
      expect(readState(cwd).planVerified).toBe(false);
      // Retry budget 1 → 2 review passes, each with 1 participant → 2 review
      // calls + 1 planner re-entry call = 3 generate() calls, never unbounded.
      expect(generateCalls).toBe(3);
      expect(plannerCalls).toBe(1);
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });
});

// ── PLAN-VERIFY.md — the GSD mutation gate's actual read target ─────────────
//
// src/gsd/mutation-gate.ts hard-blocks every non-read-only tool call at heavy
// depth via canExecute(cwd, depth), which reads ONLY PLAN-VERIFY.md
// (readPlanVerifyVerdict) — never PLAN-REVIEW.md and never the "Plan Verified"
// STATE.md field runPlanReview also sets. Before this fix, a council-approved
// plan wrote "Plan Verified: yes" and PLAN-REVIEW.md but never PLAN-VERIFY.md,
// so canExecute kept returning "plan-verify pending" — every edit tool call in
// the execution phase that follows would have been blocked at heavy depth,
// even immediately after a unanimous panel approval.
describe("runPlanReview — PLAN-VERIFY.md (the artifact the GSD mutation gate reads)", () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("an approve writes PLAN-VERIFY.md with verdict: pass and unlocks canExecute at heavy depth", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-verify-"));
    seedPlan(cwd);
    const { result } = await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [participant("architect", "model-a", "Architect", "structure")],
        llm: queuedLlm([verdictBlock("approve")]),
      }),
    );

    expect(result.planVerifyPath).toBe(planningArtifact(cwd, "PLAN-VERIFY.md"));
    expect(existsSync(result.planVerifyPath!)).toBe(true);
    expect(readFileSync(result.planVerifyPath!, "utf8")).toMatch(/verdict:\s*pass/i);

    // The exact function the mutation gate calls (src/gsd/mutation-gate.ts:43)
    // — proves this is not just "a file with the right regex" but the real
    // integration point actually unlocking.
    expect(readPlanVerifyVerdict(cwd)).toBe("pass");
    expect(canExecute(cwd, "heavy")).toEqual({ allowed: true });
  });

  it("a block writes PLAN-VERIFY.md with verdict: block, and canExecute stays blocked at heavy depth", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-verify-"));
    seedPlan(cwd);
    const { result } = await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [participant("architect", "model-a", "Architect", "structure")],
        llm: queuedLlm([verdictBlock("block", ["unsafe migration"])]),
      }),
    );

    expect(readPlanVerifyVerdict(cwd)).toBe("block");
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
    expect(result.planVerifyPath).toBe(planningArtifact(cwd, "PLAN-VERIFY.md"));
  });

  it("a revise-budget-exhausted outcome writes PLAN-VERIFY.md with verdict: revise", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-verify-"));
    seedPlan(cwd);
    process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES = "0";
    try {
      const { result } = await drain(
        runPlanReview({
          cwd,
          topic: "topic",
          synthesis: "SYNTHESIS-BODY",
          exchanges: "EXCHANGES",
          plannerModelId: "planner-model",
          leaderModelId: "leader-model",
          participants: [participant("architect", "model-a", "Architect", "structure")],
          llm: queuedLlm([verdictBlock("revise", ["no rollback"])]),
        }),
      );

      expect(result.verdict).toBe("revise");
      expect(readPlanVerifyVerdict(cwd)).toBe("revise");
      expect(canExecute(cwd, "heavy").allowed).toBe(false);
    } finally {
      delete process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
    }
  });

  it("an approve advances STATE.md Phase to execute, satisfying canExecute's own phase check", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-verify-"));
    seedPlan(cwd);
    // Seed a STATE.md phase left over from a prior /ideal run in this cwd — without
    // this, readState(cwd).phase is null before this review runs and the "phase
    // must equal execute" branch in canExecute is trivially skipped either way.
    setStateField(cwd, "Phase", "plan");
    await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [participant("architect", "model-a", "Architect", "structure")],
        llm: queuedLlm([verdictBlock("approve")]),
      }),
    );

    expect(readState(cwd).phase).toBe("execute");
    expect(canExecute(cwd, "heavy")).toEqual({ allowed: true });
  });

  it("a missing PLAN.md still writes PLAN-VERIFY.md so a stale prior 'pass' cannot survive", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-verify-"));
    // No seedPlan(cwd) — PLAN.md does not exist, but the planning dir must, or
    // setStateField/writeFileSync below fail on a missing parent directory
    // (seedPlan is normally what creates it as a side effect).
    mkdirSync(dirname(planningArtifact(cwd, "PLAN-VERIFY.md")), { recursive: true });
    // Seed a stale prior approval: without the write under test, the gate
    // would stay OPEN on a plan that can no longer even be read, which is the
    // exact bug this write closes.
    setStateField(cwd, "Plan Verified", "yes");
    writeFileSync(planningArtifact(cwd, "PLAN-VERIFY.md"), "# PLAN-VERIFY\n\nverdict: pass\n", "utf8");
    expect(canExecute(cwd, "heavy")).toEqual({ allowed: true });

    const { result } = await drain(
      runPlanReview({
        cwd,
        topic: "topic",
        synthesis: "SYNTHESIS-BODY",
        exchanges: "EXCHANGES",
        plannerModelId: "planner-model",
        leaderModelId: "leader-model",
        participants: [participant("architect", "model-a", "Architect", "structure")],
        llm: queuedLlm([]),
      }),
    );

    expect(result.verdict).toBe("block");
    expect(result.planVerifyPath).toBe(planningArtifact(cwd, "PLAN-VERIFY.md"));
    expect(readPlanVerifyVerdict(cwd)).toBe("block");
    expect(canExecute(cwd, "heavy").allowed).toBe(false);
  });
});

/**
 * gather-agent-driven.test.ts
 *
 * Covers the unified agent-driven interview path (Task #7): when a driver wires
 * `io.emit` + `io.respondToQuestion`, `runGatherPhase` delegates the interview to
 * the SAME clarifier engine `/council` uses (`runClarification`) instead of
 * walking the fixed DISCOVERY_QUESTIONS list. The CLI injects only context — the
 * LLM leader generates every question itself.
 *
 * We mock `runClarification` (its own behaviour is covered by
 * clarifier-ready-gate.test.ts) to assert the WIRING contract:
 *   1. clarifier-emitted chunks are forwarded to io.emit (the TUI sees each card),
 *   2. the returned ProjectContext carries the clarifier's ClarifiedSpec verbatim
 *      in `clarified`,
 *   3. `clarifiedSpecFromContext` returns that spec (real successCriteria) and
 *      derives the loop-driver resolution gate from the agent's readiness verdict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarifiedSpec } from "../../council/types.js";
import type { StreamChunk } from "../../types/index.js";

// --- Heavy dependency mocks (keep the test to the gather→clarifier seam) ------

vi.mock("../discovery-detection.js", () => ({
  detectExistingProject: vi.fn(async () => ({
    isGitRepo: false,
    hasCommitHistory: false,
    srcFileCount: 0,
    manifests: [],
    languages: [],
    frameworks: [],
    classification: "greenfield" as const,
  })),
}));

vi.mock("../../council/leader.js", () => ({
  resolveLeaderModelDetailed: vi.fn(async () => ({ modelId: "leader-model" })),
}));

vi.mock("../discovery-prompt-parser.js", () => ({
  parsePromptForContext: vi.fn(async () => ({ partial: {} })),
}));

let persisted: unknown;
vi.mock("../discovery-persistence.js", () => ({
  acquireRunLock: vi.fn(async () => undefined),
  releaseRunLock: vi.fn(async () => undefined),
  resumeArtifactWriteIfNeeded: vi.fn(async () => undefined),
  readProjectContext: vi.fn(async () => null),
  initDiscoveryState: vi.fn(async () => undefined),
  readDiscoveryState: vi.fn(async () => null),
  writeProjectContext: vi.fn(async (_flowDir: string, _runId: string, ctx: unknown) => {
    persisted = ctx;
  }),
  markDone: vi.fn(async () => undefined),
}));

const CLARIFIER_SPEC: ClarifiedSpec = {
  problemStatement: "Build a URL-shortener CLI",
  constraints: ["TypeScript / Node.js"],
  successCriteria: ["Shortens a URL", "Expands a short code", "Persists the mapping"],
  scope: "Single-binary CLI, no server",
  rawQA: [{ question: "Where are mappings stored?", answer: "local JSON file" }],
  ready: true,
  confidenceScore: 0.9,
  remainingGaps: [],
  clarifyHistory: [{ question: "Where are mappings stored?", answer: "local JSON file", ts: "2026-07-13T00:00:00Z" }],
};

// runClarification is an async generator that yields one askcard then returns the
// synthesized spec — exactly the shape gather drives.
vi.mock("../../council/clarifier.js", () => ({
  runClarification: vi.fn(async function* (): AsyncGenerator<StreamChunk, ClarifiedSpec, unknown> {
    yield {
      type: "council_question",
      content: "Where are mappings stored?",
      councilQuestion: {
        questionId: "q-store",
        phase: "clarify",
        question: "Where are mappings stored?",
        isRequired: true,
        options: [],
      },
    } as StreamChunk;
    return CLARIFIER_SPEC;
  }),
}));

import { runClarification } from "../../council/clarifier.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";
import { SEED_DIMENSIONS } from "../seed-questions.js";
import type { ProjectContext } from "../types.js";

const fakeLlm = { generate: vi.fn(async () => "") } as never;

beforeEach(() => {
  persisted = undefined;
  vi.clearAllMocks();
  process.env.MUONROI_IDEAL_AGENT_INTERVIEW = "1";
});
afterEach(() => {
  process.env.MUONROI_IDEAL_AGENT_INTERVIEW = undefined;
});

describe("runGatherPhase — agent-driven interview wiring", () => {
  it("delegates to runClarification, forwards its chunks, and stashes the spec", async () => {
    const emitted: StreamChunk[] = [];
    const respondToQuestion = vi.fn(async () => "local JSON file");

    const pc = (await runGatherPhase(
      "/tmp/flow-agent-driven",
      "run-1",
      "Build a URL-shortener CLI",
      50,
      fakeLlm,
      "session-model",
      { emit: (c) => emitted.push(c), respondToQuestion },
    )) as ProjectContext;

    // 1. The clarifier engine was used (not the fixed-question walk).
    expect(runClarification).toHaveBeenCalledTimes(1);
    // 2. Its dynamically-generated askcard was forwarded to the driver.
    const cards = emitted.filter((c) => c.type === "council_question");
    expect(cards).toHaveLength(1);
    // 3. The ClarifiedSpec is carried verbatim on the ProjectContext.
    expect(pc.clarified?.successCriteria).toEqual(CLARIFIER_SPEC.successCriteria);
    // 4. It was persisted for the downstream research phase.
    expect((persisted as ProjectContext | undefined)?.clarified?.problemStatement).toBe(
      CLARIFIER_SPEC.problemStatement,
    );
  });

  it("falls back to the legacy path when no io is wired (pure-unit callers)", async () => {
    // Without emit+respondToQuestion the agent path is skipped — runClarification
    // must NOT be called (keeps context-free unit callers on the legacy engine).
    await runGatherPhase("/tmp/flow-agent-driven-2", "run-2", "x", 50, fakeLlm, "session-model").catch(() => {
      // legacy path may throw further down without io — we only assert the guard.
    });
    expect(runClarification).not.toHaveBeenCalled();
  });
});

describe("clarifiedSpecFromContext — agent-driven adapter", () => {
  function pcWith(clarified: ClarifiedSpec): ProjectContext {
    return {
      version: 1,
      schemaName: "project-context",
      generatedAt: "2026-07-13T00:00:00Z",
      idea: clarified.problemStatement,
      detection: {
        isGitRepo: false,
        hasCommitHistory: false,
        srcFileCount: 0,
        manifests: [],
        languages: [],
        frameworks: [],
        classification: "greenfield",
      },
      context: {} as ProjectContext["context"],
      clarified,
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: true } },
      userOverrides: [],
    };
  }

  it("returns the clarifier spec verbatim and marks all seed dimensions answered when ready", () => {
    const spec = clarifiedSpecFromContext(pcWith(CLARIFIER_SPEC));
    expect(spec.successCriteria).toEqual(CLARIFIER_SPEC.successCriteria);
    expect(spec.constraints).toEqual(CLARIFIER_SPEC.constraints);
    // The agent's readiness verdict drives the loop-driver resolution gate:
    // every SEED_DIMENSION resolves so the run proceeds past the halt check.
    for (const d of SEED_DIMENSIONS) expect(spec.resolved?.[d.id]).toBe("answered");
  });

  it("leaves seed dimensions unspecified when the agent judged the spec NOT ready", () => {
    const notReady: ClarifiedSpec = { ...CLARIFIER_SPEC, ready: false, remainingGaps: ["scope unclear"] };
    const spec = clarifiedSpecFromContext(pcWith(notReady));
    // The insufficient_resolution safety net must still be able to fire.
    for (const d of SEED_DIMENSIONS) expect(spec.resolved?.[d.id]).toBe("unspecified");
  });
});

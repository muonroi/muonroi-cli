/**
 * Regression cover for the `/ideal` scoping stall measured on run `mtmrm9c667d4`
 * (2026-09-04).
 *
 * What happened: the scoping synthesis completion came back truncated at the
 * provider's 4096-token output ceiling (`step-3.5-flash`, `output_tokens = 4096`
 * exactly). The old code matched it with a greedy `/\{[\s\S]*\}/` and called
 * `JSON.parse`, which threw `Unterminated string`. The catch wrote ONE
 * `interaction_logs` row and then `return`ed a `DriverResult` — yielding
 * nothing. `loop:scoping` stayed `state:"active"` forever and the whole run
 * looked, from outside, exactly like a hang.
 *
 * These tests pin the two properties that fix it:
 *   1. a truncated first attempt is retried once with a compact prompt, so the
 *      run PROCEEDS (this is why the stall was intermittent — a spec that fits
 *      under the ceiling parses first try);
 *   2. when it still cannot parse, the phase reaches a terminal state instead
 *      of being abandoned mid-flight.
 */

import * as os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { runLoopDriver } from "../loop-driver.js";
import type { DriverContext } from "../types.js";

vi.mock("../gather.js", () => ({
  runGatherPhase: vi.fn(),
  clarifiedSpecFromContext: vi.fn(),
}));
vi.mock("../../council/debate.js", () => ({
  runDebate: vi.fn(),
}));
vi.mock("../../council/preflight.js", () => ({
  runPreflight: vi.fn(),
}));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn().mockResolvedValue(null),
  writeArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { runDebate } from "../../council/debate.js";
import { runPreflight } from "../../council/preflight.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";

beforeAll(async () => {
  await loadCatalog();
});

/**
 * The literal shape the provider returned on `mtmrm9c667d4`: a well-formed
 * object cut off mid-string inside `mvp`, so the object never closes.
 */
const TRUNCATED_SPEC = `{
  "idea": "Strip diacritics and never return an empty slug",
  "persona": "Library consumer",
  "mvp": [
    "Update \`src/slugify.ts\` with NFD normalization plus a \\\\p{M} strip",
    "Implement a non-`;

const GOOD_SPEC = JSON.stringify({
  idea: "Strip diacritics",
  persona: "Library consumer",
  mvp: ["NFD normalize"],
  phase2: [],
  architecture: "pure function",
  ioContract: "string -> string",
  folderStructure: "src/",
  sprintEstimate: 1,
  costEstimate: 1,
});

const RESOLVED_ALL = {
  persona: "answered",
  "core-features": "answered",
  "non-functional": "answered",
  "tech-constraints": "answered",
  "success-metric": "answered",
  "cost-tolerance": "answered",
} as const;

function mockClarifiedSpec() {
  return {
    problemStatement: "Test Idea",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: Object.keys(RESOLVED_ALL).map((id, i) => ({ id, question: `q${i}`, answer: `a${i}` })),
    resolved: { ...RESOLVED_ALL },
  };
}

/** True for the scoping synthesis call (and its compact retry). */
function isSynthesisCall(system: string): boolean {
  return system.includes("Product Owner");
}

describe("/ideal scoping synthesis — truncated-completion recovery and announced bail", () => {
  let ctx: DriverContext;
  let synthesisReplies: string[];
  let synthesisSystems: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    synthesisSystems = [];

    const generate = vi.fn(async (_modelId: string, system: string) => {
      if (!isSynthesisCall(system)) return "{}";
      synthesisSystems.push(system);
      const next = synthesisReplies.shift();
      return next ?? GOOD_SPEC;
    });

    ctx = {
      runId: "test-run-scoping",
      flowDir: os.tmpdir(),
      idea: "Test Idea",
      sessionModelId: getTestModels().balanced,
      llm: { generate, research: vi.fn().mockResolvedValue("findings") } as unknown as DriverContext["llm"],
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.8 },
      respondToQuestion: vi.fn().mockResolvedValue("Mock answer"),
      respondToPreflight: vi.fn().mockResolvedValue(true),
    } as unknown as DriverContext;

    (runGatherPhase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 1,
      schemaName: "project-context",
      generatedAt: "",
      idea: "Test Idea",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
      userOverrides: [],
    });
    (clarifiedSpecFromContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockClarifiedSpec());
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runDebate as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return {
        spec: mockClarifiedSpec(),
        exchangeLogs: new Map(),
        runningSummary: "Debate summary",
        roundCount: 1,
        researchFindings: "Some findings",
      };
    });
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runPreflight as unknown as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      return true;
    });
  });

  async function drive(): Promise<{ chunks: any[]; result: any }> {
    const gen = runLoopDriver(ctx);
    const chunks: any[] = [];
    while (true) {
      const { value, done } = await gen.next();
      if (done) return { chunks, result: value };
      chunks.push(value);
    }
  }

  function scopingPhases(chunks: any[]): any[] {
    return chunks.filter((c) => c.type === "council_phase" && c.councilPhase.phaseId === "loop:scoping");
  }

  it("retries once with a compact prompt when the synthesis JSON is cut off, and proceeds", async () => {
    synthesisReplies = [TRUNCATED_SPEC, GOOD_SPEC];

    const { chunks, result } = await drive();

    // The run survives a truncated first attempt — this is precisely why the
    // stall was intermittent: a spec that fits under the ceiling parsed first try.
    expect(result.stage).toBe("approved");
    expect(result.success).toBe(true);

    // Exactly one retry, and it asked for a SMALLER object rather than repeating
    // the same oversized request.
    expect(synthesisSystems).toHaveLength(2);
    expect(synthesisSystems[1]).toContain("Retry directive");
    expect(synthesisSystems[1]).toMatch(/keep it SMALL/i);

    // The retry is announced on the wire, not just in the DB.
    const announced = chunks.filter(
      (c) => c.type === "content" && typeof c.content === "string" && c.content.includes("Spec synthesis attempt 1"),
    );
    expect(announced).toHaveLength(1);
    expect(announced[0].content).toContain("cut off");

    // And the phase reaches a terminal state.
    const phases = scopingPhases(chunks);
    expect(phases.map((p) => p.councilPhase.state)).toEqual(["active", "done"]);
  });

  it("closes loop:scoping with an error phase (never leaves it active) when both attempts fail", async () => {
    synthesisReplies = [TRUNCATED_SPEC, TRUNCATED_SPEC];

    const { chunks, result } = await drive();

    expect(result.stage).toBe("error");
    expect(result.reason).toBe("failed_to_synthesize_spec");
    // A machine code alone is not actionable; the bail carries a sentence the
    // caller can show.
    expect(result.detail).toBeTruthy();
    expect(String(result.detail)).toMatch(/2 attempts/);

    const phases = scopingPhases(chunks);
    // The regression: only `active` was ever emitted, so anything watching the
    // phase list saw "synthesis in progress" for the rest of the process.
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[0].councilPhase.state).toBe("active");
    const terminal = phases[phases.length - 1].councilPhase;
    expect(terminal.state).toBe("error");
    expect(terminal.errorMessage).toBeTruthy();

    // No scoping phase is left dangling in `active`.
    expect(phases.filter((p) => p.councilPhase.state === "active")).toHaveLength(1);
  });

  it("still bails with a terminal phase when the compact retry itself throws", async () => {
    synthesisReplies = [TRUNCATED_SPEC];
    const generate = ctx.llm.generate as unknown as ReturnType<typeof vi.fn>;
    const original = generate.getMockImplementation() as (
      modelId: string,
      system: string,
      prompt: string,
    ) => Promise<string>;
    generate.mockImplementation(async (modelId: string, system: string, prompt: string) => {
      if (isSynthesisCall(system) && synthesisSystems.length >= 1) {
        synthesisSystems.push(system);
        throw new Error("provider 503");
      }
      return original(modelId, system, prompt);
    });

    const { chunks, result } = await drive();

    expect(result.stage).toBe("error");
    expect(result.reason).toBe("failed_to_synthesize_spec");
    const phases = scopingPhases(chunks);
    expect(phases[phases.length - 1].councilPhase.state).toBe("error");
  });

  it("closes loop:scoping as done on the happy path", async () => {
    synthesisReplies = [GOOD_SPEC];

    const { chunks, result } = await drive();

    expect(result.stage).toBe("approved");
    expect(synthesisSystems).toHaveLength(1);
    const phases = scopingPhases(chunks);
    expect(phases.map((p) => p.councilPhase.state)).toEqual(["active", "done"]);
  });
});

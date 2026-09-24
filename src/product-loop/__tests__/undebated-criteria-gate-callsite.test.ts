/**
 * F8 — CALL-SITE PIN.
 *
 * `undebated-criteria-gate.test.ts` proves the helper is correct. That is not
 * enough here: this repo has repeatedly shipped a correct helper wired to
 * nothing, with the real path unchanged and every gate green.
 *
 * So this file drives the REAL `runLoopDriver` and asserts that the transition
 * which ran at 09:54:35 in run `mttwpmu8ee5b` — `state = "scoping"`, whose first
 * act is `logLoopEvent(ctx, "phase_start", {phase:"scoping"})` and
 * `phaseStart({phaseId:"loop:scoping"})` — actually consults the gate:
 *
 *   - a debate ending with an all-null stance row must NOT reach `loop:scoping`
 *     without an askcard first;
 *   - a debate whose criteria were all argued must reach it with no askcard at
 *     all (the gate is not a tax on normal runs).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import type { CouncilStanceRow } from "../../types/index.js";
import { runLoopDriver } from "../loop-driver.js";
import type { DriverContext } from "../types.js";
import { UNDEBATED_OPTION_ACCEPT, UNDEBATED_OPTION_NARROW } from "../undebated-criteria-gate.js";

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

const NUGET = "Bộ analyzer có thể được đóng gói thành NuGet package TCIS.CodeStandards.Analyzers";
const VS_WARNING = "Visual Studio hiển thị warning khi parameter, argument không đúng chuẩn";
const ROSTER = ["architect", "engineer"];

function stanceRow(criterion: string, met: boolean, marks: Array<"+" | "-" | "~" | null>): CouncilStanceRow {
  const stances: CouncilStanceRow["stances"] = {};
  ROSTER.forEach((r, i) => {
    stances[r] = marks[i] ?? null;
  });
  return { criterion, met, stances };
}

const RESOLVED_SIX = {
  persona: "answered",
  "core-features": "answered",
  "non-functional": "answered",
  "tech-constraints": "answered",
  "success-metric": "answered",
  "cost-tolerance": "answered",
};

beforeAll(async () => {
  await loadCatalog();
});

describe("loop-driver research→scoping consults the undebated-criteria gate", () => {
  let ctx: DriverContext;
  let clarifiedSpec: any;
  let synthesisPrompts: string[];
  // A FRESH run dir per test. The file used to pin `flowDir: os.tmpdir()` with a
  // fixed runId, so every test in it — and every process that ever ran it —
  // shared one `runs/f8-callsite` directory. That was invisible until the gate
  // began persisting its record there: the "accept" answered in one test was
  // then honoured in the next, and the gate correctly stopped asking. Shared
  // run state between tests is the bug; the honouring is the feature.
  let flowDir: string;

  function seedDebate(finalStanceRows: CouncilStanceRow[] | undefined) {
    const debateState = {
      spec: clarifiedSpec,
      exchangeLogs: new Map(),
      runningSummary: "Debate summary",
      roundCount: 2,
      researchFindings: "Findings",
      finalCriteriaMet: finalStanceRows?.map((r) => r.met),
      finalStanceRows,
    };
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runDebate as any).mockImplementation(async function* () {
      return debateState;
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    synthesisPrompts = [];
    flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "f8-callsite-"));

    clarifiedSpec = {
      problemStatement: "Chuẩn hoá code style cho TCIS",
      constraints: [],
      successCriteria: [VS_WARNING, NUGET],
      scope: "",
      rawQA: [{ id: "persona", question: "q1", answer: "a1" }],
      resolved: RESOLVED_SIX,
    };

    (runGatherPhase as any).mockResolvedValue({
      version: 1,
      schemaName: "project-context",
      generatedAt: "",
      idea: "Test Idea",
      detection: {},
      context: {},
      recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: false } },
      userOverrides: [],
    });
    (clarifiedSpecFromContext as any).mockReturnValue(clarifiedSpec);
    // biome-ignore lint/correctness/useYield: intentional mock generator
    (runPreflight as any).mockImplementation(async function* () {
      return true;
    });

    ctx = {
      runId: "f8-callsite",
      flowDir,
      idea: "Chuẩn hoá code style cho TCIS",
      sessionModelId: getTestModels().balanced,
      llm: {
        // Capture the scoping synthesis prompt so "narrow" is observable in the
        // artifact the next phase actually reads.
        generate: vi.fn(async (_model: string, _system: string, prompt: string) => {
          synthesisPrompts.push(prompt ?? "");
          return JSON.stringify({ idea: "Test", persona: "User", mvp: [], phase2: [] });
        }),
        research: vi.fn().mockResolvedValue("Mock research findings"),
      } as any,
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.8 },
      respondToQuestion: vi.fn().mockResolvedValue(UNDEBATED_OPTION_ACCEPT),
      respondToPreflight: vi.fn().mockResolvedValue(true),
    } as DriverContext;
  });

  afterEach(async () => {
    await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {
      /* temp dir cleanup is best-effort */
    });
  });

  async function run() {
    const gen = runLoopDriver(ctx);
    const chunks: any[] = [];
    let result: any;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      chunks.push(value);
    }
    const phaseIds = chunks.filter((c) => c.type === "council_phase").map((c) => c.councilPhase.phaseId);
    const cards = chunks.filter((c) => c.type === "council_question");
    return { chunks, result, phaseIds, cards };
  }

  it("HALTS before loop:scoping when nobody argued a pinned criterion and nobody answers", async () => {
    seedDebate([stanceRow(VS_WARNING, false, ["+", "-"]), stanceRow(NUGET, false, [null, null])]);
    // Unattended: the responder never settles, exactly as it behaves headless.
    (ctx.respondToQuestion as any).mockImplementation(() => new Promise(() => {}));
    process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS = "20";
    try {
      const { result, phaseIds, cards } = await run();

      expect(result.stage).toBe("halted");
      expect(result.reason).toBe("undebated_criteria");
      // The card named the criterion, not a count.
      expect(result.detail).toContain("NuGet");
      // The 09:54:35 transition never happened.
      expect(phaseIds).toContain("loop:research");
      expect(phaseIds).not.toContain("loop:scoping");
      // …and the human was asked, on the askcard-open surface.
      const gateCard = cards.find((c) => c.councilQuestion?.context?.includes(NUGET));
      expect(gateCard).toBeDefined();
      expect(gateCard.councilQuestion.options.map((o: any) => o.value)).toContain(UNDEBATED_OPTION_NARROW);
    } finally {
      delete process.env.MUONROI_UNDEBATED_GATE_TIMEOUT_MS;
    }
  });

  it("asks, then proceeds to loop:scoping when the human accepts", async () => {
    seedDebate([stanceRow(VS_WARNING, false, ["+", "-"]), stanceRow(NUGET, false, [null, null])]);
    (ctx.respondToQuestion as any).mockResolvedValue(UNDEBATED_OPTION_ACCEPT);

    const { result, phaseIds, cards } = await run();

    expect(cards.some((c) => c.councilQuestion?.context?.includes(NUGET))).toBe(true);
    expect(phaseIds).toContain("loop:scoping");
    expect(result.stage).toBe("approved");
    // Accept keeps the criterion in the spec handed to scoping.
    expect(synthesisPrompts.join("\n")).toContain(NUGET);
  });

  it("drops the undebated criterion from the scoping spec when the human narrows", async () => {
    seedDebate([stanceRow(VS_WARNING, false, ["+", "-"]), stanceRow(NUGET, false, [null, null])]);
    (ctx.respondToQuestion as any).mockResolvedValue(UNDEBATED_OPTION_NARROW);

    const { result, phaseIds } = await run();

    expect(phaseIds).toContain("loop:scoping");
    expect(result.stage).toBe("approved");
    const prompt = synthesisPrompts.join("\n");
    // The sprint planner can no longer build a goal around the undebated one…
    expect(prompt).not.toContain("NuGet");
    // …while the criterion the panel DID argue survives untouched.
    expect(prompt).toContain("Visual Studio");
  });

  it("does NOT fire on an argued-but-unmet criterion — straight to loop:scoping", async () => {
    seedDebate([stanceRow(VS_WARNING, false, ["+", "-"]), stanceRow(NUGET, false, ["-", "~"])]);

    const { result, phaseIds, cards } = await run();

    expect(cards).toEqual([]);
    expect(ctx.respondToQuestion).not.toHaveBeenCalled();
    expect(phaseIds).toContain("loop:scoping");
    expect(result.stage).toBe("approved");
  });

  it("does NOT fire when every criterion was engaged", async () => {
    seedDebate([stanceRow(VS_WARNING, true, ["+", "+"]), stanceRow(NUGET, true, ["+", "~"])]);

    const { result, phaseIds, cards } = await run();

    expect(cards).toEqual([]);
    expect(phaseIds).toContain("loop:scoping");
    expect(result.stage).toBe("approved");
  });

  it("does NOT fire when the debate produced no stance rows at all", async () => {
    // Missing data is not evidence of silence.
    seedDebate(undefined);

    const { result, phaseIds, cards } = await run();

    expect(cards).toEqual([]);
    expect(phaseIds).toContain("loop:scoping");
    expect(result.stage).toBe("approved");
  });
});

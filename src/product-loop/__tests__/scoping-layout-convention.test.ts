/**
 * scoping-layout-convention.test.ts — S7 proof that the CB-1 scoping-synthesis
 * prompt is grounded in the repo's OWN observed layout, and that the emitted
 * spec is checked against that same convention after the model returns it.
 *
 * Two live-run bugs motivate this (see spec-layout-check.ts doc comment): a
 * spec's `folderStructure` invented a path outside the repo's real convention,
 * and a solution-registration bug (S6) that followed from it. F4b's
 * `layout-convention.ts` already reaches the per-SPRINT planner
 * (sprint-runner-layout-convention.test.ts); this file proves the SAME
 * evidence reaches the point where the spec text itself is produced, and that
 * a mismatch between the two is recorded rather than silently ignored.
 *
 * Mirrors the mocking technique of `scoping-synthesis-recovery.test.ts`
 * (drive the FSM, capture the synthesis call's raw prompt) combined with
 * `sprint-runner-layout-convention.test.ts` (mock only `scanLayoutConvention`,
 * keep the real `formatLayoutConvention`/`checkSpecLayout` so assertions check
 * actual production output, not a stand-in).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestModels } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
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
// Keep the real `formatLayoutConvention` (pure rendering) so assertions check
// the actual production formatting; mock only the filesystem walk.
vi.mock("../layout-convention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout-convention.js")>();
  return { ...actual, scanLayoutConvention: vi.fn() };
});

import { runDebate } from "../../council/debate.js";
import { runPreflight } from "../../council/preflight.js";
import { clarifiedSpecFromContext, runGatherPhase } from "../gather.js";
import type { LayoutConvention } from "../layout-convention.js";
import { formatLayoutConvention, scanLayoutConvention } from "../layout-convention.js";
import { runLoopDriver } from "../loop-driver.js";

beforeAll(async () => {
  await loadCatalog();
});

/** Synthetic fixture shaped like the tcis-libraries convention, neutral naming. */
const DOTNET_STYLE_CONVENTION: LayoutConvention = {
  projectsDir: "src/src",
  projectsCount: 50,
  projectManifestName: "<Name>.csproj",
  testsDir: "src/tests",
  testsCount: 48,
  testSuffix: ".Tests",
  solutionFile: "src/Acme.sln",
  totalExamples: 98,
};

/** A spec whose folderStructure sits under the convention's real root. */
const MATCHING_SPEC = JSON.stringify({
  idea: "Analyzer",
  persona: "Library consumer",
  mvp: ["Add a code-standards analyzer"],
  phase2: [],
  architecture: "Roslyn analyzer",
  ioContract: "n/a",
  folderStructure: "src/src/Acme.CodeStandards",
  sprintEstimate: 2,
  costEstimate: 5,
});

/** The live-bug shape: a folderStructure outside the observed convention. */
const MISMATCHED_SPEC = JSON.stringify({
  idea: "Analyzer",
  persona: "Library consumer",
  mvp: ["Add a code-standards analyzer"],
  phase2: [],
  architecture: "Roslyn analyzer",
  ioContract: "n/a",
  folderStructure: "src/Acme.CodeStandards",
  sprintEstimate: 2,
  costEstimate: 5,
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

/** True for the scoping synthesis call. */
function isSynthesisCall(system: string): boolean {
  return system.includes("Product Owner");
}

describe("/ideal scoping synthesis grounds folderStructure in the repo's observed layout (S7)", () => {
  let ctx: DriverContext;
  let flowDir: string;
  let synthesisPrompts: string[];
  let nextSpec: string;

  beforeEach(() => {
    vi.clearAllMocks();
    flowDir = mkdtempSync(path.join(os.tmpdir(), "scoping-layout-"));
    synthesisPrompts = [];
    nextSpec = MATCHING_SPEC;

    const generate = vi.fn(async (_modelId: string, system: string, prompt: string) => {
      if (!isSynthesisCall(system)) return "{}";
      synthesisPrompts.push(prompt);
      return nextSpec;
    });

    ctx = {
      runId: "test-run-scoping-layout",
      flowDir,
      cwd: "/tmp/repo-under-test",
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

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  function specLayoutCheckArtifactPath(): string {
    return path.join(flowDir, "runs", ctx.runId, "spec-layout-check.json");
  }

  it("adds the observed layout convention to the synthesis prompt when one exists", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(DOTNET_STYLE_CONVENTION);
    nextSpec = MATCHING_SPEC;

    const { result } = await drive();
    expect(result.stage).toBe("approved");

    expect(scanLayoutConvention).toHaveBeenCalledWith("/tmp/repo-under-test");
    expect(synthesisPrompts).toHaveLength(1);
    const prompt = synthesisPrompts[0] as string;

    const expectedBlock = formatLayoutConvention(DOTNET_STYLE_CONVENTION);
    expect(prompt).toContain(expectedBlock);
    expect(prompt).toContain("src/src/<Name>/<Name>.csproj");
    expect(prompt).toContain("(50 found)");
    expect(prompt).toContain("src/Acme.sln");
    expect(prompt).toMatch(/folderStructure MUST follow this observed convention/);
    expect(prompt).toMatch(/MUST be registered in it/);

    // It sits before the output-format instructions, an ADDITION to the
    // existing prompt rather than a replacement of anything in it.
    const researchIdx = prompt.indexOf("Research Findings:");
    const layoutIdx = prompt.indexOf("Layout convention");
    const outputIdx = prompt.indexOf("Output ONLY a JSON object");
    expect(researchIdx).toBeGreaterThanOrEqual(0);
    expect(layoutIdx).toBeGreaterThan(researchIdx);
    expect(outputIdx).toBeGreaterThan(layoutIdx);
  });

  it("leaves the synthesis prompt byte-identical when no convention is observed", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    nextSpec = MATCHING_SPEC;

    const { result } = await drive();
    expect(result.stage).toBe("approved");

    expect(synthesisPrompts).toHaveLength(1);
    const prompt = synthesisPrompts[0] as string;
    expect(prompt).not.toContain("Layout convention");
    expect(prompt).not.toMatch(/folderStructure MUST follow/);

    // Exact byte-for-byte reconstruction of the pre-S7 template — proves the
    // addition contributes NOTHING (not even a stray blank line) when there
    // is no convention to add.
    const expected = `Synthesize a ProductSpec JSON based on the following:
Idea: Test Idea
Clarified Spec: ${JSON.stringify(mockClarifiedSpec())}
Debate Summary: Debate summary
Research Findings: Some findings

Output ONLY a JSON object matching this interface:
interface ProductSpec {
  idea: string;
  persona: string;
  mvp: string[];
  phase2: string[];
  architecture: string;
  ioContract: string;
  folderStructure: string;
  sprintEstimate: number;
  costEstimate: number;
}
`;
    expect(prompt).toBe(expected);
  });

  it("persists a mismatch finding next to the spec when folderStructure disagrees with the convention", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(DOTNET_STYLE_CONVENTION);
    nextSpec = MISMATCHED_SPEC;

    const { result } = await drive();
    expect(result.stage).toBe("approved");

    const raw = readFileSync(specLayoutCheckArtifactPath(), "utf8");
    const persisted = JSON.parse(raw);
    expect(persisted.status).toBe("mismatch");
    expect(persisted.findings).toEqual([{ path: "src/Acme.CodeStandards", expectedRoot: "src/src", kind: "project" }]);
  });

  it("persists an ok status when folderStructure matches the observed convention", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockResolvedValue(DOTNET_STYLE_CONVENTION);
    nextSpec = MATCHING_SPEC;

    const { result } = await drive();
    expect(result.stage).toBe("approved");

    const raw = readFileSync(specLayoutCheckArtifactPath(), "utf8");
    const persisted = JSON.parse(raw);
    expect(persisted.status).toBe("ok");
    expect(persisted.findings).toEqual([]);
  });

  it("a layout-convention scan failure never blocks scoping — prompt stays unaugmented and the run proceeds", async () => {
    (scanLayoutConvention as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("EACCES: permission denied"));
    nextSpec = MATCHING_SPEC;

    const { result } = await drive();
    expect(result.stage).toBe("approved");

    expect(synthesisPrompts).toHaveLength(1);
    expect(synthesisPrompts[0]).not.toContain("Layout convention");

    // checkSpecLayout(folderStructure, null) is "unknown" when the scan
    // itself failed — persisted for consistency, never "mismatch".
    const raw = readFileSync(specLayoutCheckArtifactPath(), "utf8");
    const persisted = JSON.parse(raw);
    expect(persisted.status).toBe("unknown");
  });
});

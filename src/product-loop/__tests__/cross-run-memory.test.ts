import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilLLM } from "../../council/types.js";
import { writeManifest } from "../artifact-io.js";
import { buildPriorContext, discoverPriorRuns, formatPriorContextForPrompt } from "../cross-run-memory.js";

function makeStubLLM(generated: string): CouncilLLM {
  return {
    generate: vi.fn().mockResolvedValue(generated),
    debate: vi.fn(),
    research: vi.fn(),
    generateObject: vi.fn(),
  } as unknown as CouncilLLM;
}

async function seedRun(
  flowDir: string,
  runId: string,
  idea: string,
  opts: {
    pass?: boolean;
    failedCondition?: import("../types.js").DoneCondition;
    daysOld?: number;
    memories?: Record<string, string>;
  } = {},
) {
  const createdAt = new Date(Date.now() - (opts.daysOld ?? 0) * 24 * 60 * 60 * 1000);
  await writeManifest(flowDir, runId, {
    idea,
    capUsd: 50,
    maxSprints: 8,
    doneThreshold: 0.9,
    createdAt,
    verdict:
      opts.pass !== undefined
        ? { pass: opts.pass, score: opts.pass ? 0.92 : 0.5, failedCondition: opts.failedCondition }
        : undefined,
  });
  if (opts.memories) {
    const memoryDir = path.join(flowDir, "runs", runId, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    for (const [slot, content] of Object.entries(opts.memories)) {
      await fs.writeFile(path.join(memoryDir, `${slot}.md`), content);
    }
  }
}

describe("cross-run-memory (P5)", () => {
  let flowDir: string;

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `xrm-test-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
  });

  it("returns empty when no prior runs exist", async () => {
    const runs = await discoverPriorRuns(flowDir, "current", "anything");
    expect(runs).toEqual([]);
  });

  it("excludes current run from results", async () => {
    await seedRun(flowDir, "current", "build a pdf translator extension");
    const runs = await discoverPriorRuns(flowDir, "current", "build a pdf translator extension");
    expect(runs).toEqual([]);
  });

  it("filters out low-similarity runs", async () => {
    await seedRun(flowDir, "prior", "build a discord music bot");
    const runs = await discoverPriorRuns(flowDir, "current", "design a database migration tool");
    expect(runs.length).toBe(0);
  });

  it("keeps high-similarity runs and ranks by weight", async () => {
    await seedRun(flowDir, "prior-recent", "pdf translator browser extension", { pass: true });
    await seedRun(flowDir, "prior-old", "pdf translator chrome extension", {
      pass: false,
      failedCondition: "engineering_floor",
      daysOld: 60,
    });
    const runs = await discoverPriorRuns(flowDir, "current", "pdf translator extension for brave browser");
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe("prior-recent");
    expect(runs[0].weight).toBeGreaterThan(runs[1].weight);
    expect(runs[1].recency).toBeLessThan(runs[0].recency);
  });

  it("loads per-role memory files for qualifying runs", async () => {
    await seedRun(flowDir, "prior", "pdf translator extension", {
      pass: true,
      memories: {
        architect: "### Sprint 1\nChose Manifest V3 with content scripts.",
        tester: "### Sprint 1\nUsed Playwright for e2e tests.",
      },
    });
    const runs = await discoverPriorRuns(flowDir, "current", "pdf translator extension v2");
    expect(runs.length).toBe(1);
    expect(runs[0].memories.has("architect")).toBe(true);
    expect(runs[0].memories.get("architect")).toContain("Manifest V3");
  });

  it("buildPriorContext returns empty digest when optOut=true", async () => {
    await seedRun(flowDir, "prior", "pdf translator extension", { pass: true });
    const llm = makeStubLLM("should not be called");
    const result = await buildPriorContext({
      flowDir,
      runId: "current",
      idea: "pdf translator extension v2",
      leaderModelId: "leader-model",
      llm,
      optOut: true,
    });
    expect(result.digest).toBe("");
    expect(result.runs).toEqual([]);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("buildPriorContext condenses via leader and persists audit trail", async () => {
    await seedRun(flowDir, "prior", "pdf translator extension", {
      pass: true,
      memories: { architect: "Chose Manifest V3." },
    });
    const llm = makeStubLLM("- Use Manifest V3\n- Avoid synchronous spatial index");
    const result = await buildPriorContext({
      flowDir,
      runId: "current",
      idea: "pdf translator extension v2",
      leaderModelId: "leader-model",
      llm,
    });
    expect(result.digest).toContain("Manifest V3");
    expect(result.runs.length).toBe(1);

    const stateFile = path.join(flowDir, "runs", "current", "state.md");
    const state = await fs.readFile(stateFile, "utf8");
    expect(state).toContain("Prior Decisions Context");
    expect(state).toContain("prior");
    expect(state).toContain("Manifest V3");
  });

  it("buildPriorContext caps digest at 2KB", async () => {
    await seedRun(flowDir, "prior", "pdf translator extension", { pass: true });
    const huge = "X".repeat(5000);
    const llm = makeStubLLM(huge);
    const result = await buildPriorContext({
      flowDir,
      runId: "current",
      idea: "pdf translator extension v2",
      leaderModelId: "leader-model",
      llm,
    });
    expect(Buffer.byteLength(result.digest)).toBeLessThanOrEqual(2048 + 4); // +ellipsis
    expect(result.digest.endsWith("...")).toBe(true);
  });

  it("buildPriorContext persists 'no qualifying runs' marker when nothing matches", async () => {
    await seedRun(flowDir, "prior", "completely unrelated topic", { pass: true });
    const llm = makeStubLLM("should not be called");
    const result = await buildPriorContext({
      flowDir,
      runId: "current",
      idea: "totally different idea here",
      leaderModelId: "leader-model",
      llm,
    });
    expect(result.runs.length).toBe(0);
    expect(result.digest).toBe("");
    expect(llm.generate).not.toHaveBeenCalled();
    const stateFile = path.join(flowDir, "runs", "current", "state.md");
    const state = await fs.readFile(stateFile, "utf8");
    expect(state).toContain("no qualifying prior runs");
  });

  it("formatPriorContextForPrompt returns empty for empty digest", () => {
    expect(formatPriorContextForPrompt("")).toBe("");
    expect(formatPriorContextForPrompt("   ")).toBe("");
  });

  it("formatPriorContextForPrompt wraps non-empty digest with header", () => {
    const out = formatPriorContextForPrompt("- decision 1\n- decision 2");
    expect(out).toContain("Prior Decisions Context");
    expect(out).toContain("decision 1");
    expect(out).toContain("decision 2");
  });

  it("survives LLM failure by returning empty digest without throwing", async () => {
    await seedRun(flowDir, "prior", "pdf translator extension", { pass: true });
    const llm = {
      generate: vi.fn().mockRejectedValue(new Error("upstream 500")),
      debate: vi.fn(),
      research: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as CouncilLLM;
    const result = await buildPriorContext({
      flowDir,
      runId: "current",
      idea: "pdf translator extension v2",
      leaderModelId: "leader-model",
      llm,
    });
    expect(result.digest).toBe("");
    expect(result.runs.length).toBe(1);
  });
});

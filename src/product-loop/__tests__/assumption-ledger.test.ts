import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilLLM, DebateState } from "../../council/types.js";
import {
  type Assumption,
  blockingAssumptions,
  extractAssumptionsFromDebate,
  formatUnverifiedForSprintContext,
  mergeAssumptions,
  readLedger,
  renderLedgerSummary,
  resolveAssumption,
} from "../assumption-ledger.js";

function makeAssumption(claim: string, confidence: "high" | "medium" | "low" = "high"): Assumption {
  // The id derivation is internal; we set a stable test id via the same algorithm.
  const normalized = claim.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  const id = `a_${Math.abs(hash).toString(36).padStart(6, "0")}`;
  return {
    id,
    claim,
    raisedBy: "Skeptic",
    raisedAt: { phase: "research" },
    confidence,
    validationMethod: "manual benchmark",
    status: "unverified",
  };
}

describe("assumption-ledger (P6)", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `assumpt-test-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
  });

  it("returns empty ledger when file missing", async () => {
    const ledger = await readLedger(flowDir, runId);
    expect(ledger.version).toBe(1);
    expect(ledger.assumptions).toEqual([]);
  });

  it("merges new assumptions and persists to assumptions.json", async () => {
    const a = makeAssumption("Spatial index lookup < 5ms for 1000 spans");
    const ledger = await mergeAssumptions(flowDir, runId, [a]);
    expect(ledger.assumptions.length).toBe(1);

    const file = path.join(flowDir, "runs", runId, "assumptions.json");
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.assumptions[0].claim).toBe(a.claim);
  });

  it("merge is idempotent on identical claims", async () => {
    const a1 = makeAssumption("Same claim text");
    const a2 = makeAssumption("Same claim text");
    await mergeAssumptions(flowDir, runId, [a1]);
    const ledger = await mergeAssumptions(flowDir, runId, [a2]);
    expect(ledger.assumptions.length).toBe(1);
  });

  it("merge does not overwrite earlier raisedAt or status", async () => {
    const a = makeAssumption("Performance budget assumption");
    await mergeAssumptions(flowDir, runId, [a]);
    await resolveAssumption({
      flowDir,
      runId,
      id: a.id,
      status: "validated",
      evidence: "benchmark.test.ts:42 PASS",
      sprintN: 2,
      reason: "validated by benchmark",
    });
    // Second merge of same claim should not reset the validated status.
    const merged = await mergeAssumptions(flowDir, runId, [makeAssumption("Performance budget assumption")]);
    const target = merged.assumptions.find((x) => x.id === a.id);
    expect(target?.status).toBe("validated");
    expect(target?.evidence).toBe("benchmark.test.ts:42 PASS");
  });

  it("blockingAssumptions filters to high+unverified only", () => {
    const high = makeAssumption("Critical claim", "high");
    const medium = makeAssumption("Important claim", "medium");
    const validatedHigh = { ...makeAssumption("Already validated", "high"), status: "validated" as const };
    const blockers = blockingAssumptions({
      version: 1,
      assumptions: [high, medium, validatedHigh],
    });
    expect(blockers.length).toBe(1);
    expect(blockers[0].claim).toBe("Critical claim");
  });

  it("formatUnverifiedForSprintContext lists assumptions by confidence tag", () => {
    const high = makeAssumption("Critical perf claim", "high");
    const med = makeAssumption("Section-level claim", "medium");
    const validated = { ...makeAssumption("Done already", "high"), status: "validated" as const };
    const out = formatUnverifiedForSprintContext({
      version: 1,
      assumptions: [high, med, validated],
    });
    expect(out).toContain("[CRITICAL]");
    expect(out).toContain("[IMPORTANT]");
    expect(out).toContain("Critical perf claim");
    expect(out).toContain("Section-level claim");
    expect(out).not.toContain("Done already");
  });

  it("formatUnverifiedForSprintContext returns empty when nothing unverified", () => {
    const validated = { ...makeAssumption("All good", "high"), status: "validated" as const };
    expect(formatUnverifiedForSprintContext({ version: 1, assumptions: [validated] })).toBe("");
  });

  it("renderLedgerSummary counts by status", () => {
    const a = makeAssumption("a", "high");
    const b = { ...makeAssumption("b", "medium"), status: "validated" as const };
    const c = { ...makeAssumption("c", "low"), status: "refuted" as const };
    const summary = renderLedgerSummary({ version: 1, assumptions: [a, b, c] });
    expect(summary).toContain("Total: 3");
    expect(summary).toContain("unverified=1");
    expect(summary).toContain("validated=1");
    expect(summary).toContain("refuted=1");
  });

  it("resolveAssumption updates status and resolvedAt", async () => {
    const a = makeAssumption("Resolvable claim");
    await mergeAssumptions(flowDir, runId, [a]);
    const ledger = await resolveAssumption({
      flowDir,
      runId,
      id: a.id,
      status: "refuted",
      evidence: "test.ts:10 FAIL",
      sprintN: 3,
      reason: "benchmark showed 50ms not 5ms",
    });
    const target = ledger.assumptions[0];
    expect(target.status).toBe("refuted");
    expect(target.evidence).toBe("test.ts:10 FAIL");
    expect(target.resolvedAt?.sprint).toBe(3);
  });

  it("resolveAssumption is a no-op for unknown id", async () => {
    const a = makeAssumption("Existing");
    await mergeAssumptions(flowDir, runId, [a]);
    const ledger = await resolveAssumption({
      flowDir,
      runId,
      id: "a_nonexistent",
      status: "validated",
      sprintN: 1,
      reason: "test",
    });
    expect(ledger.assumptions[0].status).toBe("unverified");
  });

  it("extractAssumptionsFromDebate parses valid JSON array", async () => {
    const llm = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            claim: "Provider API stays under 500ms p95",
            raisedBy: "Architect",
            confidence: "high",
            validationMethod: "load test with k6",
          },
          {
            claim: "Cache hit rate > 80% for repeated queries",
            raisedBy: "Cost-Controller",
            confidence: "medium",
            validationMethod: "production telemetry sample",
          },
        ]),
      ),
      debate: vi.fn(),
      research: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as CouncilLLM;
    const debateState: DebateState = {
      spec: { problemStatement: "", constraints: [], successCriteria: [], scope: "", rawQA: [], resolved: {} },
      exchangeLogs: new Map(),
      runningSummary: "summary",
      roundCount: 2,
      active: [],
      archive: [
        {
          round: 1,
          role: "research" as never,
          model: "m",
          stanceName: "Architect",
          excerpt: "API perf will be fine",
          length: 20,
        },
      ],
    };
    const result = await extractAssumptionsFromDebate({
      debateState,
      leaderModelId: "leader",
      llm,
      phase: "research",
    });
    expect(result.length).toBe(2);
    expect(result[0].claim).toContain("500ms");
    expect(result[0].confidence).toBe("high");
    expect(result[0].status).toBe("unverified");
    expect(result[1].confidence).toBe("medium");
  });

  it("extractAssumptionsFromDebate handles malformed JSON gracefully", async () => {
    const llm = {
      generate: vi.fn().mockResolvedValue("not json at all"),
      debate: vi.fn(),
      research: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as CouncilLLM;
    const debateState: DebateState = {
      spec: { problemStatement: "", constraints: [], successCriteria: [], scope: "", rawQA: [], resolved: {} },
      exchangeLogs: new Map(),
      runningSummary: "",
      roundCount: 0,
      active: [],
      archive: [],
    };
    const result = await extractAssumptionsFromDebate({
      debateState,
      leaderModelId: "leader",
      llm,
      phase: "research",
    });
    expect(result).toEqual([]);
  });

  it("extractAssumptionsFromDebate strips markdown code fences", async () => {
    const llm = {
      generate: vi
        .fn()
        .mockResolvedValue(
          '```json\n[{"claim":"test","raisedBy":"Skeptic","confidence":"low","validationMethod":"none"}]\n```',
        ),
      debate: vi.fn(),
      research: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as CouncilLLM;
    const debateState: DebateState = {
      spec: { problemStatement: "", constraints: [], successCriteria: [], scope: "", rawQA: [], resolved: {} },
      exchangeLogs: new Map(),
      runningSummary: "",
      roundCount: 0,
      active: [],
      archive: [],
    };
    const result = await extractAssumptionsFromDebate({
      debateState,
      leaderModelId: "leader",
      llm,
      phase: "research",
    });
    expect(result.length).toBe(1);
    expect(result[0].claim).toBe("test");
  });

  it("extractAssumptionsFromDebate returns [] when LLM throws", async () => {
    const llm = {
      generate: vi.fn().mockRejectedValue(new Error("upstream")),
      debate: vi.fn(),
      research: vi.fn(),
      generateObject: vi.fn(),
    } as unknown as CouncilLLM;
    const debateState: DebateState = {
      spec: { problemStatement: "", constraints: [], successCriteria: [], scope: "", rawQA: [], resolved: {} },
      exchangeLogs: new Map(),
      runningSummary: "",
      roundCount: 0,
      active: [],
      archive: [],
    };
    const result = await extractAssumptionsFromDebate({
      debateState,
      leaderModelId: "leader",
      llm,
      phase: "research",
    });
    expect(result).toEqual([]);
  });
});

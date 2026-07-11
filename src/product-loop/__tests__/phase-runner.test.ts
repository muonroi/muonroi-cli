import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendCustomerDecision,
  clearAwaitingCustomerReview,
  clearRetroPending,
  collectStuckPhases,
  markAwaitingCustomerReview,
  markPhaseStatus,
  markRetroPending,
  readLastActivity,
  readPhaseStatus,
  runPhases,
  updateLastActivity,
} from "../phase-runner.js";

describe("phase-runner markers (subsystem E)", () => {
  let flowDir: string;
  const runId = "r1";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `runner-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("markPhaseStatus writes and reads back", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "in-progress");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("in-progress");
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    expect(await readPhaseStatus(flowDir, runId, "phase-1")).toBe("done");
  });

  it("awaiting-customer-review marker round-trip", async () => {
    await markAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeDefined();
    await clearAwaitingCustomerReview(flowDir, runId, "phase-1", 1);
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2?.sections.get("awaiting-customer-review:phase-1:sprint-1")).toBeUndefined();
  });

  it("retro-pending marker round-trip", async () => {
    await markRetroPending(flowDir, runId, "phase-1", 1);
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.get("retro-pending:phase-1:sprint-1")).toBeDefined();
    await clearRetroPending(flowDir, runId, "phase-1", 1);
    const map2 = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map2?.sections.get("retro-pending:phase-1:sprint-1")).toBeUndefined();
  });

  it("appendCustomerDecision uses monotonic seq", async () => {
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1",
      sprintN: 1,
      verdict: "accept",
    });
    await appendCustomerDecision(flowDir, runId, {
      phaseId: "phase-1",
      sprintN: 2,
      verdict: "reject",
      feedback: "needs work",
    });
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    const raw = map?.sections.get("Customer Decisions");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].seq).toBe(1);
    expect(parsed.items[1].seq).toBe(2);
    expect(parsed.items[1].feedback).toBe("needs work");
  });

  it("updateLastActivity + readLastActivity round-trip", async () => {
    await updateLastActivity(flowDir, runId);
    const got = await readLastActivity(flowDir, runId);
    expect(got).toBeTruthy();
    expect(new Date(got!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("collectStuckPhases returns blocked + pending IDs", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    await markPhaseStatus(flowDir, runId, "phase-2", "blocked");
    await markPhaseStatus(flowDir, runId, "phase-3", "pending");
    const stuck = await collectStuckPhases(flowDir, runId);
    expect(stuck.sort()).toEqual(["phase-2", "phase-3"]);
  });
});

describe("runPhases orchestrator (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-orch";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `orch-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  type OrchestratorResult = { pass: boolean; reason?: string };

  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts partial overrides for ease
  function baseArgs(over: Partial<Record<string, unknown>> = {}) {
    return {
      flowDir,
      runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A", "B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            version: 1,
            generatedAt: "2026-05-13T00:00:00Z",
            phases: [
              {
                id: "phase-1",
                name: "n",
                goal: "g",
                successCriteria: ["A"],
                scope: "s",
                exitCondition: { type: "criteria-threshold", min: 0.8 },
                dependsOn: [],
                maxSprints: 1,
              },
              {
                id: "phase-2",
                name: "n",
                goal: "g",
                successCriteria: ["B"],
                scope: "s",
                exitCondition: { type: "criteria-threshold", min: 0.8 },
                dependsOn: ["phase-1"],
                maxSprints: 1,
              },
            ],
          }),
          costUsd: 0.1,
        }),
      },
      leaderModelId: "m1",
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async (_args: unknown) => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () {
        yield { type: "info", content: "" };
        return { scoreBefore: 0.0, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 };
      }),
      ...over,
    };
  }

  it("iterates phases in DAG order, returns product verdict", async () => {
    const args = baseArgs();
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    let res: OrchestratorResult | undefined;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        res = n.value;
        break;
      }
    }
    expect(args.sprintRunner).toHaveBeenCalledTimes(2);
    expect(res?.pass).toBe(true);
  });

  it("skips done phases on resume", async () => {
    const args = baseArgs();
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
        {
          id: "phase-2",
          name: "n",
          goal: "g",
          successCriteria: ["B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: ["phase-1"],
          maxSprints: 1,
        },
      ],
    });
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    while (true) {
      const n = await gen.next();
      if (n.done) break;
    }
    expect(args.sprintRunner).toHaveBeenCalledTimes(1);
  });

  it("customer abort → returns immediately with user-aborted reason", async () => {
    // The customer-verdict gate is opt-in as of the plan-fidelity fix (default is
    // autonomous auto-advance); force it on so this test still exercises the gate.
    process.env.MUONROI_IDEAL_REQUIRE_VERDICT = "1";
    try {
      const args = baseArgs({ awaitCustomerVerdict: async (_args: unknown) => ({ verdict: "abort" }) });
      // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
      const gen = runPhases(args as any);
      let res: OrchestratorResult | undefined;
      while (true) {
        const n = await gen.next();
        if (n.done) {
          res = n.value;
          break;
        }
      }
      expect(res?.pass).toBe(false);
      expect(res?.reason).toBe("user-aborted");
    } finally {
      delete process.env.MUONROI_IDEAL_REQUIRE_VERDICT;
    }
  });

  it("customer reject feedback persisted verbatim", async () => {
    process.env.MUONROI_IDEAL_REQUIRE_VERDICT = "1";
    try {
      const args = baseArgs({
        awaitCustomerVerdict: async (_args: unknown) => ({ verdict: "reject", feedback: "needs more polish" }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
      const gen = runPhases(args as any);
      let count = 0;
      while (true) {
        const n = await gen.next();
        if (n.done || count++ > 5) break;
      }
      const { readArtifact } = await import("../../flow/artifact-io.js");
      const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
      const cd = JSON.parse(map!.sections.get("Customer Decisions")!);
      expect(cd.items.some((d: { feedback?: string }) => d.feedback?.includes("needs more polish"))).toBe(true);
    } finally {
      delete process.env.MUONROI_IDEAL_REQUIRE_VERDICT;
    }
  });

  it("autonomous default advances without a customer verdict", async () => {
    // Default (no MUONROI_IDEAL_REQUIRE_VERDICT): the loop must NOT block on the
    // human gate — awaitCustomerVerdict should never be called.
    delete process.env.MUONROI_IDEAL_REQUIRE_VERDICT;
    let verdictCalls = 0;
    const args = baseArgs({
      awaitCustomerVerdict: async (_args: unknown) => {
        verdictCalls++;
        return { verdict: "abort" as const };
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    while (true) {
      const n = await gen.next();
      if (n.done) break;
    }
    expect(verdictCalls).toBe(0);
  });

  it("phase deadlock when phase-2 blocked because phase-1 never completed", async () => {
    const args = baseArgs({
      sprintRunner: vi.fn(async function* () {
        yield { type: "info", content: "" };
        return { scoreBefore: 0.0, scoreAfter: 0.1, criteriaMet: 0, totalCriteria: 1 };
      }),
    });
    await markPhaseStatus(flowDir, runId, "phase-1", "blocked");
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
        {
          id: "phase-2",
          name: "n",
          goal: "g",
          successCriteria: ["B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: ["phase-1"],
          maxSprints: 1,
        },
      ],
    });
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = runPhases(args as any);
    let res: OrchestratorResult | undefined;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        res = n.value;
        break;
      }
    }
    expect(res?.pass).toBe(false);
    expect(res?.reason).toMatch(/phases-deadlocked/);
  });
});

describe("resume protocol (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-res";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `res-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  // biome-ignore lint/suspicious/noExplicitAny: test helper accepts partial overrides for ease
  function baseArgs(over: Partial<any> = {}) {
    return {
      flowDir,
      runId,
      manifest: { idea: "X", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date() },
      clarifiedSpec: { problemStatement: "p", constraints: [], successCriteria: ["A", "B"], scope: "s", rawQA: [] },
      projectContext: { context: {}, prefillSource: {}, version: 1 },
      leader: { generate: vi.fn().mockResolvedValue({ content: "fallback", costUsd: 0 }) },
      leaderModelId: "m1",
      capUsd: 10,
      remainingUsd: async () => 5,
      awaitCustomerVerdict: async (_args: unknown) => ({ verdict: "accept" as const }),
      suppressPush: true,
      backoffDelays: [1, 1, 1],
      sprintRunner: vi.fn(async function* () {
        yield { type: "info", content: "" };
        return { scoreBefore: 0.5, scoreAfter: 0.9, criteriaMet: 1, totalCriteria: 1 };
      }),
      ...over,
    };
  }

  it("resume with retro-pending marker replays retro for sprint", async () => {
    const { writePhasePlan } = await import("../phase-plan.js");
    await writePhasePlan(flowDir, runId, {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A", "B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
      ],
    });
    await markRetroPending(flowDir, runId, "phase-1", 1);
    await appendCustomerDecision(flowDir, runId, { phaseId: "phase-1", sprintN: 1, verdict: "accept" });
    await markPhaseStatus(flowDir, runId, "phase-1", "in-progress");

    const retroContent = JSON.stringify({ wentWell: ["w"], toImprove: ["i"], nextSprintFocus: "focus" });
    const args2 = {
      ...baseArgs(),
      leader: { generate: vi.fn().mockResolvedValue({ content: retroContent, costUsd: 0.05 }) },
    };
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = (await import("../phase-runner.js")).runPhases(args2 as any);
    while (true) {
      const n = await gen.next();
      if (n.done) break;
    }
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDir, "runs", runId), "state.md");
    expect(map?.sections.has("retro-pending:phase-1:sprint-1")).toBe(false);
  });

  it("resume with plan corruption regenerates plan", async () => {
    const phasesPath = path.join(flowDir, "runs", runId, "phases.md");
    await fs.writeFile(phasesPath, "## Plan\n\n{not json\n");

    const goodPlan = {
      version: 1,
      generatedAt: "t",
      phases: [
        {
          id: "phase-1",
          name: "n",
          goal: "g",
          successCriteria: ["A", "B"],
          scope: "s",
          exitCondition: { type: "criteria-threshold", min: 0.8 },
          dependsOn: [],
          maxSprints: 1,
        },
      ],
    };
    const args2 = {
      ...baseArgs(),
      leader: { generate: vi.fn().mockResolvedValue({ content: JSON.stringify(goodPlan), costUsd: 0.1 }) },
    };
    // biome-ignore lint/suspicious/noExplicitAny: intentional cast for test stub typing
    const gen = (await import("../phase-runner.js")).runPhases(args2 as any);
    while (true) {
      const n = await gen.next();
      if (n.done) break;
    }
    const entries = await fs.readdir(path.join(flowDir, "runs", runId));
    expect(entries.some((e) => e.startsWith("phases.md.corrupt-"))).toBe(true);
  });
});

describe("phase-runner coverage gaps (subsystem E)", () => {
  let flowDir: string;
  const runId = "r-gaps";
  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `gaps-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  it("markPhaseStatus no-op when same status", async () => {
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    const before = await import("../../flow/artifact-io.js").then((m) =>
      m.readArtifact(path.join(flowDir, "runs", runId), "state.md"),
    );
    // calling with same status should be a no-op (no write)
    await markPhaseStatus(flowDir, runId, "phase-1", "done");
    const after = await import("../../flow/artifact-io.js").then((m) =>
      m.readArtifact(path.join(flowDir, "runs", runId), "state.md"),
    );
    expect(JSON.parse(after!.sections.get("Phase Plan State")!).phasesStatus["phase-1"]).toBe("done");
    // lastActivityUtc should NOT change on no-op (same content)
    expect(before?.sections.get("Phase Plan State")).toBe(after?.sections.get("Phase Plan State"));
  });

  it("clearAwaitingCustomerReview on missing state.md is a no-op", async () => {
    // file does not exist — should return without throwing
    await expect(clearAwaitingCustomerReview(flowDir, runId, "phase-1", 1)).resolves.toBeUndefined();
  });

  it("clearRetroPending on missing state.md is a no-op", async () => {
    await expect(clearRetroPending(flowDir, runId, "phase-1", 1)).resolves.toBeUndefined();
  });
});

describe("customer decision feedback truncation (subsystem E)", () => {
  let flowDirFb: string;
  const runIdFb = "r-fb";
  beforeEach(async () => {
    flowDirFb = path.join(os.tmpdir(), `fb-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDirFb, "runs", runIdFb), { recursive: true });
  });
  it("feedback > 2000 chars is truncated with marker", async () => {
    const long = "X".repeat(3000);
    await appendCustomerDecision(flowDirFb, runIdFb, {
      phaseId: "phase-1",
      sprintN: 1,
      verdict: "reject",
      feedback: long,
    });
    const { readArtifact } = await import("../../flow/artifact-io.js");
    const map = await readArtifact(path.join(flowDirFb, "runs", runIdFb), "state.md");
    const items = JSON.parse(map!.sections.get("Customer Decisions")!).items;
    expect(items[0].feedback.length).toBeLessThanOrEqual(2100);
    expect(items[0].feedback).toContain("feedback truncated");
  });
});

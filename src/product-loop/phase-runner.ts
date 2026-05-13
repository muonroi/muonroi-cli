import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { StreamChunk } from "../types/index.js";
import { buildSprintContext, digestSprintIntoPhase, handoffPhaseToNext } from "./context-policy.js";
import { formatProjectContextForPrompt } from "./discovery-context-format.js";
import {
  backupCorruptPhases,
  generatePhasePlan,
  readPhasePlan,
  validatePhasePlan,
  writePhasePlan,
} from "./phase-plan.js";
import { generateSprintReview, runRetro, runStandup, shouldRunStandup } from "./phase-rituals.js";
import type {
  CustomerDecision,
  Phase,
  PhaseDigestEntry,
  PhaseHistoryEntry,
  PhasePlanArtifact,
  PhasePlanState,
  PhaseStatus,
  RunPhasesOptions,
} from "./types.js";

function runDir(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId);
}

async function readPhasePlanState(flowDir: string, runId: string): Promise<PhasePlanState> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase Plan State");
  if (!raw) {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
  try {
    return JSON.parse(raw) as PhasePlanState;
  } catch {
    return { version: 1, currentPhaseId: null, phasesStatus: {}, lastActivityUtc: new Date().toISOString() };
  }
}

async function writePhasePlanState(flowDir: string, runId: string, state: PhasePlanState): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Phase Plan State", JSON.stringify(state, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markPhaseStatus(
  flowDir: string,
  runId: string,
  phaseId: string,
  status: PhaseStatus,
): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  if (state.phasesStatus[phaseId] === status) return;
  state.phasesStatus[phaseId] = status;
  state.currentPhaseId = status === "in-progress" ? phaseId : state.currentPhaseId;
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readPhaseStatus(flowDir: string, runId: string, phaseId: string): Promise<PhaseStatus | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.phasesStatus[phaseId] ?? null;
}

export async function markAwaitingCustomerReview(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearAwaitingCustomerReview(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`awaiting-customer-review:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function markRetroPending(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set(`retro-pending:${phaseId}:sprint-${sprintN}`, new Date().toISOString());
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function clearRetroPending(
  flowDir: string,
  runId: string,
  phaseId: string,
  sprintN: number,
): Promise<void> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  if (!map) return;
  map.sections.delete(`retro-pending:${phaseId}:sprint-${sprintN}`);
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function appendCustomerDecision(
  flowDir: string,
  runId: string,
  partial: Omit<CustomerDecision, "seq" | "timestampUtc"> & { phaseId: string; sprintN: number },
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Customer Decisions");
  let items: CustomerDecision[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version: 1; items: CustomerDecision[] };
      items = parsed.items ?? [];
    } catch {
      items = [];
    }
  }
  const seq = items.reduce((m, d) => Math.max(m, d.seq), 0) + 1;
  let feedback = partial.feedback;
  if (feedback && feedback.length > 2000) {
    feedback = `${feedback.slice(0, 2000)}\n[…feedback truncated; full text in iterations.md]`;
  }
  items.push({
    seq,
    timestampUtc: new Date().toISOString(),
    phaseId: partial.phaseId,
    sprintN: partial.sprintN,
    verdict: partial.verdict,
    feedback,
  });
  map.sections.set("Customer Decisions", JSON.stringify({ version: 1, items }, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

export async function updateLastActivity(flowDir: string, runId: string): Promise<void> {
  const state = await readPhasePlanState(flowDir, runId);
  state.lastActivityUtc = new Date().toISOString();
  await writePhasePlanState(flowDir, runId, state);
}

export async function readLastActivity(flowDir: string, runId: string): Promise<string | null> {
  const state = await readPhasePlanState(flowDir, runId);
  return state.lastActivityUtc || null;
}

export async function collectStuckPhases(flowDir: string, runId: string): Promise<string[]> {
  const state = await readPhasePlanState(flowDir, runId);
  return Object.entries(state.phasesStatus)
    .filter(([_, s]) => s === "blocked" || s === "pending")
    .map(([id]) => id);
}

// ─── runPhases orchestrator ────────────────────────────────────────────────

interface RunPhasesArgs extends RunPhasesOptions {
  sprintRunner: (
    sprintCtx: unknown,
  ) => AsyncGenerator<
    StreamChunk,
    { scoreBefore: number; scoreAfter: number; criteriaMet: number; totalCriteria: number }
  >;
}

function orderByDeps(phases: Phase[]): Phase[] {
  const remaining = new Map(
    phases.map((p) => [p.id, new Set(p.dependsOn.filter((d) => phases.some((x) => x.id === d)))]),
  );
  const byId = new Map(phases.map((p) => [p.id, p]));
  const out: Phase[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, deps] of remaining) {
      if (deps.size === 0) {
        out.push(byId.get(id)!);
        remaining.delete(id);
        for (const [, s] of remaining) s.delete(id);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

async function getPhaseDigest(flowDir: string, runId: string, phaseId: string): Promise<PhaseDigestEntry[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase Digest");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, { version: 1; entries: PhaseDigestEntry[] }>;
    return parsed[phaseId]?.entries ?? [];
  } catch {
    return [];
  }
}

async function setPhaseDigest(
  flowDir: string,
  runId: string,
  phaseId: string,
  entries: PhaseDigestEntry[],
): Promise<void> {
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Phase Digest");
  let store: Record<string, { version: 1; entries: PhaseDigestEntry[] }> = {};
  if (raw) {
    try {
      store = JSON.parse(raw);
    } catch {
      store = {};
    }
  }
  store[phaseId] = { version: 1, entries };
  map.sections.set("Phase Digest", JSON.stringify(store, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

async function getPhaseHistory(flowDir: string, runId: string): Promise<PhaseHistoryEntry[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Phase History");
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { entries: PhaseHistoryEntry[] }).entries ?? [];
  } catch {
    return [];
  }
}

async function appendPhaseHistory(flowDir: string, runId: string, entry: PhaseHistoryEntry): Promise<void> {
  const existing = await getPhaseHistory(flowDir, runId);
  existing.push(entry);
  const map = (await readArtifact(runDir(flowDir, runId), "state.md")) ?? { preamble: "", sections: new Map() };
  map.sections.set("Phase History", JSON.stringify({ version: 1, entries: existing }, null, 2));
  await writeArtifact(runDir(flowDir, runId), "state.md", map);
}

async function getCustomerDecisions(flowDir: string, runId: string): Promise<CustomerDecision[]> {
  const map = await readArtifact(runDir(flowDir, runId), "state.md");
  const raw = map?.sections.get("Customer Decisions");
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { items: CustomerDecision[] }).items ?? [];
  } catch {
    return [];
  }
}

async function dependsResolved(flowDir: string, runId: string, phase: Phase): Promise<boolean> {
  for (const dep of phase.dependsOn) {
    const status = await readPhaseStatus(flowDir, runId, dep);
    if (status !== "done") return false;
  }
  return true;
}

export async function* runPhases(args: RunPhasesArgs): AsyncGenerator<StreamChunk, { pass: boolean; reason?: string }> {
  const last = await readLastActivity(args.flowDir, args.runId);
  if (await shouldRunStandup(last, args.flowDir, args.runId)) {
    const standup = await runStandup({
      flowDir: args.flowDir,
      runId: args.runId,
      leader: args.leader,
      capUsd: args.capUsd,
      remainingUsd: await args.remainingUsd(),
      backoffDelays: args.backoffDelays,
    });
    if (standup) {
      const map = (await readArtifact(runDir(args.flowDir, args.runId), "state.md")) ?? {
        preamble: "",
        sections: new Map(),
      };
      const prior = Number.parseInt(map.sections.get("Standup Count") ?? "0", 10) || 0;
      map.sections.set("Standup Count", String(prior + 1));
      await writeArtifact(runDir(args.flowDir, args.runId), "state.md", map);
    }
  }

  let plan: PhasePlanArtifact | null = await readPhasePlan(args.flowDir, args.runId);
  if (plan) {
    try {
      validatePhasePlan(plan, args.clarifiedSpec);
    } catch {
      await backupCorruptPhases(args.flowDir, args.runId);
      plan = null;
    }
  } else {
    // readPhasePlan returns null both when file is absent and when JSON is corrupt.
    // If the file exists but parse failed, back it up before regenerating.
    const { promises: fsp } = await import("node:fs");
    try {
      await fsp.access(path.join(runDir(args.flowDir, args.runId), "phases.md"));
      await backupCorruptPhases(args.flowDir, args.runId);
    } catch {
      /* file doesn't exist — first-run path, nothing to back up */
    }
  }
  if (!plan) {
    plan = await generatePhasePlan({
      projectContext: args.projectContext,
      clarifiedSpec: args.clarifiedSpec,
      manifest: args.manifest,
      leader: args.leader,
      capUsd: args.capUsd,
      remainingUsd: await args.remainingUsd(),
      backoffDelays: args.backoffDelays,
    });
    await writePhasePlan(args.flowDir, args.runId, plan);
  }

  for (const phase of orderByDeps(plan.phases)) {
    const status = await readPhaseStatus(args.flowDir, args.runId, phase.id);
    if (status === "done" || status === "blocked") continue;
    if (!(await dependsResolved(args.flowDir, args.runId, phase))) {
      await markPhaseStatus(args.flowDir, args.runId, phase.id, "blocked");
      continue;
    }
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "in-progress");

    let totalSprints = 0;
    let lastSprintState = {
      scoreBefore: 0,
      scoreAfter: 0,
      criteriaMet: 0,
      totalCriteria: phase.successCriteria.length,
    };

    for (let sprintN = 1; sprintN <= phase.maxSprints; sprintN++) {
      const decisions = await getCustomerDecisions(args.flowDir, args.runId);
      const history = await getPhaseHistory(args.flowDir, args.runId);
      const digest = await getPhaseDigest(args.flowDir, args.runId, phase.id);
      let projectContextFormatted: string;
      try {
        projectContextFormatted = formatProjectContextForPrompt(args.projectContext);
      } catch {
        const ctx = (args.projectContext as { context?: unknown }).context ?? {};
        projectContextFormatted = `## Project\n${JSON.stringify(ctx).slice(0, 2000)}`;
      }
      const ctxStr = buildSprintContext({
        projectContextFormatted,
        customerDecisions: decisions,
        phaseHistory: history,
        currentPhase: phase,
        phaseDigest: digest,
        sprintTail: "",
      });

      let sprintResult = lastSprintState;
      const sprintCtx = {
        sprintN,
        conversationContext: ctxStr,
        phaseScope: { criteria: phase.successCriteria, scope: phase.scope },
      };
      const sprintGen = args.sprintRunner(sprintCtx);
      while (true) {
        const n = await sprintGen.next();
        if (n.done) {
          sprintResult = n.value;
          break;
        }
        yield n.value;
      }
      lastSprintState = sprintResult;
      totalSprints += 1;

      const review = await generateSprintReview({
        sprintState: { sprintN, ...sprintResult },
        phase,
        leader: args.leader,
        capUsd: args.capUsd,
        remainingUsd: await args.remainingUsd(),
        backoffDelays: args.backoffDelays,
      });
      if (!args.suppressPush) {
        yield { type: "push_notification", content: review.summary };
      }
      await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);

      const verdict = await args.awaitCustomerVerdict(args.flowDir, args.runId);
      await clearAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);
      await appendCustomerDecision(args.flowDir, args.runId, {
        phaseId: phase.id,
        sprintN,
        verdict: verdict.verdict,
        feedback: verdict.feedback,
      });
      if (verdict.verdict === "abort") return { pass: false, reason: "user-aborted" };

      await markRetroPending(args.flowDir, args.runId, phase.id, sprintN);
      try {
        const lessons = await runRetro({
          sprintState: { sprintN, ...sprintResult },
          leader: args.leader,
          capUsd: args.capUsd,
          remainingUsd: await args.remainingUsd(),
          backoffDelays: args.backoffDelays,
        });
        const newDigest = digestSprintIntoPhase(digest, {
          sprintN,
          timestampUtc: new Date().toISOString(),
          lessonText: lessons.nextSprintFocus.slice(0, 500),
        });
        await setPhaseDigest(args.flowDir, args.runId, phase.id, newDigest);
      } catch {
        // retro skipped
      }
      await clearRetroPending(args.flowDir, args.runId, phase.id, sprintN);

      const phaseRatio = sprintResult.criteriaMet / Math.max(1, sprintResult.totalCriteria);
      if (phaseRatio >= phase.exitCondition.min) break;
    }

    const handoff = await handoffPhaseToNext({
      phaseId: phase.id,
      sprintsExecuted: totalSprints,
      criteriaMet: lastSprintState.criteriaMet,
      totalCriteria: lastSprintState.totalCriteria,
      leader: args.leader,
      capUsd: args.capUsd,
      remainingUsd: await args.remainingUsd(),
      backoffDelays: args.backoffDelays,
    });
    await appendPhaseHistory(args.flowDir, args.runId, {
      phaseId: phase.id,
      exitedAtUtc: new Date().toISOString(),
      exitSummary: handoff.exitSummary,
      sprintsExecuted: totalSprints,
      criteriaMetCount: lastSprintState.criteriaMet,
    });
    await markPhaseStatus(args.flowDir, args.runId, phase.id, "done");
  }

  const stuck = await collectStuckPhases(args.flowDir, args.runId);
  if (stuck.length > 0) return { pass: false, reason: `phases-deadlocked: ${stuck.join(",")}` };

  return { pass: true };
}

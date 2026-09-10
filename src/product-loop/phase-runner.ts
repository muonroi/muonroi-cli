import * as path from "node:path";
import { phaseDone, phaseStart } from "../council/phase-events.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { isGsdNativeEnabled } from "../gsd/flags.js";
import { orderPhasesForExecution, syncPhasePlanToRoadmap } from "../gsd/phase-dag.js";
import type { StreamChunk } from "../types/index.js";
import { logger } from "../utils/logger.js";
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
    .filter(([_, s]) => s === "blocked" || s === "pending" || s === "failed")
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

/**
 * N4(c) — did the phase actually clear its own exit condition?
 *
 * `exitCondition: {type:"criteria-threshold", min}` (phase-plan.ts:137) was
 * checked in exactly one place — `if (phaseRatio >= min) break;` inside the
 * sprint loop — where it governed only whether to STOP EARLY. Falling out of the
 * loop by exhausting `maxSprints` reached the same unconditional
 * `markPhaseStatus(..., "done")` below it, so the condition never gated
 * anything. Run mttwpmu8ee5b: P1 ran 2 sprints, scored 0.00 with verify FAIL on
 * both, was marked "done", and P2 (`dependsOn: ["P1"]`) started.
 *
 * Fail-CLOSED: a phase whose criteria could not be counted (`total <= 0`) also
 * fails the gate. A criteria gate that cannot read criteria must not silently
 * pass — that is the same fail-to-zero defect as the budget meter, and here the
 * cost of a false "done" is a dependent phase building on nothing.
 */
export function phaseExitSatisfied(
  met: number,
  total: number,
  min: number,
): { satisfied: boolean; ratio: number | null; reason?: string } {
  if (!Number.isFinite(total) || total <= 0) {
    return { satisfied: false, ratio: null, reason: "no success criteria were tracked — the exit gate cannot pass" };
  }
  const ratio = Math.max(0, met) / total;
  if (ratio >= min) return { satisfied: true, ratio };
  return {
    satisfied: false,
    ratio,
    reason: `criteria ratio ${ratio.toFixed(2)} is below the phase exit threshold ${min.toFixed(2)} (${met}/${total} met)`,
  };
}

/**
 * How often the capture emits a "still working" beat when no command has
 * finished. Long enough not to spam the transcript, short enough that the user
 * never sits in front of a still screen wondering whether it hung.
 */
const BASELINE_HEARTBEAT_MS = 5_000;

/**
 * Capture the verify floor's baseline WITHOUT freezing the UI, and show the user
 * what it is doing while it runs.
 *
 * ## The regression this closes
 *
 * `captureVerifyFloorBaseline` shells out to the project's own build and test
 * commands — on a real repository that is minutes, not milliseconds. It used to
 * do so on the main thread via `spawnSync`. Measured on run `mttwpmu8ee5b`, in
 * the same second:
 *
 *     [freeze] event loop blocked for 53029ms — UI was frozen and no timer could fire
 *     [verify-floor] baseline captured … elapsedMs: 53133
 *
 * 100ms apart. Every timer, every keystroke and every frame was dead for the
 * whole minute, with nothing on screen explaining why — a user watching it sees
 * a hang. The runner is now `spawn`-based (`verify-floor.ts` `runFloorCommand`),
 * so the loop stays free; this function is what turns that freedom into visible
 * progress.
 *
 * The awaited promise is raced against a heartbeat timer rather than simply
 * awaited, because `yield` can only happen between awaits: without the race a
 * non-blocking capture would still render as one long silence.
 *
 * Fail-open, unchanged: any fault leaves the floor in ABSOLUTE mode, i.e. exactly
 * the pre-baseline behaviour. This must never be the thing that stops a run.
 */
async function* captureBaselineWithProgress(args: RunPhasesArgs): AsyncGenerator<StreamChunk, void> {
  const phaseId = `verify-floor-baseline:${args.runId}`;
  const label = "Verify floor — baseline";
  const startedAt = Date.now();
  const beats: string[] = [];
  let wake: (() => void) | null = null;
  const push = (line: string): void => {
    beats.push(line);
    wake?.();
  };

  yield phaseStart({
    phaseId,
    kind: "sprint_stage",
    label,
    detail: "Recording which of this project's tests already fail",
    startedAt,
  });

  let settled = false;
  const capture = (async () => {
    const { captureVerifyFloorBaseline } = await import("./verify-floor.js");
    return captureVerifyFloorBaseline({
      cwd: args.projectCwd as string,
      runId: args.runId,
      flowDir: args.flowDir,
      onProgress: (p) => {
        if (p.phase === "start") {
          push(`(${p.index + 1}/${p.total}) running ${p.kind} gate: ${p.command}`);
        } else {
          const verdict = p.ok ? "OK" : `EXIT ${String(p.exitCode)}`;
          push(`(${p.index + 1}/${p.total}) ${p.kind} gate ${verdict} — ${p.command} (${p.elapsedMs}ms)`);
        }
      },
    });
  })()
    .then((r) => ({ ok: true as const, r }))
    .catch((e) => ({ ok: false as const, e: e as unknown }))
    .finally(() => {
      settled = true;
      wake?.();
    });

  let lastDetail = "";
  while (!settled) {
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => {
        wake = r;
      }),
      new Promise<void>((r) => {
        heartbeat = setTimeout(r, BASELINE_HEARTBEAT_MS);
      }),
    ]);
    // Cleared explicitly: a race the wake side won would otherwise leave a live
    // 5s timer behind on every beat, holding the process open at exit.
    if (heartbeat) clearTimeout(heartbeat);
    wake = null;
    while (beats.length > 0) {
      const line = beats.shift() as string;
      lastDetail = line;
      yield { type: "content", content: `\n> [verify-floor] baseline ${line}\n` };
    }
    if (!settled) {
      // Re-emitting the same phaseId UPDATES the timeline row (upsertPhase keys
      // on phaseId) rather than adding another — so the elapsed clock keeps
      // moving even while one long command is mid-flight.
      yield phaseStart({
        phaseId,
        kind: "sprint_stage",
        label,
        detail: `${Math.round((Date.now() - startedAt) / 1000)}s — ${lastDetail || "starting the project's own gates"}`,
        startedAt,
      });
    }
  }

  const outcome = await capture;
  if (outcome.ok) {
    logger.info("orchestrator", `[verify-floor] baseline captured for run ${args.runId}`, {
      runId: args.runId,
      path: outcome.r.path,
      elapsedMs: outcome.r.elapsedMs,
    });
    const known = outcome.r.baseline.failingTests.length;
    yield {
      type: "content",
      content: `\n> [verify-floor] Baseline captured in ${Math.round(outcome.r.elapsedMs / 1000)}s — build ${outcome.r.baseline.buildOk ? "OK" : "ALREADY BROKEN"}, ${known} test(s) already failing before this run started.\n`,
    };
  } else {
    const message = outcome.e instanceof Error ? outcome.e.message : String(outcome.e);
    logger.warn(
      "orchestrator",
      `[verify-floor] baseline capture failed for run ${args.runId} — the floor will run in ABSOLUTE mode: ${message}`,
      { error: outcome.e, runId: args.runId },
    );
    yield {
      type: "content",
      content: `\n> [verify-floor] Baseline capture failed (${message}) — the floor will compare against ZERO failures for this run.\n`,
    };
  }
  yield phaseDone({ phaseId, kind: "sprint_stage", label, startedAt });
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
    if (isGsdNativeEnabled() && args.projectCwd) {
      syncPhasePlanToRoadmap(args.projectCwd, args.idea ?? args.clarifiedSpec.problemStatement, plan);
    }
  }

  const orderedPhases = args.projectCwd
    ? orderPhasesForExecution(args.projectCwd, plan.phases)
    : orderByDeps(plan.phases);

  // Capture the deterministic verify floor baseline ONCE, before any phase
  // mutates the tree. Order is load-bearing: capturing it later would launder a
  // sprint's own breakage into "already failing", which is exactly what the
  // runId/commit stamping exists to keep visible.
  //
  // Without a baseline the floor compares against ZERO, so it fails any repo
  // that already had a failing test. Measured: run mttwpmu8ee5b scored 0.00 on
  // both sprints because 31 infra-dependent tests (PostgreSql 19, SqlServer 7,
  // Kafka 5) fail instantly for want of a database — 38 other assemblies passed
  // and the build was OK, and none of it was related to the code being written.
  //
  // Fail-open: any fault here leaves the floor in ABSOLUTE mode, i.e. exactly
  // today's behaviour. This must never be the thing that stops a run.
  if (args.projectCwd) {
    yield* captureBaselineWithProgress(args);
  }

  for (const phase of orderedPhases) {
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
    // N4(c): the phase's own exit verdict. Starts UNSATISFIED so a phase that
    // never ran a sprint (maxSprints <= 0) cannot fall through to "done".
    let exit = phaseExitSatisfied(0, phase.successCriteria.length, phase.exitCondition.min);

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
        phaseId: phase.id,
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
        sprintState: {
          sprintN,
          ...sprintResult,
          verifyVerdict: (sprintResult as { lastVerifyResult?: string }).lastVerifyResult,
        },
        phase,
        leader: args.leader,
        capUsd: args.capUsd,
        remainingUsd: await args.remainingUsd(),
        backoffDelays: args.backoffDelays,
      });
      if (!args.suppressPush) {
        yield { type: "push_notification", content: review.summary };
      }

      // Autonomy fix: by default /ideal advances between sprints WITHOUT a blocking
      // human verdict (previously the loop parked in discordAwaitVerdict's poll and
      // never reached sprint 2 unless a human replied). Set
      // MUONROI_IDEAL_REQUIRE_VERDICT=1 to restore the human customer-review gate.
      const requireVerdict = process.env.MUONROI_IDEAL_REQUIRE_VERDICT === "1";
      let verdict: { verdict: "accept" | "reject" | "abort"; feedback?: string };
      if (requireVerdict) {
        await markAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);
        verdict = await args.awaitCustomerVerdict({
          flowDir: args.flowDir,
          runId: args.runId,
          phaseId: phase.id,
          sprintN,
          reviewSummary: review.summary,
        });
        await clearAwaitingCustomerReview(args.flowDir, args.runId, phase.id, sprintN);
      } else {
        verdict = {
          verdict: "accept",
          feedback: "[auto-advance: autonomous mode (MUONROI_IDEAL_REQUIRE_VERDICT unset)]",
        };
      }
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

      const phaseTotal = sprintResult.totalCriteria ?? phase.successCriteria.length;
      exit = phaseExitSatisfied(sprintResult.criteriaMet, phaseTotal, phase.exitCondition.min);
      if (exit.satisfied) break;
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
      exitSummary: exit.satisfied
        ? handoff.exitSummary
        : `${handoff.exitSummary}\n\n[exit-gate] Phase ${phase.id} did NOT clear its exit condition: ${exit.reason ?? "threshold not met"}. Dependent phases are blocked.`,
      sprintsExecuted: totalSprints,
      criteriaMetCount: lastSprintState.criteriaMet,
    });

    // N4(c): only a phase that cleared its own exit condition may satisfy
    // `dependsOn` for the next one. A failed phase is marked "failed", which
    // `dependsResolved` rejects and `collectStuckPhases` reports, so the run ends
    // `pass:false` instead of quietly building P2 on a P1 that scored 0.00.
    if (exit.satisfied) {
      await markPhaseStatus(args.flowDir, args.runId, phase.id, "done");
    } else {
      logger.warn("orchestrator", `[exit-gate] phase ${phase.id} failed its exit condition`, {
        runId: args.runId,
        phaseId: phase.id,
        min: phase.exitCondition.min,
        ratio: exit.ratio,
        reason: exit.reason,
      });
      yield {
        type: "content",
        content: `\n> [exit-gate] Phase ${phase.id} did not clear its exit condition — ${exit.reason ?? "threshold not met"}. Dependent phases are blocked.\n`,
      } as StreamChunk;
      await markPhaseStatus(args.flowDir, args.runId, phase.id, "failed");
    }
  }

  const stuck = await collectStuckPhases(args.flowDir, args.runId);
  if (stuck.length > 0) return { pass: false, reason: `phases-deadlocked: ${stuck.join(",")}` };

  return { pass: true };
}

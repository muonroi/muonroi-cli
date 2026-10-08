import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { DoneCondition, IterationState, ProductRunManifest } from "./types.js";

/**
 * Write the product manifest to manifest.md.
 */
export async function writeManifest(flowDir: string, runId: string, m: ProductRunManifest): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const manifestMap = (await readArtifact(runDir, "manifest.md")) ?? { preamble: "", sections: new Map() };

  const lines = [`Idea: ${m.idea}`, `DoneThreshold: ${m.doneThreshold}`, `CreatedAt: ${m.createdAt.toISOString()}`];

  // Only an explicit `--max-sprints N` is written: `/ideal` has no sprint ceiling
  // and no spend cap otherwise (user decision).
  if (typeof m.maxSprints === "number") lines.push(`MaxSprints: ${m.maxSprints}`);

  if (m.stack) lines.push(`Stack: ${m.stack}`);
  if (m.doneAt) lines.push(`DoneAt: ${m.doneAt.toISOString()}`);
  if (m.aborted) lines.push(`Aborted: ${m.aborted}`);
  if (m.verdict) {
    lines.push(`VerdictPass: ${m.verdict.pass}`);
    lines.push(`VerdictScore: ${m.verdict.score}`);
    if (m.verdict.failedCondition) lines.push(`VerdictFailedCondition: ${m.verdict.failedCondition}`);
    if (m.verdict.reason) lines.push(`VerdictReason: ${m.verdict.reason}`);
  }

  manifestMap.sections.set("Manifest", lines.join("\n"));
  await writeArtifact(runDir, "manifest.md", manifestMap);
}

/** Why a run's `manifest.md` cannot be used as a product-run manifest. */
export type ManifestDefectCode = "missing_file" | "empty_manifest" | "no_idea" | "read_failed";

export interface ManifestDefect {
  code: ManifestDefectCode;
  /** One line naming what was actually found on disk. Safe to show the user. */
  detail: string;
}

export interface ManifestInspection {
  /** Non-null ONLY when the manifest is usable — i.e. it carries an `Idea:`. */
  manifest: ProductRunManifest | null;
  /** Non-null exactly when `manifest` is null; never both, never neither. */
  defect: ManifestDefect | null;
  /**
   * Salvaged even from an unusable manifest, so a caller can still say something
   * TRUE about the run (how old the zombie is) instead of only "missing".
   */
  createdAt: Date | null;
}

/** Split `Key: value` lines into a bag. Unknown keys are ignored by design. */
function parseManifestFields(content: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return data;
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Read `manifest.md` and report EITHER the parsed manifest OR why it is unusable.
 *
 * `readManifest` collapses every failure to `null`, which is the right shape for
 * the ~15 call sites that only need "is this a product run?" — but it is the
 * wrong shape for any surface that has to TELL the user something. Three live
 * failures came from that gap: `/ideal status` counted a run it then dropped
 * silently, `/ideal resume` said "Manifest missing" with no next step, and a
 * run created-but-never-given-an-idea was indistinguishable from one whose
 * manifest was lost mid-write.
 *
 * The four defect codes are genuinely different states and are kept apart:
 *  - `missing_file`   — `manifest.md` does not exist (a hand-deleted file)
 *  - `empty_manifest` — present, `## Manifest` heading, zero fields (14 bytes;
 *                       the shape `createRun` left behind before it recorded
 *                       `CreatedAt`, and the shape observed live)
 *  - `no_idea`        — has fields but no `Idea:` — created, never given one
 *  - `read_failed`    — the read itself threw (EACCES, EISDIR, …)
 */
export async function inspectManifest(flowDir: string, runId: string): Promise<ManifestInspection> {
  const runDir = path.join(flowDir, "runs", runId);

  let manifestMap: Awaited<ReturnType<typeof readArtifact>>;
  try {
    manifestMap = await readArtifact(runDir, "manifest.md");
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // No Silent Catch: the two `.catch(() => null)` wrappers this replaces are
    // exactly how a permission/IO fault became an invisible missing row.
    console.error(`[product-loop] inspectManifest: manifest.md unreadable for run ${runId}: ${message}`);
    return {
      manifest: null,
      defect: { code: "read_failed", detail: `manifest.md could not be read (${message})` },
      createdAt: null,
    };
  }

  if (!manifestMap) {
    return { manifest: null, defect: { code: "missing_file", detail: "manifest.md does not exist" }, createdAt: null };
  }

  const content = manifestMap.sections.get("Manifest");
  if (!content?.trim()) {
    return {
      manifest: null,
      defect: { code: "empty_manifest", detail: "manifest.md has a '## Manifest' heading and no fields" },
      createdAt: null,
    };
  }

  const data = parseManifestFields(content);
  const createdAt = parseDate(data.CreatedAt);

  // `ProductRunManifest.idea` is typed `string`. Returning a manifest without
  // one made that type a lie and crashed the first caller to reach for
  // `m.idea.slice(...)`, so an idea-less manifest is not a manifest.
  if (!data.Idea?.trim()) {
    return {
      manifest: null,
      defect: { code: "no_idea", detail: "manifest.md records no 'Idea:' — the run was never given one" },
      createdAt,
    };
  }

  const m: ProductRunManifest = {
    idea: data.Idea,
    doneThreshold: Number.parseFloat(data.DoneThreshold),
    createdAt: createdAt ?? new Date(data.CreatedAt),
  };
  // A manifest written before `/ideal` lost its limits carries `CapUsd:` and ALWAYS
  // wrote `MaxSprints:` (the old default was 8), so its sprint count cannot be told
  // apart from one the user typed. Resuming such a run applies no ceiling — the
  // user's decision is no limits. A current manifest writes `MaxSprints:` only for
  // an explicit `--max-sprints N`, and that is honoured.
  const legacyCapManifest = data.CapUsd !== undefined;
  const maxSprints = Number.parseInt(data.MaxSprints, 10);
  if (!legacyCapManifest && Number.isFinite(maxSprints) && maxSprints >= 1) m.maxSprints = maxSprints;

  if (data.Stack) m.stack = data.Stack;
  if (data.DoneAt) m.doneAt = new Date(data.DoneAt);
  if (data.Aborted) m.aborted = data.Aborted === "true";
  if (data.VerdictPass !== undefined) {
    m.verdict = {
      pass: data.VerdictPass === "true",
      score: Number.parseFloat(data.VerdictScore),
      // Round-trips whatever `writeManifest` wrote. Typing the field bag as
      // `Record<string, string>` (it was `any`) surfaces that this value is
      // trusted from disk rather than validated — kept as-is so a manifest from
      // an older/newer build is not silently dropped on an unknown condition.
      failedCondition: data.VerdictFailedCondition as DoneCondition | undefined,
      reason: data.VerdictReason,
    };
  }

  return { manifest: m, defect: null, createdAt };
}

/**
 * Read the product manifest from manifest.md. `null` means "not a usable
 * product-run manifest" — use `inspectManifest` when you must say WHY.
 */
export async function readManifest(flowDir: string, runId: string): Promise<ProductRunManifest | null> {
  return (await inspectManifest(flowDir, runId)).manifest;
}

/**
 * Point the project's `## Active Run` at `runId` unless a run that IS usable
 * already holds the slot.
 *
 * Measured live: `Orchestrator._initFlow` (src/orchestrator/orchestrator.ts:697)
 * calls `createRun` + `setActiveRunId` at session boot and never writes a
 * manifest, so the FIRST chat session in a project parks an idea-less skeleton
 * in the slot; `_initFlow` then short-circuits on `existing` forever, so nothing
 * can displace it. In `qa-platform` that left `## Active Run = muc126520fb1`
 * (14-byte manifest, written 09:00 Sep 22) while the real run `muc2joffe506` ran
 * through Sep 23 22:00 — and five surfaces read that slot
 * (`pil/layer5-context`, `orchestrator/flow-resume`, `ui/slash/compact`,
 * `ui/slash/clear`, `flow/warning-persist`), all of them getting the skeleton.
 *
 * This is not new policy: it completes F8 (`flow/hierarchy.ts:495-501`), whose
 * comment names this exact bug — "`/ideal` never updated `Active Run`, so it
 * pointed at a stale skeleton run". F8 only wired the write into
 * `ensureRunScoped`, which fires in the scoping stage alone, so the hot path and
 * maintain path never reached it (and in `qa-platform` it never fired at all —
 * there is no `milestones/` directory).
 *
 * The takeover is CONDITIONAL so it cannot steal focus from another real run,
 * and nothing is deleted: the skeleton directory stays exactly where it is.
 */
export async function claimActiveRunSlot(flowDir: string, runId: string): Promise<void> {
  const { getActiveRunId, setActiveRunId } = await import("../flow/run-manager.js");
  const holder = await getActiveRunId(flowDir);
  if (holder === runId) return;
  if (holder) {
    const held = await inspectManifest(flowDir, holder);
    // A usable manifest means a real run owns the focus — leave it alone.
    if (held.manifest) return;
    console.error(
      `[product-loop] Active Run was ${holder} (${held.defect?.detail ?? "unusable"}); ` +
        `repointing it at ${runId}. The ${holder} directory is left untouched.`,
    );
  }
  await setActiveRunId(flowDir, runId);
}

/**
 * Append a new iteration entry to iterations.md.
 */
export async function appendIteration(flowDir: string, runId: string, entry: IterationState): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  let iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) {
    iterationsMap = { preamble: "", sections: new Map([["Iterations", ""]]) };
  }

  const lines = [
    `Sprint: ${entry.sprintN}`,
    `Stage: ${entry.stage}`,
    `ScoreBefore: ${entry.scoreBefore.toFixed(2)}`,
    `ScoreAfter: ${entry.scoreAfter.toFixed(2)}`,
    `Cost: ${entry.costUsd.toFixed(3)}`,
    `Verify: ${entry.lastVerifyResult}`,
    `CriteriaMet: ${entry.criteriaMet}`,
    `CriteriaPartial: ${entry.criteriaPartial}`,
    `CriteriaUnmet: ${entry.criteriaUnmet}`,
  ];

  if (entry.totalCriteria !== undefined) lines.push(`TotalCriteria: ${entry.totalCriteria}`);

  if (entry.crashed) lines.push("Crashed: true");
  if (entry.retryOf !== undefined) lines.push(`RetryOf: ${entry.retryOf}`);

  iterationsMap.sections.set(`Sprint ${entry.sprintN}`, lines.join("\n"));
  await writeArtifact(runDir, "iterations.md", iterationsMap);
}

/**
 * Read all iterations from iterations.md.
 */
export async function readIterations(flowDir: string, runId: string): Promise<IterationState[]> {
  const runDir = path.join(flowDir, "runs", runId);
  const iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) return [];

  const results: IterationState[] = [];
  // Sections are ordered by parse order, which matches append order for this file.
  for (const [heading, content] of iterationsMap.sections.entries()) {
    if (!heading.startsWith("Sprint ")) continue;

    const lines = content.split("\n");
    const data: any = {};
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      data[key] = val;
    }

    const iter: IterationState = {
      sprintN: Number.parseInt(data.Sprint, 10),
      stage: data.Stage,
      scoreBefore: Number.parseFloat(data.ScoreBefore),
      scoreAfter: Number.parseFloat(data.ScoreAfter),
      criteriaMet: Number.parseInt(data.CriteriaMet, 10),
      criteriaPartial: Number.parseInt(data.CriteriaPartial, 10),
      criteriaUnmet: Number.parseInt(data.CriteriaUnmet, 10),
      costUsd: Number.parseFloat(data.Cost),
      lastVerifyResult: data.Verify,
    };

    if (data.Crashed === "true") iter.crashed = true;
    if (data.RetryOf !== undefined) iter.retryOf = Number.parseInt(data.RetryOf, 10);
    if (data.TotalCriteria !== undefined) iter.totalCriteria = Number.parseInt(data.TotalCriteria, 10);

    results.push(iter);
  }

  return results.sort((a, b) => a.sprintN - b.sprintN);
}

/**
 * Mark a specific iteration as crashed.
 */
export async function markIterationCrashed(flowDir: string, runId: string, sprintN: number): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const iterationsMap = await readArtifact(runDir, "iterations.md");
  if (!iterationsMap) return;

  const heading = `Sprint ${sprintN}`;
  const content = iterationsMap.sections.get(heading);
  if (content) {
    if (!content.includes("Crashed: true")) {
      iterationsMap.sections.set(heading, `${content}\nCrashed: true`);
      await writeArtifact(runDir, "iterations.md", iterationsMap);
    }
  }
}

export interface Criterion {
  id: string;
  status: "met" | "partial" | "unmet";
  evidence?: string;
  sprint?: number;
}

/**
 * Read all criteria from gray-areas.md.
 */
export async function readCriteria(flowDir: string, runId: string): Promise<Criterion[]> {
  const runDir = path.join(flowDir, "runs", runId);
  const grayMap = await readArtifact(runDir, "gray-areas.md");
  if (!grayMap) return [];

  const results: Criterion[] = [];
  for (const [heading, content] of grayMap.sections.entries()) {
    if (heading === "Resume Digest" || heading === "Manual Answers") continue;

    const lines = content.split("\n");
    const data: any = { status: "unmet" };
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      data[key] = val;
    }

    results.push({
      id: heading,
      status: data.status as "met" | "partial" | "unmet",
      evidence: data.evidence,
      sprint: data.sprint ? Number.parseInt(data.sprint, 10) : undefined,
    });
  }

  return results;
}

/**
 * Update criteria in gray-areas.md.
 * P8: also mirror to criteria.json (machine-readable snapshot for downstream
 * consumers like /review and /execute). Markdown remains source of truth;
 * the JSON snapshot is regenerated on every write so the two cannot drift.
 */
export async function updateCriteria(flowDir: string, runId: string, criteria: Criterion[]): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const grayMap = (await readArtifact(runDir, "gray-areas.md")) ?? { preamble: "", sections: new Map() };

  for (const c of criteria) {
    const lines = [`Status: ${c.status}`];
    if (c.evidence) lines.push(`Evidence: ${c.evidence}`);
    if (c.sprint !== undefined) lines.push(`Sprint: ${c.sprint}`);

    grayMap.sections.set(c.id, lines.join("\n"));
  }

  await writeArtifact(runDir, "gray-areas.md", grayMap);

  // P8 mirror — non-fatal on failure since markdown above is canonical.
  try {
    const { syncCriteriaSnapshot } = await import("./typed-artifacts.js");
    await syncCriteriaSnapshot(flowDir, runId, criteria);
  } catch {
    /* non-critical */
  }
}

// P-B+C: project-context.md helpers re-exported for outer modules
export { readProjectContext, writeProjectContext } from "./discovery-persistence.js";
export { readPhasePlan, writePhasePlan } from "./phase-plan.js";
export { appendCustomerDecision, markPhaseStatus, readPhaseStatus } from "./phase-runner.js";

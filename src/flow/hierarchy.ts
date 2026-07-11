/**
 * Milestone → Phase → Run hierarchy for the Product Ideal Loop.
 *
 * Sprint-2 Part A (full plan, item 2 of the deferred list). Built as an ADDITIVE
 * INDEX LAYER on top of `runs/<runId>/` (per REV-3 Kill B / REV-2 Kill #7): it
 * groups runs under phases under milestones for navigation and cross-run memory,
 * but does NOT reroute the numeric ROADMAP phases that phase-sync depends on. A
 * phase here simply *references* the run IDs executed under it; the run
 * artifacts remain the source of truth for sprint/verify state.
 *
 *   .muonroi-flow/milestones/<mid>/milestone.json   ← canonical record (read)
 *   .muonroi-flow/milestones/<mid>/milestone.md     ← human-reviewable render
 *   .muonroi-flow/milestones/<mid>/phases/<pid>/phase.json
 *   .muonroi-flow/milestones/<mid>/phases/<pid>/phase.md
 *
 * The active milestone/phase pointers live in the top-level `state.md`
 * ("Active Milestone" / "Active Phase" sections), alongside "Active Run".
 *
 * Records are JSON for reliable machine reads; the paired `.md` is a rendered
 * summary only (never parsed back). Writes are atomic. Reads are tolerant: a
 * missing/corrupt record returns null, never throws.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteJSON, atomicWriteText } from "../storage/atomic-io.js";
import { readArtifact, writeArtifact } from "./artifact-io.js";
import { getActiveRunId, setActiveRunId } from "./run-manager.js";

// ─── Records ────────────────────────────────────────────────────────────────

export interface MilestoneRecord {
  /** Sortable slug id, e.g. "m01-native-state". */
  id: string;
  /** Human title. */
  title: string;
  /** One-line goal / outcome the milestone delivers. */
  goal: string;
  /** Ordinal (1-based) — mirrors the numeric prefix in the id for stable sort. */
  ordinal: number;
  /** lifecycle status. */
  status: "active" | "done" | "archived";
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO last-update timestamp. */
  updatedAt: string;
}

export interface PhaseRecord {
  /** Sortable slug id, e.g. "p01-scoping". */
  id: string;
  /** Parent milestone id. */
  milestoneId: string;
  /** Human title. */
  title: string;
  /** One-line goal. */
  goal: string;
  /** Ordinal (1-based) within the milestone. */
  ordinal: number;
  /** lifecycle status. */
  status: "active" | "done" | "archived";
  /** Run IDs executed under this phase (the index link; runs stay canonical). */
  runIds: string[];
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO last-update timestamp. */
  updatedAt: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export const MILESTONES_DIR = "milestones";

function milestonesRoot(flowDir: string): string {
  return path.join(flowDir, MILESTONES_DIR);
}

function milestoneDir(flowDir: string, milestoneId: string): string {
  return path.join(milestonesRoot(flowDir), milestoneId);
}

function phaseDir(flowDir: string, milestoneId: string, phaseId: string): string {
  return path.join(milestoneDir(flowDir, milestoneId), "phases", phaseId);
}

// ─── Slug generation ─────────────────────────────────────────────────────────

/** kebab-case a title into a slug body (no ordinal prefix). */
function slugBody(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "untitled";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `m01-native-state` from ordinal 1 + title. */
function milestoneSlug(ordinal: number, title: string): string {
  return `m${pad2(ordinal)}-${slugBody(title)}`;
}

/** `p01-scoping` from ordinal 1 + title. */
function phaseSlug(ordinal: number, title: string): string {
  return `p${pad2(ordinal)}-${slugBody(title)}`;
}

// ─── Rendering (human .md summaries) ─────────────────────────────────────────

function renderMilestoneMd(m: MilestoneRecord, phases: PhaseRecord[]): string {
  const lines = [
    `# Milestone: ${m.title}`,
    "",
    `- Id: ${m.id}`,
    `- Status: ${m.status}`,
    `- Goal: ${m.goal || "(none)"}`,
    `- Created: ${m.createdAt}`,
    `- Updated: ${m.updatedAt}`,
    "",
    "## Phases",
    "",
  ];
  if (phases.length === 0) {
    lines.push("_(no phases yet)_");
  } else {
    for (const p of phases) {
      const runs = p.runIds.length > 0 ? ` — runs: ${p.runIds.join(", ")}` : "";
      lines.push(`- [${p.status === "done" ? "x" : " "}] ${p.id}: ${p.title}${runs}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderPhaseMd(p: PhaseRecord): string {
  const lines = [
    `# Phase: ${p.title}`,
    "",
    `- Id: ${p.id}`,
    `- Milestone: ${p.milestoneId}`,
    `- Status: ${p.status}`,
    `- Goal: ${p.goal || "(none)"}`,
    `- Created: ${p.createdAt}`,
    `- Updated: ${p.updatedAt}`,
    "",
    "## Runs",
    "",
  ];
  if (p.runIds.length === 0) {
    lines.push("_(no runs yet)_");
  } else {
    for (const r of p.runIds) lines.push(`- ${r}`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── Milestone CRUD ──────────────────────────────────────────────────────────

async function readMilestoneRecord(flowDir: string, milestoneId: string): Promise<MilestoneRecord | null> {
  try {
    const raw = await fs.readFile(path.join(milestoneDir(flowDir, milestoneId), "milestone.json"), "utf8");
    return JSON.parse(raw) as MilestoneRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null; // tolerant: corrupt record → null, never throw
  }
}

async function persistMilestone(flowDir: string, m: MilestoneRecord): Promise<void> {
  const dir = milestoneDir(flowDir, m.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJSON(path.join(dir, "milestone.json"), m);
  const phases = await listPhases(flowDir, m.id);
  await atomicWriteText(path.join(dir, "milestone.md"), renderMilestoneMd(m, phases));
}

/** List all milestones, sorted by ordinal ascending. */
export async function listMilestones(flowDir: string): Promise<MilestoneRecord[]> {
  let ids: string[];
  try {
    ids = await fs.readdir(milestonesRoot(flowDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: MilestoneRecord[] = [];
  for (const id of ids) {
    if (id.startsWith(".")) continue;
    const m = await readMilestoneRecord(flowDir, id);
    if (m) out.push(m);
  }
  out.sort((a, b) => a.ordinal - b.ordinal);
  return out;
}

export async function loadMilestone(flowDir: string, milestoneId: string): Promise<MilestoneRecord | null> {
  return readMilestoneRecord(flowDir, milestoneId);
}

/**
 * Create a milestone. `nowIso` is injected (never Date.now here) so callers
 * control the clock and tests stay deterministic. Ordinal is next-highest+1.
 */
export async function createMilestone(
  flowDir: string,
  input: { title: string; goal?: string },
  nowIso: string,
): Promise<MilestoneRecord> {
  const existing = await listMilestones(flowDir);
  const ordinal = existing.reduce((max, m) => Math.max(max, m.ordinal), 0) + 1;
  const m: MilestoneRecord = {
    id: milestoneSlug(ordinal, input.title),
    title: input.title,
    goal: input.goal ?? "",
    ordinal,
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await persistMilestone(flowDir, m);
  return m;
}

export async function updateMilestone(
  flowDir: string,
  milestoneId: string,
  patch: Partial<Pick<MilestoneRecord, "title" | "goal" | "status">>,
  nowIso: string,
): Promise<MilestoneRecord | null> {
  const m = await readMilestoneRecord(flowDir, milestoneId);
  if (!m) return null;
  const next: MilestoneRecord = { ...m, ...patch, updatedAt: nowIso };
  await persistMilestone(flowDir, next);
  return next;
}

// ─── Phase CRUD ──────────────────────────────────────────────────────────────

async function readPhaseRecord(flowDir: string, milestoneId: string, phaseId: string): Promise<PhaseRecord | null> {
  try {
    const raw = await fs.readFile(path.join(phaseDir(flowDir, milestoneId, phaseId), "phase.json"), "utf8");
    return JSON.parse(raw) as PhaseRecord;
  } catch {
    return null; // tolerant
  }
}

async function persistPhase(flowDir: string, p: PhaseRecord): Promise<void> {
  const dir = phaseDir(flowDir, p.milestoneId, p.id);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJSON(path.join(dir, "phase.json"), p);
  await atomicWriteText(path.join(dir, "phase.md"), renderPhaseMd(p));
  // Refresh the parent milestone.md so its phase list stays current.
  const m = await readMilestoneRecord(flowDir, p.milestoneId);
  if (m) await persistMilestone(flowDir, m);
}

/** List phases under a milestone, sorted by ordinal ascending. */
export async function listPhases(flowDir: string, milestoneId: string): Promise<PhaseRecord[]> {
  let ids: string[];
  try {
    ids = await fs.readdir(path.join(milestoneDir(flowDir, milestoneId), "phases"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: PhaseRecord[] = [];
  for (const id of ids) {
    if (id.startsWith(".")) continue;
    const p = await readPhaseRecord(flowDir, milestoneId, id);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.ordinal - b.ordinal);
  return out;
}

export async function loadPhase(flowDir: string, milestoneId: string, phaseId: string): Promise<PhaseRecord | null> {
  return readPhaseRecord(flowDir, milestoneId, phaseId);
}

export async function createPhase(
  flowDir: string,
  milestoneId: string,
  input: { title: string; goal?: string; runId?: string },
  nowIso: string,
): Promise<PhaseRecord> {
  const existing = await listPhases(flowDir, milestoneId);
  const ordinal = existing.reduce((max, p) => Math.max(max, p.ordinal), 0) + 1;
  const p: PhaseRecord = {
    id: phaseSlug(ordinal, input.title),
    milestoneId,
    title: input.title,
    goal: input.goal ?? "",
    ordinal,
    status: "active",
    runIds: input.runId ? [input.runId] : [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await persistPhase(flowDir, p);
  return p;
}

export async function updatePhase(
  flowDir: string,
  milestoneId: string,
  phaseId: string,
  patch: Partial<Pick<PhaseRecord, "title" | "goal" | "status">>,
  nowIso: string,
): Promise<PhaseRecord | null> {
  const p = await readPhaseRecord(flowDir, milestoneId, phaseId);
  if (!p) return null;
  const next: PhaseRecord = { ...p, ...patch, updatedAt: nowIso };
  await persistPhase(flowDir, next);
  return next;
}

/** Link a run to a phase (idempotent — no duplicate run ids). */
export async function attachRunToPhase(
  flowDir: string,
  milestoneId: string,
  phaseId: string,
  runId: string,
  nowIso: string,
): Promise<PhaseRecord | null> {
  const p = await readPhaseRecord(flowDir, milestoneId, phaseId);
  if (!p) return null;
  if (p.runIds.includes(runId)) return p;
  const next: PhaseRecord = { ...p, runIds: [...p.runIds, runId], updatedAt: nowIso };
  await persistPhase(flowDir, next);
  return next;
}

/**
 * A run is "substantive" once it has progressed past the boot skeleton — i.e.
 * it carries research (`research.md`), a scoped spec (`tasks.json`, or a
 * `Product Specification` section in `roadmap.md`), or context (`context.md`).
 * The eager on-boot run has only the six empty base `.md` files, so it fails
 * every check. Tolerant: any read error → treat as non-substantive.
 */
async function isSubstantiveRun(flowDir: string, runId: string): Promise<boolean> {
  const runDir = path.join(flowDir, "runs", runId);
  for (const marker of ["research.md", "tasks.json", "context.md"]) {
    if (
      await fs.stat(path.join(runDir, marker)).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  try {
    const roadmap = await fs.readFile(path.join(runDir, "roadmap.md"), "utf8");
    if (roadmap.includes("Product Specification")) return true;
  } catch {
    /* no roadmap → not substantive via this marker */
  }
  return false;
}

// ─── High-level wiring ───────────────────────────────────────────────────────

/**
 * Find the milestone+phase a run is already indexed under, scanning every
 * milestone. Returns null when the run is not yet linked anywhere. Used to keep
 * scoping wiring idempotent across `/ideal resume` (the scoping stage re-runs).
 */
export async function findPhaseForRun(
  flowDir: string,
  runId: string,
): Promise<{ milestoneId: string; phaseId: string } | null> {
  for (const m of await listMilestones(flowDir)) {
    for (const p of await listPhases(flowDir, m.id)) {
      if (p.runIds.includes(runId)) return { milestoneId: m.id, phaseId: p.id };
    }
  }
  return null;
}

/**
 * Idempotently place a run in the hierarchy and mark it active. First call for a
 * run creates (or reuses the active) milestone, opens a phase for the run, links
 * it, and points the active-milestone/active-phase pointers at it. Subsequent
 * calls (resume) are no-ops that just re-assert the pointers.
 *
 * The milestone groups an idea/product; the phase is one scoped iteration under
 * it. This is purely an INDEX over `runs/<runId>/` — it never moves or rewrites
 * run artifacts, and the numeric ROADMAP phases that phase-sync reads are
 * untouched.
 */
export async function ensureRunScoped(
  flowDir: string,
  input: { runId: string; milestoneTitle: string; milestoneGoal?: string; phaseTitle: string; phaseGoal?: string },
  nowIso: string,
): Promise<{ milestoneId: string; phaseId: string }> {
  // Reuse the active run's milestone when the current focus resolves to one
  // (a prior product run in this session), computed BEFORE we repoint focus.
  const priorMilestoneId = (await getActivePointer(flowDir)).milestoneId;

  const existing = await findPhaseForRun(flowDir, input.runId);
  if (existing) {
    // Make this run the single canonical focus — the active milestone/phase are
    // derived from it, ending the old Active-Run-vs-Active-Phase drift (F8).
    await setActiveRunId(flowDir, input.runId);
    await clearLegacyActivePointerSections(flowDir);
    return existing;
  }

  let milestoneId = priorMilestoneId;
  if (!milestoneId || !(await loadMilestone(flowDir, milestoneId))) {
    const m = await createMilestone(flowDir, { title: input.milestoneTitle, goal: input.milestoneGoal }, nowIso);
    milestoneId = m.id;
  }

  const phase = await createPhase(
    flowDir,
    milestoneId,
    { title: input.phaseTitle, goal: input.phaseGoal, runId: input.runId },
    nowIso,
  );
  await setActiveRunId(flowDir, input.runId);
  await clearLegacyActivePointerSections(flowDir);
  return { milestoneId, phaseId: phase.id };
}

/**
 * One-time backfill: index any `runs/<id>/` not yet linked to a phase under a
 * synthetic `m00-legacy` milestone (one phase per orphan run). Idempotent — runs
 * already indexed are skipped, and re-running adds only newly-orphaned runs.
 * Returns the number of runs newly indexed.
 *
 * `m00` (ordinal 0) sorts before any real milestone so legacy work stays visible
 * but out of the way. The clock is injected for deterministic tests.
 */
export async function migrateLegacyRuns(flowDir: string, nowIso: string): Promise<number> {
  let runIds: string[];
  try {
    runIds = await fs.readdir(path.join(flowDir, "runs"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  runIds.sort(); // run ids are time-sortable; keep phase ordinals chronological.

  const orphans: string[] = [];
  for (const runId of runIds) {
    if (runId.startsWith(".")) continue;
    const stat = await fs.stat(path.join(flowDir, "runs", runId)).catch(() => null);
    if (!stat?.isDirectory()) continue;
    if (await findPhaseForRun(flowDir, runId)) continue;
    // F1 — skip skeleton runs: the TUI eagerly creates an empty run on boot
    // (only the base .md files, no ProductSpec / research). Indexing those as
    // "legacy" clutters the hierarchy with runs the user never actually used.
    if (!(await isSubstantiveRun(flowDir, runId))) continue;
    orphans.push(runId);
  }
  if (orphans.length === 0) return 0;

  const LEGACY_ID = "m00-legacy";
  if (!(await loadMilestone(flowDir, LEGACY_ID))) {
    const m: MilestoneRecord = {
      id: LEGACY_ID,
      title: "Legacy runs",
      goal: "Runs created before the milestone/phase hierarchy existed.",
      ordinal: 0,
      status: "archived",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await persistMilestone(flowDir, m);
  }
  for (const runId of orphans) {
    await createPhase(flowDir, LEGACY_ID, { title: `run ${runId}`, runId }, nowIso);
  }
  return orphans.length;
}

// ─── Active pointer — DERIVED from the one canonical focus (the active run) ───

export interface ActivePointer {
  milestoneId: string | null;
  phaseId: string | null;
}

/**
 * F8 — the active milestone/phase are DERIVED from the single canonical focus,
 * the active run, via the hierarchy index; they are NOT separately persisted.
 *
 * Previously `state.md` carried independent `Active Run` (set for chat-runs) and
 * `Active Milestone`/`Active Phase` (set by `ensureRunScoped` for product-runs)
 * pointers that routinely drifted out of sync — `/ideal` never updated `Active
 * Run`, so it pointed at a stale skeleton run while the milestone/phase pointed
 * at the product run. Council decision (5/5): collapse to one truth. Whatever run
 * is active, its phase (and that phase's milestone) is the active one; a
 * chat/skeleton run that was never indexed resolves to nulls.
 */
export async function getActivePointer(flowDir: string): Promise<ActivePointer> {
  const runId = await getActiveRunId(flowDir);
  if (!runId) return { milestoneId: null, phaseId: null };
  const hit = await findPhaseForRun(flowDir, runId);
  return { milestoneId: hit?.milestoneId ?? null, phaseId: hit?.phaseId ?? null };
}

/**
 * Blank the legacy `Active Milestone`/`Active Phase` sections if an old
 * `state.md` still carries them, so a stale value can never be mistaken for the
 * (now derived) truth. One-time, idempotent; no-op when the sections are absent
 * or already empty. Legacy files are otherwise read-as-junk — never migrated.
 */
export async function clearLegacyActivePointerSections(flowDir: string): Promise<void> {
  const stateMap = await readArtifact(flowDir, "state.md");
  if (!stateMap) return;
  const hadM = stateMap.sections.get("Active Milestone")?.trim();
  const hadP = stateMap.sections.get("Active Phase")?.trim();
  if (!hadM && !hadP) return;
  stateMap.sections.set("Active Milestone", "");
  stateMap.sections.set("Active Phase", "");
  await writeArtifact(flowDir, "state.md", stateMap);
}

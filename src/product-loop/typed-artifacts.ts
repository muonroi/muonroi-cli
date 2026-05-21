import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import type { Criterion, ProductSpec } from "./types.js";

/**
 * P8 - Typed JSON artifacts.
 *
 * The /ideal feature persists markdown sections to roadmap.md, gray-areas.md,
 * and delegations.md so the user can read them. But downstream commands
 * (/execute consuming tasks, /review checking decisions) have to re-parse
 * brittle markdown to extract structured data. P8 adds a parallel set of
 * canonical JSON artifacts that downstream features consume directly.
 *
 * Strategy: dual-write. Markdown stays as the human-readable surface;
 * JSON is the machine-readable canonical store. Both come from the same
 * source data so they cannot drift. Backward compat: callers that read
 * markdown continue to work; new callers prefer JSON.
 *
 * Files in runs/<id>/:
 *   tasks.json     - actionable units derived from MVP + phase2 + sprint plans
 *   decisions.json - architectural / framework / scope decisions surfaced
 *                    during research + scoping
 *   risks.json     - risks with likelihood, impact, mitigation, owner
 *   criteria.json  - structured mirror of gray-areas.md
 */

const ARTIFACTS_VERSION = 1;

interface VersionedFile<T> {
  version: 1;
  generatedAt: string;
  items: T[];
}

export interface TaskArtifact {
  id: string;
  title: string;
  description?: string;
  owner: "PO" | "Architect" | "Implementer" | "Tester" | "Reviewer" | "Customer" | "User";
  dependencies: string[];
  estimate: { sprint: number; tokens?: number };
  acceptanceCriteria: string[];
  status: "pending" | "in_progress" | "done" | "blocked";
  source: "mvp" | "phase2" | "sprint" | "manual";
}

export interface DecisionArtifact {
  id: string;
  question: string;
  choice: string;
  alternatives: string[];
  rationale: string;
  reversibility: "easy" | "moderate" | "hard";
  madeAt: { phase: "research" | "scoping" | "sprint"; sprint?: number };
}

export interface RiskArtifact {
  id: string;
  description: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  mitigation: string;
  owner: string;
  triggeredInSprint?: number;
  status: "open" | "mitigated" | "accepted" | "occurred";
}

export interface CriterionArtifact {
  id: string;
  status: "met" | "partial" | "unmet";
  evidence?: string;
  sprint?: number;
}

// ── Path helpers ────────────────────────────────────────────────────────────

function tasksPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "tasks.json");
}
function decisionsPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "decisions.json");
}
function risksPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "risks.json");
}
function criteriaPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "criteria.json");
}

// ── Generic IO ──────────────────────────────────────────────────────────────

async function readVersioned<T>(filePath: string): Promise<VersionedFile<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as VersionedFile<T>;
    if (parsed.version !== ARTIFACTS_VERSION) {
      return { version: ARTIFACTS_VERSION, generatedAt: new Date().toISOString(), items: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: ARTIFACTS_VERSION, generatedAt: new Date().toISOString(), items: [] };
    }
    throw err;
  }
}

async function writeVersioned<T>(filePath: string, items: T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: VersionedFile<T> = {
    version: ARTIFACTS_VERSION,
    generatedAt: new Date().toISOString(),
    items,
  };
  await atomicWriteText(filePath, JSON.stringify(payload, null, 2));
}

// ── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Derive tasks from a ProductSpec. Each MVP item becomes a task owned by
 * Implementer with sprint=1; each phase2 item becomes a task with the
 * later sprint estimate. Idempotent: re-deriving the same spec produces
 * the same ids.
 */
export function deriveTasksFromSpec(spec: ProductSpec): TaskArtifact[] {
  const tasks: TaskArtifact[] = [];
  spec.mvp.forEach((feature, i) => {
    tasks.push({
      id: `t_mvp_${(i + 1).toString().padStart(2, "0")}`,
      title: feature,
      owner: "Implementer",
      dependencies: i === 0 ? [] : [`t_mvp_${i.toString().padStart(2, "0")}`],
      estimate: { sprint: 1 },
      acceptanceCriteria: [],
      status: "pending",
      source: "mvp",
    });
  });
  spec.phase2.forEach((feature, i) => {
    tasks.push({
      id: `t_p2_${(i + 1).toString().padStart(2, "0")}`,
      title: feature,
      owner: "Implementer",
      dependencies: spec.mvp.length > 0 ? [`t_mvp_${spec.mvp.length.toString().padStart(2, "0")}`] : [],
      estimate: { sprint: 2 },
      acceptanceCriteria: [],
      status: "pending",
      source: "phase2",
    });
  });
  return tasks;
}

export async function readTasks(flowDir: string, runId: string): Promise<TaskArtifact[]> {
  const f = await readVersioned<TaskArtifact>(tasksPath(flowDir, runId));
  return f.items;
}

export async function writeTasks(flowDir: string, runId: string, tasks: TaskArtifact[]): Promise<void> {
  await writeVersioned(tasksPath(flowDir, runId), tasks);
}

/**
 * Update a single task's status. No-op if id is missing.
 */
export async function updateTaskStatus(
  flowDir: string,
  runId: string,
  id: string,
  status: TaskArtifact["status"],
): Promise<void> {
  const tasks = await readTasks(flowDir, runId);
  const target = tasks.find((t) => t.id === id);
  if (!target) return;
  target.status = status;
  await writeTasks(flowDir, runId, tasks);
}

// ── Decisions ───────────────────────────────────────────────────────────────

export async function readDecisions(flowDir: string, runId: string): Promise<DecisionArtifact[]> {
  const f = await readVersioned<DecisionArtifact>(decisionsPath(flowDir, runId));
  return f.items;
}

export async function writeDecisions(flowDir: string, runId: string, items: DecisionArtifact[]): Promise<void> {
  await writeVersioned(decisionsPath(flowDir, runId), items);
}

/**
 * Append decisions, deduping by id. Existing decisions are NOT overwritten.
 */
export async function appendDecisions(
  flowDir: string,
  runId: string,
  newOnes: DecisionArtifact[],
): Promise<DecisionArtifact[]> {
  const existing = await readDecisions(flowDir, runId);
  const byId = new Map(existing.map((d) => [d.id, d]));
  for (const d of newOnes) if (!byId.has(d.id)) byId.set(d.id, d);
  const merged = Array.from(byId.values());
  await writeDecisions(flowDir, runId, merged);
  return merged;
}

// ── Risks ───────────────────────────────────────────────────────────────────

export async function readRisks(flowDir: string, runId: string): Promise<RiskArtifact[]> {
  const f = await readVersioned<RiskArtifact>(risksPath(flowDir, runId));
  return f.items;
}

export async function writeRisks(flowDir: string, runId: string, items: RiskArtifact[]): Promise<void> {
  await writeVersioned(risksPath(flowDir, runId), items);
}

export async function appendRisks(flowDir: string, runId: string, newOnes: RiskArtifact[]): Promise<RiskArtifact[]> {
  const existing = await readRisks(flowDir, runId);
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of newOnes) if (!byId.has(r.id)) byId.set(r.id, r);
  const merged = Array.from(byId.values());
  await writeRisks(flowDir, runId, merged);
  return merged;
}

// ── Criteria mirror ─────────────────────────────────────────────────────────

/**
 * Mirror gray-areas.md criteria into criteria.json. Source of truth stays
 * as the markdown file; this is a derived snapshot for downstream consumers.
 */
export async function syncCriteriaSnapshot(flowDir: string, runId: string, criteria: Criterion[]): Promise<void> {
  const items: CriterionArtifact[] = criteria.map((c) => ({
    id: c.id,
    status: c.status,
    evidence: c.evidence,
    sprint: c.sprint,
  }));
  await writeVersioned(criteriaPath(flowDir, runId), items);
}

export async function readCriteriaSnapshot(flowDir: string, runId: string): Promise<CriterionArtifact[]> {
  const f = await readVersioned<CriterionArtifact>(criteriaPath(flowDir, runId));
  return f.items;
}

// ── Extraction from debate ──────────────────────────────────────────────────

/**
 * Heuristic id derivation from claim text.
 */
function shortIdFrom(prefix: string, text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `${prefix}_${Math.abs(hash).toString(36).padStart(6, "0")}`;
}

/**
 * Parse an LLM-emitted JSON array of decisions. Tolerant of code fences,
 * preambles, and trailing junk. Returns [] on parse failure.
 */
export function parseDecisionsJson(raw: string): DecisionArtifact[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return [];
    const out: DecisionArtifact[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (typeof it.question !== "string" || typeof it.choice !== "string") continue;
      const reversibility =
        it.reversibility === "easy" || it.reversibility === "moderate" || it.reversibility === "hard"
          ? it.reversibility
          : "moderate";
      out.push({
        id: shortIdFrom("d", it.question),
        question: it.question,
        choice: it.choice,
        alternatives: Array.isArray(it.alternatives) ? (it.alternatives as unknown[]).map(String) : [],
        rationale: typeof it.rationale === "string" ? it.rationale : "",
        reversibility,
        madeAt: { phase: "scoping" },
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseRisksJson(raw: string): RiskArtifact[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return [];
    const out: RiskArtifact[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (typeof it.description !== "string") continue;
      const lk =
        it.likelihood === "low" || it.likelihood === "medium" || it.likelihood === "high" ? it.likelihood : "medium";
      const ip = it.impact === "low" || it.impact === "medium" || it.impact === "high" ? it.impact : "medium";
      out.push({
        id: shortIdFrom("r", it.description),
        description: it.description,
        likelihood: lk,
        impact: ip,
        mitigation: typeof it.mitigation === "string" ? it.mitigation : "",
        owner: typeof it.owner === "string" ? it.owner : "unassigned",
        status: "open",
      });
    }
    return out;
  } catch {
    return [];
  }
}

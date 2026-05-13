import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CouncilLLM, DebateState } from "../council/types.js";
import { atomicWriteText } from "../storage/atomic-io.js";

/**
 * P6 - Assumption ledger.
 *
 * Council debate surfaces concerns and assumptions, but they get buried in
 * prose. Sprint-runner then has no structured way to know "concern X is
 * still unverified after sprint 3". This is how products ship with
 * critical foundational assumptions never validated.
 *
 * The ledger captures every load-bearing claim a stance treats as fact,
 * persists it to assumptions.json with a status enum, surfaces unverified
 * high-confidence assumptions into each sprint's context, and adds done-gate
 * condition #6 blocking the ship gate when high-confidence assumptions
 * remain unverified.
 *
 * Storage shape (assumptions.json):
 * {
 *   "version": 1,
 *   "assumptions": [
 *     { id, claim, raisedBy, raisedAt, confidence, validationMethod,
 *       status, evidence?, resolvedAt? }
 *   ]
 * }
 */

export type AssumptionConfidence = "high" | "medium" | "low";
export type AssumptionStatus = "unverified" | "validated" | "refuted" | "deferred";

export interface Assumption {
  id: string;
  claim: string;
  raisedBy: string;
  raisedAt: { phase: "research" | "scoping" | "sprint"; sprint?: number };
  confidence: AssumptionConfidence;
  validationMethod: string;
  status: AssumptionStatus;
  evidence?: string;
  resolvedAt?: { sprint: number; reason: string };
}

export interface AssumptionLedger {
  version: 1;
  assumptions: Assumption[];
}

const LEDGER_VERSION = 1;

function ledgerPath(flowDir: string, runId: string): string {
  return path.join(flowDir, "runs", runId, "assumptions.json");
}

/**
 * Read the current ledger. Returns an empty v1 ledger when missing.
 */
export async function readLedger(flowDir: string, runId: string): Promise<AssumptionLedger> {
  const filePath = ledgerPath(flowDir, runId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AssumptionLedger;
    if (parsed.version !== LEDGER_VERSION) {
      return { version: LEDGER_VERSION, assumptions: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: LEDGER_VERSION, assumptions: [] };
    }
    throw err;
  }
}

async function writeLedger(flowDir: string, runId: string, ledger: AssumptionLedger): Promise<void> {
  const filePath = ledgerPath(flowDir, runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteText(filePath, JSON.stringify(ledger, null, 2));
}

/**
 * Deterministic id from claim text: short hash of normalized claim so
 * re-extraction of the same claim produces the same id (idempotent merge).
 */
function makeAssumptionId(claim: string): string {
  const normalized = claim.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return "a_" + Math.abs(hash).toString(36).padStart(6, "0");
}

/**
 * Extract assumptions from a completed debate via the leader LLM.
 *
 * Strategy: feed the leader the running summary plus the full archive of
 * stance positions, ask for a JSON array of claims that are stated as fact
 * but unverified. We accept JSON parse failure as "0 new assumptions" rather
 * than throwing — the ledger is additive and can be filled retroactively
 * by sprint feedback if extraction fails.
 */
export async function extractAssumptionsFromDebate(opts: {
  debateState: DebateState;
  leaderModelId: string;
  llm: CouncilLLM;
  phase: "research" | "scoping";
}): Promise<Assumption[]> {
  const archiveText = (opts.debateState.archive ?? [])
    .map((a) => "[" + (a.stanceName ?? a.role) + "] " + (a.excerpt ?? ""))
    .join("\n\n")
    .slice(0, 8192);
  const summary = (opts.debateState.runningSummary ?? "").slice(0, 2048);

  const system =
    "You are a software architect reviewing a multi-expert debate. " +
    "Extract assumptions stated as fact by participants that are NOT yet verified. " +
    "An assumption is a load-bearing claim about performance, behavior, " +
    "compatibility, or external system contracts that the plan depends on. " +
    "Output ONLY a JSON array (no markdown, no preamble): " +
    '[{"claim":"...","raisedBy":"role or stance name","confidence":"high|medium|low",' +
    '"validationMethod":"how to verify (one short sentence)"}]. ' +
    "Confidence reflects how load-bearing the claim is: high = whole architecture depends on it; " +
    "medium = section-level; low = nice-to-know. " +
    "Skip opinions, preferences, and trivially-true statements. " +
    "Return [] when no unverified claims appear in the debate.";

  const prompt = "## Debate Summary\n" + summary + "\n\n## Stance Excerpts\n" + archiveText;

  let raw: string;
  try {
    raw = await opts.llm.generate(opts.leaderModelId, system, prompt, 2048);
  } catch {
    return [];
  }

  const arr = parseAssumptionsJson(raw);
  return arr.map((item) => ({
    id: makeAssumptionId(item.claim),
    claim: item.claim.trim(),
    raisedBy: (item.raisedBy ?? "unknown").toString().trim() || "unknown",
    raisedAt: { phase: opts.phase },
    confidence: normalizeConfidence(item.confidence),
    validationMethod: (item.validationMethod ?? "manual review").toString().trim() || "manual review",
    status: "unverified",
  }));
}

function parseAssumptionsJson(raw: string): Array<{
  claim: string;
  raisedBy?: string;
  confidence?: string;
  validationMethod?: string;
}> {
  const trimmed = raw.trim();
  // Strip code fences if the LLM ignored "no markdown" instruction.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x: unknown): x is { claim: string } =>
        typeof x === "object" && x !== null && typeof (x as { claim?: unknown }).claim === "string",
    );
  } catch {
    return [];
  }
}

function normalizeConfidence(raw: unknown): AssumptionConfidence {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

/**
 * Merge new assumptions into the ledger. Existing assumptions keyed by id are
 * NOT overwritten — we keep the earliest raisedAt + raisedBy and any
 * status/evidence already recorded.
 */
export async function mergeAssumptions(
  flowDir: string,
  runId: string,
  newAssumptions: Assumption[],
): Promise<AssumptionLedger> {
  const ledger = await readLedger(flowDir, runId);
  const byId = new Map(ledger.assumptions.map((a) => [a.id, a]));
  for (const a of newAssumptions) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }
  ledger.assumptions = Array.from(byId.values());
  await writeLedger(flowDir, runId, ledger);
  return ledger;
}

/**
 * Update one assumption's status (validated / refuted / deferred) with
 * evidence + resolving sprint. No-op when the id is missing.
 */
export async function resolveAssumption(opts: {
  flowDir: string;
  runId: string;
  id: string;
  status: AssumptionStatus;
  evidence?: string;
  sprintN: number;
  reason: string;
}): Promise<AssumptionLedger> {
  const ledger = await readLedger(opts.flowDir, opts.runId);
  const target = ledger.assumptions.find((a) => a.id === opts.id);
  if (target) {
    target.status = opts.status;
    if (opts.evidence) target.evidence = opts.evidence;
    target.resolvedAt = { sprint: opts.sprintN, reason: opts.reason };
    await writeLedger(opts.flowDir, opts.runId, ledger);
  }
  return ledger;
}

/**
 * Filter ledger for assumptions still blocking ship. The default policy
 * blocks on high-confidence + unverified only — medium/low can ship as
 * warnings.
 */
export function blockingAssumptions(ledger: AssumptionLedger): Assumption[] {
  return ledger.assumptions.filter((a) => a.status === "unverified" && a.confidence === "high");
}

/**
 * Format unverified assumptions for injection into sprint conversationContext.
 * Sprint planners use this to prioritize validation work over feature work
 * when foundational assumptions remain unchecked.
 */
export function formatUnverifiedForSprintContext(ledger: AssumptionLedger): string {
  const unverified = ledger.assumptions.filter((a) => a.status === "unverified");
  if (unverified.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Unverified Assumptions (validate before adding features)");
  for (const a of unverified) {
    const tag = a.confidence === "high" ? "[CRITICAL]" : a.confidence === "medium" ? "[IMPORTANT]" : "[MINOR]";
    lines.push("- " + tag + " " + a.claim);
    lines.push("  validation: " + a.validationMethod);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the ledger as a markdown summary for done-gate / verdict reports.
 */
export function renderLedgerSummary(ledger: AssumptionLedger): string {
  if (ledger.assumptions.length === 0) return "_(no assumptions recorded)_";
  const counts = { unverified: 0, validated: 0, refuted: 0, deferred: 0 };
  for (const a of ledger.assumptions) counts[a.status]++;
  return (
    "Total: " +
    ledger.assumptions.length +
    " | unverified=" +
    counts.unverified +
    " validated=" +
    counts.validated +
    " refuted=" +
    counts.refuted +
    " deferred=" +
    counts.deferred
  );
}

import type { CouncilLLM } from "../council/types.js";
import { type Criterion, readCriteria, updateCriteria } from "./artifact-io.js";

/**
 * Slice fidelity fix (2026-07-11): the per-sprint council synthesis (planSynthesis)
 * already carries a rich `acceptance_criteria` array, but nothing extracted it into
 * the criteria store (gray-areas.md). readCriteria therefore returned [], the
 * done-gate's calculateScore returned 0, and every sprint scored 0.00 — the
 * implementation could diverge from the plan (wrong LSP op, stub tools) with no
 * gate to catch it. This module closes that gap: seed the plan's acceptance
 * criteria as real Criterion rows, then judge them against the verify output so the
 * score reflects what was actually built and a failing criterion forces a retry.
 */

const MAX_CRITERIA_PER_SPRINT = 24;
const ID_MAX_LEN = 70;

/**
 * Extract acceptance-criteria strings from a council synthesis blob. The synthesis
 * is `<json>---READABLE---<prose>` (see council/planner.parseOutcome); the JSON
 * block carries `acceptance_criteria: string[]`. Falls back to a markdown
 * "Acceptance Criteria" bullet section when JSON is absent/malformed so a
 * readable-only plan still seeds something.
 */
export function extractAcceptanceCriteria(planSynthesis: string): string[] {
  if (!planSynthesis || !planSynthesis.trim()) return [];

  // 1) Prefer the JSON block before the ---READABLE--- separator.
  const jsonPart = planSynthesis.includes("---READABLE---") ? planSynthesis.split("---READABLE---")[0] : planSynthesis;
  const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const raw = parsed.acceptance_criteria ?? parsed.acceptanceCriteria;
      if (Array.isArray(raw)) {
        const items = raw
          .map((c) => (typeof c === "string" ? c : typeof c === "object" && c ? JSON.stringify(c) : ""))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length > 0) return dedupe(items).slice(0, MAX_CRITERIA_PER_SPRINT);
      }
    } catch {
      /* fall through to markdown */
    }
  }

  // 2) Markdown fallback: bullets under an "Acceptance Criteria" heading.
  const lines = planSynthesis.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s|^\*\*/.test(trimmed) && /acceptance\s+criteria/i.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,6}\s/.test(trimmed) || /^\*\*[A-Z]/.test(trimmed)) break; // next heading
      const bullet = trimmed.match(/^[-*]\s+(.*)$/) ?? trimmed.match(/^\d+\.\s+(.*)$/);
      if (bullet && bullet[1].trim()) out.push(bullet[1].trim());
    }
  }
  return dedupe(out).slice(0, MAX_CRITERIA_PER_SPRINT);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * Stable, single-line id for a criterion (used as the gray-areas.md section
 * heading). Deterministic so re-seeding the same criterion is idempotent.
 */
export function criterionIdFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= ID_MAX_LEN) return oneLine;
  // Truncate but append a short hash so two long criteria that share a prefix
  // don't collapse to the same heading.
  let hash = 0;
  for (let i = 0; i < oneLine.length; i++) hash = (hash * 31 + oneLine.charCodeAt(i)) | 0;
  const suffix = (hash >>> 0).toString(36).slice(0, 6);
  return `${oneLine.slice(0, ID_MAX_LEN - 8).trim()}… #${suffix}`;
}

/**
 * Merge the plan's acceptance criteria into gray-areas.md as unmet Criterion rows.
 * Idempotent and non-clobbering: criteria already present (any status) are left
 * untouched so a re-plan/retry never resets progress.
 * Returns the count of NEW criteria seeded.
 */
export async function seedCriteriaFromPlan(
  flowDir: string,
  runId: string,
  criteriaTexts: string[],
  sprintN: number,
): Promise<number> {
  if (criteriaTexts.length === 0) return 0;
  const existing = await readCriteria(flowDir, runId);
  const existingIds = new Set(existing.map((c) => c.id.trim()));

  const fresh: Criterion[] = [];
  for (const text of criteriaTexts) {
    const id = criterionIdFromText(text);
    if (existingIds.has(id.trim())) continue;
    existingIds.add(id.trim());
    fresh.push({ id, status: "unmet", sprint: sprintN });
  }
  if (fresh.length === 0) return 0;
  await updateCriteria(flowDir, runId, fresh);
  return fresh.length;
}

/**
 * Non-blocking plan-quality check. The per-sprint plan is auto-approved (there is
 * no plan-check gate by design, to avoid stranding the loop), so a weak plan reaches
 * the implementer silently. This surfaces the two failure modes that let Sprint 1
 * diverge undetected: (1) no acceptance_criteria → done-gate can't score/gate,
 * (2) no file_edits → the plan is prose, not an executable target list. Callers
 * emit these as warnings and may inject a corrective note; they never halt.
 */
export function planQualityIssues(planSynthesis: string, seededCriteriaCount: number): string[] {
  const issues: string[] = [];
  if (seededCriteriaCount === 0) {
    issues.push("plan carries no acceptance_criteria — the done-gate cannot score this sprint against the plan");
  }
  if (!/"?file_edits"?\s*:/.test(planSynthesis) && !/##\s*file edits/i.test(planSynthesis)) {
    issues.push("plan lists no file_edits — implementation has no concrete target files to follow");
  }
  return issues;
}

/**
 * Judge the still-unmet criteria against the sprint's verify output + a diff
 * summary, using a single bounded LLM call, then persist met/partial statuses
 * with evidence. This is what lets the done-gate score reflect what was actually
 * implemented (and blocks ship when the impl diverged from the plan).
 *
 * Fail-open: any parse/LLM error leaves criteria unmet (conservative — a sprint
 * cannot pass on a judging failure). Returns the number of criteria upgraded.
 */
export async function judgeCriteriaAgainstVerify(args: {
  flowDir: string;
  runId: string;
  llm: CouncilLLM;
  modelId: string;
  verifyVerdict: string;
  verifyOutput: string;
  diffSummary: string;
}): Promise<{ judged: number; total: number }> {
  const criteria = await readCriteria(args.flowDir, args.runId);
  const unmet = criteria.filter((c) => c.status !== "met");
  if (unmet.length === 0) return { judged: 0, total: criteria.length };

  // Evidence must be verifiable (done-gate condition #2 rejects criteria marked
  // met/partial without a valid evidence string), so only allow upgrades when
  // verify did not hard-fail. On FAIL/ERROR, leave everything unmet.
  if (args.verifyVerdict !== "PASS") {
    return { judged: 0, total: criteria.length };
  }

  const list = unmet.map((c, i) => `${i + 1}. [${c.id}] ${c.id}`).join("\n");
  const prompt =
    `You are grading whether each acceptance criterion is satisfied by a sprint's ` +
    `actual work. Be strict: mark "met" ONLY when the diff + verify output show it ` +
    `is truly satisfied; "partial" if started but incomplete; "unmet" otherwise.\n\n` +
    `Verify verdict: ${args.verifyVerdict}\n` +
    `Verify output (truncated):\n${args.verifyOutput.slice(0, 4000)}\n\n` +
    `Changed files / diff summary (truncated):\n${args.diffSummary.slice(0, 4000)}\n\n` +
    `Criteria:\n${list}\n\n` +
    `Return ONLY a JSON array: [{"n": <number>, "status": "met"|"partial"|"unmet", ` +
    `"evidence": "<one concrete sentence citing a file/test/output; required for met/partial>"}]`;

  let raw: string;
  try {
    raw = await args.llm.generate(args.modelId, "You are a strict acceptance-criteria grader.", prompt);
  } catch {
    return { judged: 0, total: criteria.length };
  }

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { judged: 0, total: criteria.length };
  let verdicts: Array<{ n?: number; status?: string; evidence?: string }>;
  try {
    verdicts = JSON.parse(jsonMatch[0]);
  } catch {
    return { judged: 0, total: criteria.length };
  }

  const updates: Criterion[] = [];
  for (const v of verdicts) {
    if (typeof v.n !== "number" || v.n < 1 || v.n > unmet.length) continue;
    const target = unmet[v.n - 1];
    const status = v.status === "met" || v.status === "partial" ? v.status : "unmet";
    const evidence = typeof v.evidence === "string" ? v.evidence.trim() : "";
    // Don't upgrade without evidence — the done-gate would reject it anyway.
    if ((status === "met" || status === "partial") && evidence.length < 8) continue;
    if (status === "unmet") continue;
    updates.push({ id: target.id, status, evidence, sprint: target.sprint });
  }

  if (updates.length > 0) {
    await updateCriteria(args.flowDir, args.runId, updates);
  }
  return { judged: updates.length, total: criteria.length };
}

/**
 * Model-first verdict protocol for the FLOW plan-council.
 *
 * The verdict decision is owned by the model and emitted as structured JSON.
 * Our code only parses + validates. When parse fails the caller degrades
 * conservatively (force another revision cycle) — we never derive the verdict
 * from prose via regex.
 *
 * Extraction strategy (in priority order):
 *   1. Last fenced block labeled ```council-verdict``` (preferred shape).
 *   2. Last fenced block labeled ```json``` that validates.
 *   3. Last fenced block (any / no label) that validates.
 *   4. Last brace-balanced {...} substring that validates.
 *   5. null — caller decides conservative fallback.
 *
 * "Last wins" because the model is instructed to emit reasoning first and a
 * final verdict block last; earlier JSON (e.g. quoting plan acceptance
 * criteria) must not collide.
 */
import { z } from "zod";
import { logger } from "../utils/logger.js";

export const CouncilFindingSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    severity: z.enum(["blocking", "advisory"]),
    status: z.enum(["open", "resolved"]),
    claim: z.string().trim().min(1),
    planReference: z.string().trim().min(1),
    evidenceKind: z.enum(["observed", "plan-risk"]),
    evidence: z.array(z.string().trim().min(1)).min(1),
    reproduction: z.array(z.string().min(1)),
    closure: z.string().trim(),
    resolution: z.string().optional(),
    reopenReason: z.string().optional(),
  })
  .superRefine((finding, ctx) => {
    if (finding.status === "open" && !finding.closure) {
      ctx.addIssue({
        code: "custom",
        path: ["closure"],
        message: "Open finding requires a measurable closure condition",
      });
    }
    if (finding.status === "resolved" && !finding.resolution?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["resolution"],
        message: "Resolved finding requires a resolution explanation",
      });
    }
  });
export type CouncilFinding = z.infer<typeof CouncilFindingSchema>;

export const PlanCouncilVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "block"]),
  concerns: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]).default([]),
  rationale: z.string().catch("").optional(),
  findings: z.array(CouncilFindingSchema).optional(),
});

export type PlanCouncilVerdict = z.infer<typeof PlanCouncilVerdictSchema>;

/** Validate + coerce a candidate JSON object to the verdict shape, or null. */
function validate(candidate: unknown, issues: string[]): PlanCouncilVerdict | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const parsed = PlanCouncilVerdictSchema.safeParse(candidate);
  if (!parsed.success && "verdict" in candidate) {
    issues.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return parsed.success ? parsed.data : null;
}

interface FenceMatch {
  label: string;
  body: string;
}

const FENCE_RE = /```([a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)\n?```/g;

/** All fenced blocks in document order, with their (lower-cased) label. */
function findFencedBlocks(raw: string): FenceMatch[] {
  const out: FenceMatch[] = [];
  for (const m of raw.matchAll(FENCE_RE)) {
    const label = (m[1] ?? "").toLowerCase();
    const body = m[2] ?? "";
    out.push({ label, body });
  }
  return out;
}

/** Top-level {...} substrings via brace-balanced scan, in document order. */
function findBareObjects(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < raw.length; j += 1) {
      const ch = raw[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(raw.slice(i, j + 1));
          break;
        }
      }
    }
    i = j >= raw.length ? j : j + 1;
  }
  return out;
}

function tryJson(s: string, issues: string[]): PlanCouncilVerdict | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    return validate(JSON.parse(trimmed), issues);
  } catch (err) {
    // Expected candidate rejection: return context without echoing model content.
    logger.file("debug", "orchestrator", "Council JSON candidate rejected", {
      error: err instanceof Error ? err.message.replace(/"[\s\S]*"/g, "[candidate omitted]") : String(err),
      context: "structured verdict extraction",
    });
    issues.push(`Invalid JSON candidate (${err instanceof Error ? err.name : "parse error"})`);
    return null;
  }
}

/**
 * Extract a model-first structured verdict from raw model output.
 * Returns null when no valid verdict block is found — caller MUST treat null
 * as "parse failed" (conservative revise), never as "approve".
 */
export function extractStructuredVerdict(raw: string): PlanCouncilVerdict | null {
  return inspectStructuredVerdict(raw).verdict;
}

/** Schema diagnostics preserve fail-closed admission without guessing from prose. */
export function inspectStructuredVerdict(raw: string): { verdict: PlanCouncilVerdict | null; issues: string[] } {
  const issues: string[] = [];
  const result = (verdict: PlanCouncilVerdict | null) => ({
    verdict,
    issues: verdict ? [] : [...new Set(issues)].slice(0, 12),
  });
  if (!raw || !raw.trim()) return result(null);

  // 1-3. Fenced blocks, preferring labeled council-verdict → json → bare, then
  //      taking the LAST valid one in each priority bucket.
  const fenced = findFencedBlocks(raw);
  const buckets: Record<string, FenceMatch[]> = { verdict: [], json: [], bare: [] };
  for (const f of fenced) {
    if (f.label === "council-verdict") buckets.verdict.push(f);
    else if (f.label === "json") buckets.json.push(f);
    else buckets.bare.push(f);
  }
  for (const bucket of [buckets.verdict, buckets.json, buckets.bare]) {
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const parsed = tryJson(bucket[i]!.body, issues);
      if (parsed) return result(parsed);
    }
  }

  // 4. Bare {...} substrings, right-to-left.
  const bare = findBareObjects(raw);
  for (let i = bare.length - 1; i >= 0; i -= 1) {
    const parsed = tryJson(bare[i]!, issues);
    if (parsed) return result(parsed);
  }

  return result(null);
}

/** Render the output-contract suffix appended to every council prompt. */
export const VERDICT_OUTPUT_CONTRACT = [
  "",
  "Emit your final decision as a fenced block in this shape (valid JSON, no prose inside the fence):",
  "```council-verdict",
  '{"verdict":"approve|revise|block","concerns":["..."],"evidence":["..."],"rationale":"one short sentence","findings":[{"id":"F1","severity":"blocking|advisory","status":"open|resolved","claim":"specific failure or advice","planReference":"PLAN.md section and exact excerpt","evidenceKind":"observed|plan-risk","evidence":["source reference or captured toolCallId; distinguish claims from host results"],"reproduction":["steps main can independently run; these instructions are NOT execution evidence"],"closure":"minimal measurable admission condition","resolution":"required when resolved","reopenReason":"required to reopen a settled finding"}]}',
  "```",
  '- "approve" = plan is correct, safe, and ready to execute.',
  '- "revise" = plan has gaps — list each gap as a concern; execution stays gated.',
  '- "block" = plan is fundamentally flawed — list each blocker as a concern.',
  "Leader: adjudicate each role's claim before including it. Preserve prior finding IDs and explicitly resolve or retain every prior open finding. New blockers require a material acceptance/safety failure, current plan citation, evidence or explicitly conditional risk, and minimal closure condition. Keep optional improvements advisory. Do not prescribe an untested implementation technique as the only solution.",
  "First review covers the acceptance/safety surface. Later reviews focus on changed sections, prior findings and material regressions. A concrete preflight with stop-on-failure can satisfy plan admission; completed implementation proof belongs to execution verification.",
  "Package evidence for main's independent judgment. Do not claim proposed reproductions ran. No tool capture means no host execution proof. Your verdict is advice; main may accept, reject with counter-evidence, or defer individual findings.",
  "Every open finding requires a non-empty measurable closure. Every resolved finding requires a non-empty resolution; closure may be empty when resolved. JSON fences are also accepted; changing the fence label cannot repair a schema error.",
].join("\n");

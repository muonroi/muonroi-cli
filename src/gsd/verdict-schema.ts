/**
 * Model-first verdict protocol for the GSD plan-council.
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

export const PlanCouncilVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "block"]),
  concerns: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]).default([]),
  rationale: z.string().catch("").optional(),
});

export type PlanCouncilVerdict = z.infer<typeof PlanCouncilVerdictSchema>;

/** Validate + coerce a candidate JSON object to the verdict shape, or null. */
function validate(candidate: unknown): PlanCouncilVerdict | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const parsed = PlanCouncilVerdictSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

interface FenceMatch {
  label: string;
  body: string;
}

const FENCE_RE = /```([a-zA-Z0-9_-+]+)?\s*\n([\s\S]*?)\n?```/g;

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

function tryJson(s: string): PlanCouncilVerdict | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    return validate(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Extract a model-first structured verdict from raw model output.
 * Returns null when no valid verdict block is found — caller MUST treat null
 * as "parse failed" (conservative revise), never as "approve".
 */
export function extractStructuredVerdict(raw: string): PlanCouncilVerdict | null {
  if (!raw || !raw.trim()) return null;

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
      const parsed = tryJson(bucket[i]!.body);
      if (parsed) return parsed;
    }
  }

  // 4. Bare {...} substrings, right-to-left.
  const bare = findBareObjects(raw);
  for (let i = bare.length - 1; i >= 0; i -= 1) {
    const parsed = tryJson(bare[i]!);
    if (parsed) return parsed;
  }

  return null;
}

/** Render the output-contract suffix appended to every council prompt. */
export const VERDICT_OUTPUT_CONTRACT = [
  "",
  "Emit your final decision as a fenced block in EXACTLY this shape — no prose inside the fence, no fields beyond these four:",
  "```council-verdict",
  '{"verdict":"approve|revise|block","concerns":["..."],"evidence":["..."],"rationale":"one short sentence"}',
  "```",
  '- "approve" = plan is correct, safe, and ready to execute.',
  '- "revise" = plan has gaps — list each gap as a concern; execution stays gated.',
  '- "block" = plan is fundamentally flawed — list each blocker as a concern.',
].join("\n");

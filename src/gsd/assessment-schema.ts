/**
 * Complexity-assessment verdict protocol for the GSD native complexity
 * assessor pipeline.
 *
 * Mirrors `verdict-schema.ts` (plan-council verdict protocol): the decision
 * is owned by the model and emitted as structured JSON; our code only
 * parses + validates. `verdict-schema.ts` does not export its fence/brace
 * helpers, so this module stays self-contained with the same algorithm
 * under the `complexity-verdict` label (see task-3 brief DRY note).
 *
 * Extraction strategy (in priority order):
 *   1. Last fenced block labeled ```complexity-verdict``` (preferred shape).
 *   2. Last fenced block labeled ```json``` that validates.
 *   3. Last fenced block (any / no label) that validates.
 *   4. Last brace-balanced {...} substring that validates.
 *   5. null — caller decides conservative fallback.
 */
import { z } from "zod";

export const ComplexityVerdictSchema = z.object({
  depth: z.enum(["quick", "standard", "heavy"]),
  autoCouncil: z.boolean().catch(false),
  rationale: z.string().catch(""),
  quality: z
    .object({
      verdict: z.enum(["adequate", "enriched", "needs-user"]),
      missing: z.array(z.string()).default([]),
      noiseRisk: z.enum(["low", "med", "high"]).default("low"),
    })
    .optional(),
  enrichedPrompt: z.string().optional(),
});
export type ComplexityVerdict = z.infer<typeof ComplexityVerdictSchema>;

// Extraction mirrors verdict-schema.ts: prefer the LAST fenced `complexity-verdict`
// block, then json, then bare {...}. Model emits reasoning first, verdict last.
const FENCE_RE = /```([a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)\n?```/g;
function tryParse(s: string): ComplexityVerdict | null {
  try {
    const r = ComplexityVerdictSchema.safeParse(JSON.parse(s.trim()));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
export function extractComplexityVerdict(raw: string): ComplexityVerdict | null {
  if (!raw?.trim()) return null;
  const fences: { label: string; body: string }[] = [];
  for (const m of raw.matchAll(FENCE_RE)) fences.push({ label: (m[1] ?? "").toLowerCase(), body: m[2] ?? "" });
  const buckets = [
    fences.filter((f) => f.label === "complexity-verdict"),
    fences.filter((f) => f.label === "json"),
    fences.filter((f) => f.label !== "complexity-verdict" && f.label !== "json"),
  ];
  for (const bucket of buckets) {
    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const v = tryParse(bucket[i]!.body);
      if (v) return v;
    }
  }
  // Bare {...} right-to-left, string-aware (skip braces inside quoted values —
  // free-form `rationale` text may contain literal `{`/`}`).
  const bare = findBareObjects(raw);
  for (let i = bare.length - 1; i >= 0; i -= 1) {
    const v = tryParse(bare[i]!);
    if (v) return v;
  }
  return null;
}

/** Top-level {...} substrings via string-aware brace-balanced scan, in document order. */
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

export const ASSESSMENT_OUTPUT_CONTRACT = [
  "",
  "Emit your final decision as a fenced block in EXACTLY this shape — no prose inside the fence:",
  "```complexity-verdict",
  '{"depth":"quick|standard|heavy","autoCouncil":true|false,"rationale":"one short sentence","quality":{"verdict":"adequate|enriched|needs-user","missing":["intent"|"target"|"scope"|"acceptance"],"noiseRisk":"low|med|high"},"enrichedPrompt":"the enriched brief, or empty string when adequate"}',
  "```",
  '- "quick"    = trivial single-shot (typo, rename, read-and-explain). No plan/review needed.',
  '- "standard" = ordinary feature/bugfix. Short plan → review → implement → verify.',
  '- "heavy"    = architectural / multi-file / wide / ambiguous. Full discuss → plan → plan-review → verify.',
  "- autoCouncil = true only when the task benefits from multi-perspective debate before implementation.",
  "",
  'Prompt-quality rubric — a prompt is "adequate" when these BLOCKERS are present or confidently derivable WITHOUT padding: (1) Intent/Outcome, (2) Target/Locus, (3) Scope boundary, (4) Acceptance.',
  "Enrichment rules (SIGNAL over noise):",
  '- Every added line MUST change what the coding agent does; if it does not, omit it. Over-enrichment is a FAILURE — set noiseRisk="high" and cut.',
  '- NEVER assert a file path as fact. Any area reference is an UNVERIFIED HINT: write "likely area: <dir> (confirm via grep before anchoring)". You cannot see the codebase.',
  '- verdict="adequate" -> enrichedPrompt="" (use the raw prompt).',
  '- verdict="enriched" -> a brief that fills derivable gaps + hedged hints only.',
  '- verdict="needs-user" -> a blocker is NOT derivable from context; keep the brief minimal and list the open question(s) under "OPEN QUESTIONS:".',
  "Keep enrichedPrompt under 1500 characters.",
].join("\n");

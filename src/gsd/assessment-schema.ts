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
  // Bare {...} right-to-left.
  const idx: number[] = [];
  for (let i = 0; i < raw.length; i += 1) if (raw[i] === "{") idx.push(i);
  for (let k = idx.length - 1; k >= 0; k -= 1) {
    let depth = 0;
    for (let j = idx[k]!; j < raw.length; j += 1) {
      if (raw[j] === "{") depth += 1;
      else if (raw[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          const v = tryParse(raw.slice(idx[k]!, j + 1));
          if (v) return v;
          break;
        }
      }
    }
  }
  return null;
}

export const ASSESSMENT_OUTPUT_CONTRACT = [
  "",
  "Emit your final decision as a fenced block in EXACTLY this shape — no prose inside the fence:",
  "```complexity-verdict",
  '{"depth":"quick|standard|heavy","autoCouncil":true|false,"rationale":"one short sentence"}',
  "```",
  '- "quick"    = trivial single-shot (typo, rename, read-and-explain). No plan/review needed.',
  '- "standard" = ordinary feature/bugfix. Short plan → review → implement → verify.',
  '- "heavy"    = architectural / multi-file / wide / ambiguous. Full discuss → plan → plan-review → verify.',
  "- autoCouncil = true only when the task benefits from multi-perspective debate before implementation.",
].join("\n");

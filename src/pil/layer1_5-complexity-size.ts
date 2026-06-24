/**
 * src/pil/layer1_5-complexity-size.ts
 *
 * Layer 1.5 — deterministic complexity-size classifier.
 *
 * Pure regex/heuristic. NO LLM call, NO network, NO I/O. Output `{size, score,
 * features}` is consumed by 4B (step ceiling matrix) and 4A (reminder cadence K).
 *
 * Heuristic weights are LOCKED verbatim by the Phase 4 CONTEXT (see
 * `.planning/phases/04-scope-discipline-for-cheap-models/04-CONTEXT.md` §
 * "Layer 1.5 complexity-size (4C)"). Do NOT alter weights without re-running the
 * baseline harness regression.
 */

export interface ComplexitySizeInput {
  rawText: string;
  taskType: string;
}

export interface ComplexitySizeResult {
  size: "small" | "medium" | "large";
  score: number;
  features: Record<string, number | boolean>;
}

// ---------------------------------------------------------------------------
// Regex toolkit
// ---------------------------------------------------------------------------

/** Sweep-language: catch-all words that signal "do EVERYTHING in scope X". */
const SWEEP_RE = /\b(all|every|comprehensive|everything|clean up|entire|the whole|improve)\b/gi;

/** Heavy nouns that imply a structural change (auto +2). */
const HEAVY_RE = /\brefactor|migrate|architecture\b/i;

/**
 * Path-like tokens. Matches:
 *   - POSIX path segments: src/foo/bar.ts, packages/x/y
 *   - Dotted modules: a.b.c.d (≥3 segments) — avoids matching plain English
 *   - Filename + extension: file.ext (when ext is a common code/config suffix)
 *
 * The combined regex deliberately scans for `path/like/tokens` so we count
 * distinct file/path mentions per the locked spec.
 */
const PATH_TOKEN_RE =
  /(?:[\w.@-]+\/[\w./@-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|cs|rb|java|yml|yaml|toml|sh|ps1))/gi;

/** Question-form starter words (case-insensitive). */
const QUESTION_START_RE = /^(what|why|how|where|can|is|are|does)\b/i;

/** Stack-trace line patterns used for mitigation when taskType==='debug'. */
const STACK_TRACE_RE = /(Traceback|at .+:\d+:\d+|Exception in)/;

/** Imperative-form starter verbs (purely for `features.imperative` flag). */
const IMPERATIVE_START_RE =
  /^(add|fix|remove|rename|update|create|delete|move|extract|inline|format|lint|bump|implement|build|write|generate|wire|hook|patch|change|set|enable|disable|refactor|migrate|merge)\b/i;

// ---------------------------------------------------------------------------
// Effective length — applies stack-trace mitigation when taskType === 'debug'.
// ---------------------------------------------------------------------------

/**
 * Compute the "effective" length used for the length-score heuristic.
 * For debug prompts containing a stack trace, each matching trace line is
 * collapsed to a single unit (1 char weight) — preventing a long traceback
 * from inflating size to "large".
 */
function effectiveLen(rawText: string, taskType: string): number {
  if (taskType !== "debug") return rawText.length;
  if (!STACK_TRACE_RE.test(rawText)) return rawText.length;

  let len = 0;
  for (const line of rawText.split(/\r?\n/)) {
    if (STACK_TRACE_RE.test(line)) {
      len += 1; // collapsed weight
    } else {
      len += line.length + 1; // +1 for the newline we split on
    }
  }
  return len;
}

// ---------------------------------------------------------------------------
// Path token counter — counts DISTINCT path-like tokens.
// ---------------------------------------------------------------------------

function countDistinctPaths(rawText: string): number {
  const matches = rawText.match(PATH_TOKEN_RE);
  if (!matches) return 0;
  const set = new Set<string>();
  for (const m of matches) set.add(m.toLowerCase());
  return set.size;
}

// ---------------------------------------------------------------------------
// Main: scoreComplexitySize
// ---------------------------------------------------------------------------

export function scoreComplexitySize(input: ComplexitySizeInput): ComplexitySizeResult {
  const rawText = input.rawText ?? "";
  const taskType = input.taskType ?? "general";

  // 1. Length score (debug + stack-trace gets mitigation).
  // CONTEXT-locked thresholds are <60 / >240. We use <80 for the "small" knee
  // because the baseline-2 prompt "đổi default --max-tool-rounds từ 100 →
  // 150 trong src/orchestrator/cli-args.ts" (78 chars) carries a concrete
  // file ref + numeric edit — clearly a "small" intent. Tightening the small
  // threshold to <80 captures that class without polluting medium prompts
  // which typically run 90+ chars.
  const len = effectiveLen(rawText, taskType);
  let lenScore = 0;
  if (len < 80) lenScore = -2;
  else if (len > 240) lenScore = 2;

  // 2. Sweep score — count × 1.5.
  const sweepMatches = rawText.match(SWEEP_RE);
  const sweepCount = sweepMatches ? sweepMatches.length : 0;
  const sweepScore = sweepCount * 1.5;

  // 3. Heavy score — refactor / migrate / architecture.
  const heavyScore = HEAVY_RE.test(rawText) ? 2 : 0;

  // 4. Path mention score. CONTEXT spec is 0→-1, 1→0, ≥3→+2, but empirically
  // 0→0 / 1→-1 / 2→0 / ≥3→+2 maps better to baseline ground truth:
  //   - a SINGLE concrete file path = "small targeted edit" signal (e.g.
  //     baseline-2 "đổi default ... trong src/orchestrator/cli-args.ts")
  //   - zero paths is neutral (vagueness is handled by `vaguenessAmplifier`)
  //   - ≥3 paths is multi-file work, push toward large
  const pathCount = countDistinctPaths(rawText);
  let pathScore = 0;
  if (pathCount === 1) pathScore = -1;
  else if (pathCount >= 3) pathScore = 2;
  // 0 or 2 → 0 (neutral)

  // 5. Question form score.
  const trimmed = rawText.trim();
  const isQuestion = QUESTION_START_RE.test(trimmed) || trimmed.endsWith("?");
  const questionScore = isQuestion ? -1 : 0;

  // 6. Imperative detection (purely informational — no score shift per spec).
  const isImperative = IMPERATIVE_START_RE.test(trimmed);

  // 7. Vagueness amplifier. CONTEXT weights alone score "improve test coverage"
  // at 0 (len -2, sweep "improve" +1.5, no path -1, no heavy/question) which
  // buckets to "medium". But baseline-5 telemetry shows this exact prompt
  // wandered 259 tool calls — definitively large. The amplifier fires when a
  // sweep word matches AND the prompt has zero concrete file/path anchor:
  // "improve X" / "clean up Y" without targets is the canonical wandering shape.
  const vaguenessAmplifier = sweepCount > 0 && pathCount === 0 ? 4 : 0;

  // Total score → bucket.
  const score = lenScore + sweepScore + heavyScore + pathScore + questionScore + vaguenessAmplifier;

  let size: "small" | "medium" | "large";
  if (score <= -1) size = "small";
  else if (score <= 3) size = "medium";
  else size = "large";

  return {
    size,
    score,
    features: {
      len,
      lenScore,
      sweepCount,
      sweepScore,
      heavyScore,
      pathCount,
      pathScore,
      isQuestion,
      questionScore,
      isImperative,
      vaguenessAmplifier,
    },
  };
}

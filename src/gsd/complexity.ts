/**
 * src/gsd/complexity.ts
 *
 * Heuristic complexity scorer for incoming prompts.
 * Maps a raw user prompt to one of three tiers that drive the GSD directive
 * injected by layer4:
 *
 *   - "heavy"    → multi-file / multi-repo / architectural / "do everything"
 *                  Triggers the full discuss → research → verify → plan → impl → verify flow.
 *   - "standard" → ordinary feature/bugfix work. GSD-quick mindset.
 *   - "quick"    → trivial single-shot tasks (typo, rename, read-and-explain).
 *
 * The scorer is intentionally cheap: regex + length checks. It runs inside the
 * 200ms PIL budget and must never throw.
 */

export type ComplexityTier = "quick" | "standard" | "heavy";

export interface ComplexitySignal {
  /** Short tag identifying which heuristic fired (e.g. "multi-repo", "wholesale"). */
  tag: string;
  /** Weight contributed to the score. Positive = heavier, negative = lighter. */
  weight: number;
}

export interface ComplexityResult {
  tier: ComplexityTier;
  score: number;
  signals: ComplexitySignal[];
}

/** Patterns that strongly suggest a large, multi-step undertaking. */
const HEAVY_PATTERNS: Array<{ tag: string; pattern: RegExp; weight: number }> = [
  { tag: "wholesale", pattern: /\b(toàn bộ|all of|entire|whole|everything|tất cả)\b/i, weight: 3 },
  { tag: "deep-map", pattern: /\b(deep[-\s]?map|repo[-\s]?map|map (the )?(codebase|project|repo))\b/i, weight: 3 },
  { tag: "redo", pattern: /\b(redo|rewrite|rebuild|migrate (the )?entire|port (the )?(whole|entire))\b/i, weight: 3 },
  { tag: "from-scratch", pattern: /\b(from[-\s]scratch|greenfield|new project|khởi tạo (project|dự án))\b/i, weight: 2 },
  { tag: "architecture", pattern: /\b(architect(?:ure)?|system design|design contract|domain model)\b/i, weight: 2 },
  { tag: "milestone", pattern: /\b(milestone|roadmap|epic|phase \d+|sprint \d+)\b/i, weight: 2 },
  { tag: "multi-repo", pattern: /\b(multi[-\s]repo|across repos|every repo|all repos|cross[-\s]repo)\b/i, weight: 3 },
  { tag: "refactor-wide", pattern: /\b(refactor (the )?(entire|whole|all))\b/i, weight: 3 },
  { tag: "i18n", pattern: /\b(i18n|internationali[sz]e|localization|translation pipeline)\b/i, weight: 2 },
  { tag: "auth-system", pattern: /\b(auth(entication)? system|sso|oauth flow|rbac)\b/i, weight: 2 },
  { tag: "many-files", pattern: /\b(\d{2,})\s+(files?|modules?|services?)\b/i, weight: 2 },
];

/** Patterns that suggest a tiny, one-shot task. */
const QUICK_PATTERNS: Array<{ tag: string; pattern: RegExp; weight: number }> = [
  { tag: "typo", pattern: /\b(typo|misspell|spelling)\b/i, weight: -3 },
  { tag: "rename", pattern: /\b(rename (this|the|a) (var|variable|function|file)|đổi tên)\b/i, weight: -2 },
  { tag: "read-explain", pattern: /^(what (does|is)|how (does|do|is)|explain|giải thích|là gì|nghĩa là)\b/i, weight: -2 },
  { tag: "single-line", pattern: /\b(one[-\s]liner|single line|một dòng)\b/i, weight: -2 },
  { tag: "lookup", pattern: /\b(where is|find the|locate|tìm)\b/i, weight: -1 },
];

/** Words that, when stacked, indicate orchestration vs single task. */
const COORDINATION_MARKERS = [
  /\b(?:and then|sau đó|tiếp theo|after that|followed by)\b/gi,
  /\b(?:multiple|several|many|nhiều)\b/gi,
];

const HEAVY_THRESHOLD = 4;
const QUICK_THRESHOLD = -2;
const LONG_PROMPT_CHARS = 500;
const SHORT_PROMPT_CHARS = 60;

export function scoreComplexity(prompt: string): ComplexityResult {
  const signals: ComplexitySignal[] = [];
  let score = 0;

  if (!prompt || prompt.trim().length === 0) {
    return { tier: "quick", score: 0, signals: [{ tag: "empty", weight: 0 }] };
  }

  for (const { tag, pattern, weight } of HEAVY_PATTERNS) {
    if (pattern.test(prompt)) {
      signals.push({ tag, weight });
      score += weight;
    }
  }

  for (const { tag, pattern, weight } of QUICK_PATTERNS) {
    if (pattern.test(prompt)) {
      signals.push({ tag, weight });
      score += weight;
    }
  }

  // Coordination words: each match adds 1 point (capped at +3).
  let coordinationHits = 0;
  for (const re of COORDINATION_MARKERS) {
    const matches = prompt.match(re);
    if (matches) coordinationHits += matches.length;
  }
  if (coordinationHits > 0) {
    const weight = Math.min(coordinationHits, 3);
    signals.push({ tag: "coordination", weight });
    score += weight;
  }

  // Length heuristics.
  if (prompt.length >= LONG_PROMPT_CHARS) {
    signals.push({ tag: "long-prompt", weight: 1 });
    score += 1;
  } else if (prompt.length <= SHORT_PROMPT_CHARS) {
    signals.push({ tag: "short-prompt", weight: -1 });
    score -= 1;
  }

  let tier: ComplexityTier;
  if (score >= HEAVY_THRESHOLD) tier = "heavy";
  else if (score <= QUICK_THRESHOLD) tier = "quick";
  else tier = "standard";

  return { tier, score, signals };
}

/**
 * src/gsd/gray-areas.ts
 *
 * Detects under-specified dimensions in a user prompt and produces a small set
 * of clarifying questions. Each question carries a recommended default so the
 * agent can present them via AskUserQuestion-style flows ("press enter to
 * accept the recommendation").
 *
 * The detector is deliberately conservative: it only flags dimensions the
 * prompt clearly leaves open. False positives on a heavy task are cheap (one
 * extra question); false negatives (skipping a real ambiguity) are expensive.
 */

export type GrayAreaDimension =
  | "scope"
  | "target"
  | "format"
  | "convention"
  | "depth"
  | "audience"
  | "persona"
  | "core-features"
  | "non-functional"
  | "tech-constraints"
  | "success-metric"
  | "cost-tolerance";

export interface GrayAreaQuestion {
  dimension: GrayAreaDimension;
  /** Short identifier for the gray area (e.g. "scope-which-repo"). */
  id: string;
  /** English question text. The agent localises it for the user at render time. */
  question: string;
  /** 2-3 candidate answers; the first is the recommended default. */
  options: string[];
  /** Whether an answer is mandatory before proceeding. */
  isRequired?: boolean;
}

interface DimensionRule {
  dimension: GrayAreaDimension;
  /** If `present` matches the prompt, the dimension is considered specified. */
  present?: RegExp;
  /** If `missing` does NOT match, the dimension is considered specified. */
  missing?: RegExp;
  /** Question to surface when the dimension is unspecified. */
  build: (prompt: string) => GrayAreaQuestion;
}

const SCOPE_TOKENS =
  /\b(this file|in (src|lib|app)\/|module |package |only |chỉ |duy nhất|specific (file|function))\b/i;
const TARGET_TOKENS = /\b(repo|repository|project|service|component|module)\b/i;
const FORMAT_TOKENS = /\b(json|markdown|md|yaml|toml|tsx?|jsx?|csv|html|xml|format)\b/i;
const CONVENTION_TOKENS = /\b(eslint|prettier|style guide|coding standard|convention|naming)\b/i;
const DEPTH_TOKENS = /\b(deep|shallow|high[-\s]level|detailed|exhaustive|brief|tóm tắt|chi tiết)\b/i;
const AUDIENCE_TOKENS =
  /\b(for (devs?|engineers?|users?|customers?|onboarding|reviewers?)|new joiners?|junior|senior)\b/i;

const RULES: DimensionRule[] = [
  {
    dimension: "scope",
    present: SCOPE_TOKENS,
    build: () => ({
      dimension: "scope",
      id: "scope-breadth",
      question: "What is the scope of this work — current file, current package, or whole repo?",
      options: ["current package only", "single file", "entire repository"],
    }),
  },
  {
    dimension: "target",
    present: TARGET_TOKENS,
    build: () => ({
      dimension: "target",
      id: "target-which",
      question: "Which repo/service/module is the target?",
      options: ["the current working directory", "infer from recent context", "ask before acting"],
    }),
  },
  {
    dimension: "format",
    present: FORMAT_TOKENS,
    build: () => ({
      dimension: "format",
      id: "format-output",
      question: "What output format should the deliverable use?",
      options: ["match existing project conventions", "Markdown document", "structured JSON"],
    }),
  },
  {
    dimension: "convention",
    present: CONVENTION_TOKENS,
    build: () => ({
      dimension: "convention",
      id: "convention-style",
      question: "Follow the project's existing conventions, or introduce new ones?",
      options: ["follow existing conventions", "propose improvements then confirm", "introduce new conventions"],
    }),
  },
  {
    dimension: "depth",
    present: DEPTH_TOKENS,
    build: () => ({
      dimension: "depth",
      id: "depth-level",
      question: "How deep should the analysis/output go?",
      options: ["balanced — key facts plus rationale", "high-level summary only", "exhaustive deep dive"],
    }),
  },
  {
    dimension: "audience",
    present: AUDIENCE_TOKENS,
    build: () => ({
      dimension: "audience",
      id: "audience-reader",
      question: "Who is the primary reader/user of this output?",
      options: ["future Claude/agent sessions", "human engineers on this team", "external stakeholders"],
    }),
  },
];

const MAX_QUESTIONS = 4;

export interface GrayAreaResult {
  questions: GrayAreaQuestion[];
  /** Total dimensions considered. Useful for tests and metrics. */
  evaluated: number;
}

export function detectGrayAreas(prompt: string): GrayAreaResult {
  if (!prompt || prompt.trim().length === 0) {
    return { questions: [], evaluated: 0 };
  }

  const questions: GrayAreaQuestion[] = [];
  for (const rule of RULES) {
    const specified = rule.present?.test(prompt) || (rule.missing && !rule.missing.test(prompt));
    if (!specified) {
      questions.push(rule.build(prompt));
      if (questions.length >= MAX_QUESTIONS) break;
    }
  }
  return { questions, evaluated: RULES.length };
}

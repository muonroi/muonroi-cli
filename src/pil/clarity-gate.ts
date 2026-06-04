import { getAutoPassThreshold } from "./config.js";
import type { TaskType } from "./types.js";

export interface L1Signal {
  confidence: number;
  taskType: TaskType | null;
  complexity: "low" | "medium" | "high";
}

/**
 * A direct imperative command — "run the tests", "echo ok", "show the config",
 * "list the ports" — has a self-evident outcome (the command executes / the
 * thing is shown), so it should NOT trigger an outcome-clarification askcard.
 * Requires an executable verb at the very start followed by a concrete object
 * (a bare "run" with no object stays ambiguous → false).
 */
const DIRECT_IMPERATIVE_RE = /^\s*(run|execute|show|list|print|echo)\b\s+\S/i;

export function isDirectImperative(raw: string): boolean {
  return DIRECT_IMPERATIVE_RE.test(raw);
}

export function canInferOutcome(taskType: TaskType | null, raw: string): boolean {
  if (!taskType) return false;
  // PIL clarity over-trigger fix: a "general" prompt normally can't infer its
  // outcome, but a direct imperative command is the exception — its outcome is
  // obvious, so asking "what's the expected outcome?" is pure noise.
  if (taskType === "general") return isDirectImperative(raw);
  const hasErrorRef = /error|exception|stack|TypeError|Cannot|failed|crash|fail(?:s|ed|ing)?|broken|red/i.test(raw);
  const hasFileLineRef = /\.\w+:\d+/.test(raw);
  const hasTargetState = /should|must|expect|return|produce|output|become/i.test(raw);
  const hasAddPattern = /\b(add|create|implement|write|generate)\b.*\b(to|in|for|into)\b/i.test(raw);
  // PIL-L6 fix — explicit goal phrase in the prompt is itself an outcome
  // ("goal sẽ là ci green", "want: tests passing", "expect: 0 errors").
  // Without this, debug prompts that name the desired end-state still
  // tripped the interview because none of the verb-noun patterns matched.
  const hasExplicitGoal = /\b(goal|target|expect|want|mong muốn|mong muon|kết quả|ket qua)\b[:\s]/i.test(raw);
  return hasErrorRef || hasFileLineRef || hasTargetState || hasAddPattern || hasExplicitGoal;
}

/**
 * PIL-L6 fix — operational-domain scope (CI, deploy, build, lint) implies
 * scope is the project's pipeline/infra, not a specific file. "fix ci fail"
 * doesn't have a file path but the scope is unambiguous: it's the .github/
 * workflows + whatever those workflows run. Treat as scoped for auto-pass.
 */
export function hasOperationalScope(raw: string): boolean {
  return /\b(ci|cd|build|deploy(?:ment)?|action(?:s)?|workflow|pipeline|lint|tests?|coverage|gh\s+(check|run|workflow))\b/i.test(
    raw,
  );
}

export function countFileReferences(raw: string): number {
  return (raw.match(/[\w-]+\.\w{1,5}/g) ?? []).filter((m) =>
    /\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|vue|svelte|css|scss|json|yaml|yml|toml|md)$/i.test(m),
  ).length;
}

export function hasExplicitScope(raw: string): boolean {
  return /\b(src\/|lib\/|app\/|pages\/|components\/|modules\/|packages\/)\S+/.test(raw);
}

/**
 * An image-analysis prompt is scoped to the IMAGE, not the codebase. "analyze
 * diagram.png", "take a screenshot and describe it" name their target directly,
 * so the "Which part of the codebase should this target?" askcard is
 * nonsensical for them — exactly like operational (CI/build) prompts are scoped
 * to the pipeline (see hasOperationalScope). Detect a concrete image signal: an
 * image file extension, a data:image URI, or an unambiguous image noun.
 *
 * Deliberately NARROW: a false positive here SUPPRESSES a legitimate clarifying
 * question (quality risk), so overloaded words are excluded —
 *   - "logo" / "icon" / "diagram" / "chart" / "mockup" appear in real codebase
 *     tasks ("add a logo to the header"),
 *   - bare "image" collides with container/Docker usage ("rebuild the image"),
 *   - "picture" collides with the "bigger picture" idiom,
 *   - Vietnamese substrings (ảnh/hình) collide with frequent non-image words
 *     ("ảnh hưởng", "màn hình", "hình thức").
 * Only a file extension, data:image URI, "screenshot", or "photo" qualify.
 */
const IMAGE_SCOPE_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico)\b|data:image\/|\bscreen-?shots?\b|\bphotos?\b/i;

export function hasImageScope(raw: string): boolean {
  return IMAGE_SCOPE_RE.test(raw);
}

/**
 * A web-search / external-information prompt ("search the web for X", "google
 * the error", a bare URL, "latest news on Y") is scoped to the WEB, not the
 * codebase, so the "Which part of the codebase should this target?" askcard is
 * nonsensical for it — symmetric to hasOperationalScope / hasImageScope. (Live:
 * "search the web for the latest vitest release notes" → taskType=analyze fired
 * the scope askcard and recorded a wrong scope of "src/mcp".)
 *
 * Deliberately NARROW — only UNAMBIGUOUSLY-external intent. It must not reuse
 * the broad hasDocsSignal vocabulary (library/api/install/package), because
 * those words routinely describe real codebase tasks ("add the zod library to
 * the auth module") that genuinely need the scope askcard. In particular a bare
 * "search" is excluded so "search the codebase" / "implement the search
 * feature" still get scoped.
 */
const EXTERNAL_INFO_SCOPE_RE =
  /https?:\/\/\S+|\bsearch\s+(the\s+)?(web|internet|online)\b|\bweb\s*search\b|\bon\s+the\s+(web|internet)\b|\bgoogle\b|\b(news|weather|headlines)\b/i;

export function hasExternalInfoScope(raw: string): boolean {
  return EXTERNAL_INFO_SCOPE_RE.test(raw);
}

export function shouldAutoPass(l1: L1Signal, raw: string): boolean {
  if (l1.confidence < getAutoPassThreshold()) return false;
  if (!canInferOutcome(l1.taskType, raw)) return false;
  // PIL-L6 fix — debug prompts about CI/build/deploy don't need a file path
  // because their scope is the pipeline itself. Operational scope counts.
  if (
    countFileReferences(raw) === 0 &&
    !hasExplicitScope(raw) &&
    !hasOperationalScope(raw) &&
    !hasImageScope(raw) &&
    !hasExternalInfoScope(raw)
  )
    return false;
  if (l1.complexity === "high") return false;
  return true;
}

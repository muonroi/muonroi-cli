/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection — MODEL-FIRST ONLY.
 * The configured chat model (via opts.llmFallback) classifies taskType / intent
 * / style / depth / clarity / scope / language. The old keyword-regex "Pass 0-4"
 * cascade was DELETED (2026-07-07, no-regex rule) — regex no longer decides
 * intent. When no classifier is wired the layer degrades to UNKNOWN (taskType
 * null, keep-tools), never a regex guess. On a classify miss the classifier
 * self-repairs (see createLlmClassifier) before surfacing UNKNOWN.
 * Fail-open: any error returns ctx unchanged with applied=false.
 *
 * NOTE: scoreComplexity / scoreSufficiency below are retained ONLY because other
 * modules (playbook, discovery, orchestrator) still import them; they no longer
 * run on this layer's classification path.
 */

import { pilContext } from "../ee/bridge.js";
import type { GsdPhase } from "../gsd/types.js";
import { getUnifiedPilBudgetMs, isLlmFirstBrainEnabled } from "./config.js";
import type { LlmClassifyFn, LlmClassifyResult } from "./llm-classify.js";
import type { BrainData, IntentDetectionTrace, OutputStyle, PipelineContext, TaskType } from "./types.js";

function mapBrainGsdPhase(value: string | null | undefined): GsdPhase | null {
  if (value === "discuss" || value === "execute") return value;
  return null;
}

// ---------------------------------------------------------------------------
// P2: Complexity heuristic — pure, sync, no I/O
// ---------------------------------------------------------------------------

export interface ComplexityInput {
  rawText: string;
  taskType: string | null;
  t0HitCount: number;
  hasMaxSprintsOne: boolean;
}

export interface ComplexityOutput {
  complexity: "low" | "medium" | "high";
  score: number;
}

/** File/path reference regex — matches common source-file extensions. */
const FILE_REF_RE = /[\w./-]+\.(ts|tsx|js|jsx|json|md|py|rs|go|cs)\b/gi;

/** Keywords that force a "low" complexity signal (additive score -3). */
const FORCE_LOW_RE = /\b(fix typo|rename|delete|format|lint|whitespace|comment only)\b/i;

/** Keywords that push toward "high" complexity (additive score +3). */
const FORCE_HIGH_RE =
  /\b(architect|architecture|migrate|migration|refactor|design|platform|multi-tenant|microservic|distributed|scale)\b/i;

// ---------------------------------------------------------------------------
// Sufficiency heuristic — does the prompt carry enough context to skip Council?
// Inverted relative to complexity: vague/short prompts about ambiguous products
// (e.g. "todo app", "build a chat platform") MUST go through Council so AskCard
// can surface persona/MVP/architecture/verify questions before code is written.
// ---------------------------------------------------------------------------

export type SufficiencyMissing = "scope" | "target" | "intent";

export interface SufficiencyInput {
  rawText: string;
}

export interface SufficiencyOutput {
  sufficient: boolean;
  missing: readonly SufficiencyMissing[];
}

/** Vague product/system nouns whose scope is undefined without follow-up Qs. */
const VAGUE_PRODUCT_RE = /\b(app|application|site|service|product|system|platform|tool|website|dashboard|portal)\b/i;

/** Concrete imperative verbs that pin the action to a specific change. */
const CONCRETE_VERB_RE =
  /\b(fix|rename|delete|remove|add|move|extract|inline|format|lint|update|upgrade|bump|revert)\b/i;

/** Source-y nouns that imply a localized target even without a file path. */
const SCOPE_NOUN_RE = /\b(function|class|method|file|test|endpoint|component|module|package|hook|schema|migration)\b/i;

/**
 * Score whether a prompt has enough context for the hot-path to be safe.
 *
 * The router treats `!sufficient` as a forced-Council signal — empty AskCard
 * answers are cheaper than scaffolding the wrong product. Returned `missing`
 * categories drive the discovery seed prompts in the Council preflight.
 *
 * Categories:
 *  - "target": no file ref + no concrete verb → "fix what?", "rename what?"
 *  - "scope":  vague product noun in a short prompt → persona/MVP/architecture
 *  - "intent": very short, no scope-noun, no file-ref → "create new / fix bug / refactor?"
 */
export function scoreSufficiency(input: SufficiencyInput): SufficiencyOutput {
  const text = input.rawText ?? "";
  const trimmed = text.trim();
  const len = trimmed.length;

  // Empty prompts are degenerate — caller catches them earlier, but be safe.
  if (len === 0) {
    return { sufficient: false, missing: ["intent", "target", "scope"] };
  }

  const hasFileRef = FILE_REF_RE.test(trimmed);
  // Reset lastIndex for regex with /g flag so subsequent calls don't skip.
  FILE_REF_RE.lastIndex = 0;
  const hasConcreteVerb = CONCRETE_VERB_RE.test(trimmed);
  const hasScopeNoun = SCOPE_NOUN_RE.test(trimmed);
  const isVagueProduct = VAGUE_PRODUCT_RE.test(trimmed);

  const missing: SufficiencyMissing[] = [];

  // 1. target — what concrete thing are we changing?
  //    File ref OR concrete verb is enough to establish the target.
  if (!hasFileRef && !hasConcreteVerb) missing.push("target");

  // 2. scope — vague product noun in a short prompt means architecture unknown.
  //    Threshold 80 chars: long descriptions usually carry the scope themselves.
  if (isVagueProduct && len < 80) missing.push("scope");

  // 3. intent — too short to know what kind of task this is.
  //    Catches single-word prompts like "todo", "auth" that lack any verb/noun signal.
  if (!hasScopeNoun && !hasFileRef && !hasConcreteVerb && len < 30) missing.push("intent");

  return { sufficient: missing.length === 0, missing };
}

/**
 * Score a prompt's complexity using cheap, purely local heuristics.
 * Returns a bucketed label and the raw score so callers can log both.
 */
export function scoreComplexity(input: ComplexityInput): ComplexityOutput {
  const { rawText, taskType, t0HitCount, hasMaxSprintsOne } = input;
  let score = 0;

  // Length signal
  const len = rawText.length;
  if (len > 500) score += 3;
  else if (len > 200) score += 2;
  else if (len > 50) score += 1;
  // 0-50: +0

  // File reference count signal
  const fileRefs = (rawText.match(FILE_REF_RE) ?? []).length;
  if (fileRefs >= 3) score += 2;
  else if (fileRefs >= 1) score += 1;

  // Keyword signals
  if (FORCE_LOW_RE.test(rawText)) score -= 3;
  if (FORCE_HIGH_RE.test(rawText)) score += 3;

  // Context signals
  if (hasMaxSprintsOne) score -= 2;
  if (t0HitCount > 0) score -= 1;
  if (taskType === "debug") score += 1;

  // Bucket
  let complexity: "low" | "medium" | "high";
  if (score <= 2) complexity = "low";
  else if (score <= 5) complexity = "medium";
  else complexity = "high";

  return { complexity, score };
}

/**
 * Pass 0 — deterministic full-prompt overrides.
 *
 * Two narrow regexes that run BEFORE the local classifier and the LLM bridge.
 * Each must match the ENTIRE trimmed prompt (anchored ^…$) so they never
 * accidentally swallow embedded substrings like "ok let's refactor X".
 *
 * Rationale (Phase 5 BUG-B + BUG-D, evidenced by sha8-tagged pil rows):
 *  - "tiếp tục nhé" (12 chars, 3 words) bypassed Pass 2.5 hot-path chitchat
 *    short-circuit (<10 chars, ≤2 words gate) → fell into Pass 3 LLM bridge,
 *    which non-deterministically classified the same input as
 *    general/chitchat one turn and generate/task the next (session
 *    fc19b4daee20 seq 22 vs 24). Continuation phrases never carry a task —
 *    pin them to general/chitchat deterministically.
 *  - "optimize startup performance" classified as analyze (session
 *    9c63a38197f3) once and generate (session 1bc27b79223c) the next time
 *    by the LLM bridge. Pass 2 keyword fallback had no pattern for
 *    optimization verbs, so the only signal was the LLM bridge — which
 *    drifted. The correct label is refactor (restructure existing code
 *    for performance). Pin it deterministically.
 *
 * When either pattern hits we short-circuit the whole layer1Intent flow
 * by setting `passes0Hit` and skipping Pass 1-4 entirely. This eliminates
 * the LLM round-trip cost on these high-frequency patterns and removes
 * the nondeterminism source.
 */
const CONTINUATION_FULL_RE =
  /^\s*(tiếp tục|tiep tuc|tiếp|tiep|continue|go on|keep going|proceed|next|carry on|được rồi|duoc roi|được|duoc|ok|okay|oke|yes|yeah|yep)(\s+(nhé|nha|nhe|please|then|now|đi|di))?\s*[.!?]?\s*$/i;

const PERF_REFACTOR_RE =
  /\b(optimi[zs]e|optimi[zs]ation|speed\s*up|make\s+.+?\s+faster|run\s+faster|load\s+faster|throughput|latency|tối\s*ưu|toi\s*uu|tăng\s*tốc|tang\s*toc)\b/i;

// Phase 5 BUG-E (session f1a2a2a547db) — prompts like
// "improve test coverage cho src/X.ts (viết test cases, chạy test verify pass)"
// were classified `analyze` by Pass 1 (regex:read), conf=0.85, which then
// tripped the auto-council gate (analyze + conf>=0.85). The correct label is
// `generate` (writing new tests = creating code). Pin it deterministically
// BEFORE Pass 1 so the auto-council check sees taskType=generate.
//
// We require BOTH a coverage/test signal AND an action verb that means
// "produce tests" — bare "review the tests" stays as analyze.
const TEST_COVERAGE_TRIGGER_RE =
  /\b(test\s*coverage|unit\s*test(?:s|ing)?|coverage|độ\s*phủ|do\s*phu)\b|\b(write|add|create|generate|scaffold|viết|viet|thêm|them|tạo|tao|sinh)\s+(?:new\s+)?(?:unit\s+)?test/i;
const TEST_GENERATE_VERB_RE =
  /\b(write|add|create|generate|scaffold|implement|improve|tạo|tao|viết|viet|sinh|thêm|them|tăng|tang)\b/i;

/** Detect prompts asking to WRITE/ADD test cases — these are 'generate', not 'analyze'. */
export function isTestGenerationTask(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (!TEST_COVERAGE_TRIGGER_RE.test(t)) return false;
  if (!TEST_GENERATE_VERB_RE.test(t)) return false;
  // Guard: pure review prompts (no production verb) stay analyze.
  if (/^(review|inspect|read|đọc|doc|xem)\b/i.test(t) && !TEST_GENERATE_VERB_RE.test(t)) return false;
  return true;
}

/** Detect optimization-verb prompts where refactor is the correct taskType. */
export function isPerformanceRefactor(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (!PERF_REFACTOR_RE.test(t)) return false;
  // Guard: if the prompt explicitly asks to ADD a new test/feature/file
  // about performance, defer to the LLM bridge — those are 'generate'.
  if (/\b(add|create|write|generate|scaffold|implement|tạo|tao|viết|viet|sinh|thêm|them)\b/i.test(t)) return false;
  // Guard: explicit analyze verbs override (we want analyze, not refactor).
  if (
    /\b(explain|describe|why|how does|analy[sz]e|review|investigate|tại sao|tai sao|giải thích|giai thich)\b/i.test(t)
  )
    return false;
  return true;
}

// Greenfield CREATE/BUILD intent → generate.
//
// Live `/ideal` E2E verify (fix/council-oauth-reachable): greenfield BUILD
// prompts were misclassified at the pil-acceptance card —
//   "build a muonroi-building-block microservice …"           → refactor
//   "build a Node TS ISO-4217 currency validator w/ vitest tests" → analyze
// Root cause: the verb "build" (and bare "create X" where X is not one of the
// literal nouns file/component/module/class/function) is recognized by NO
// deterministic pass. Pass 1's create-file regex only fires on those literal
// nouns; Pass 2's `generate` keyword only has generate/scaffold/bootstrap. So
// greenfield "build/create/implement X" prompts fall through to the brain/LLM
// — documented to bias toward `refactor` for any code touch (see Pass 3 legacy
// prompt, 4P-2) — and worse, a build prompt that merely mentions "test(s)" is
// hijacked by the Pass 2 `analyze` keyword. Pin greenfield creation to
// `generate` deterministically here, before the classifier + brain.
//
// VERB must be the LEADING action (after an optional polite/intent prefix) so
// "explain how to build X", "the build is failing", "rename the build fn" never
// match. A concrete software-artifact noun must be the object of creation, and
// build-FAILURE / debug context vetoes the match (those are bug reports).
const GREENFIELD_BUILD_PREFIX = String.raw`(?:please\s+|pls\s+|plz\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+(?:please\s+)?|help\s+me\s+(?:to\s+)?|let'?s\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|i'?d\s+like\s+(?:you\s+)?to\s+|go\s+ahead\s+and\s+|now\s+|then\s+|just\s+)*`;
const GREENFIELD_BUILD_VERB = String.raw`build|create|make|implement|develop|scaffold|bootstrap|generate|code\s+up|spin\s+up|stand\s+up|set\s+up|put\s+together`;
const GREENFIELD_BUILD_LEAD_RE = new RegExp(`^\\s*${GREENFIELD_BUILD_PREFIX}(?:${GREENFIELD_BUILD_VERB})\\b`, "i");
// Concrete software artifacts (the thing being created). Deliberately excludes
// "test"/"branch"/"commit" — test-generation is handled by isTestGenerationTask
// and git verbs route elsewhere — so "make the tests pass" / "create a branch"
// do not trip this.
const GREENFIELD_BUILD_TARGET_RE =
  /\b(app|application|web\s*app|webapp|service|micro[-\s]?service|api|endpoint|server|backend|frontend|cli|tool|utility|library|lib|sdk|package|module|component|widget|page|screen|view|dashboard|website|site|portal|platform|system|engine|parser|validator|formatter|serializer|converter|calculator|generator|linter|compiler|interpreter|middleware|pipeline|workflow|daemon|worker|queue|cache|store|database|schema|model|migration|script|bot|game|simulator|prototype|mvp|poc|demo|feature|function|class|hook|wrapper|adapter|plugin|extension|proxy|gateway|router|handler|controller|resolver|crawler|scraper|client)\b/i;
// Failure / debug context — a "build" that is FAILING / BROKEN is a bug report,
// not greenfield creation. Cascade to the debug classifier instead.
const GREENFIELD_BUILD_FAILURE_GUARD_RE =
  /\b(fail(?:s|ed|ing|ure)?|broken|broke|crash(?:es|ed|ing)?|not\s+working|doesn'?t\s+work|won'?t\s+(?:build|compile|run)|hỏng)\b/i;

/**
 * Detect a greenfield CREATE/BUILD request whose correct taskType is `build`.
 * Tight by construction: requires a LEADING creation verb + a software-artifact
 * object, and vetoes build-failure/debug context. When unsure it returns false
 * so the prompt cascades to the classifier + brain (no wrong deterministic pin).
 *
 * `build` is a first-class TaskType (greenfield project/feature creation) — it is
 * the sole producer of that label. It mirrors `generate` for routing (tier/role/
 * tokens/ceiling) but carries greenfield-specific outcome options + output rules.
 * This replaces the F17 band-aid that pinned greenfield prompts to `generate`.
 */
export function isGreenfieldBuildTask(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 400) return false;
  if (!GREENFIELD_BUILD_LEAD_RE.test(t)) return false;
  if (GREENFIELD_BUILD_FAILURE_GUARD_RE.test(t)) return false;
  return GREENFIELD_BUILD_TARGET_RE.test(t);
}

/** Detect short continuation prompts ("tiếp tục", "ok", "continue", …). */
export function isContinuationPhrase(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 40) return false;
  return CONTINUATION_FULL_RE.test(t);
}

// Status / meta follow-up questions — "do you have it yet?", "are you done?",
// "bạn đã có plan chưa nhỉ". These ask ABOUT the state of work already produced
// earlier in the thread; they are NOT a request to start a fresh task.
//
// Session c6387d2c6e1b: after the agent produced a cleanup plan (respond_plan),
// the user asked "bạn đã có plan chưa nhỉ". Pass 2's `plan` keyword matched the
// word "plan" → taskType=plan, kind=task → the GSD "state a NEW 2-3 line plan +
// implement + verify" scaffold + a degenerate generic discovery scope
// ("Intent: plan: Step-by-step plan / Scope: project root") were injected. That
// overrode the conversational intent and the model went off-topic (asked about
// a plan for a different project) instead of answering "yes — here is the plan
// I just gave you". History was NOT compacted (compactions=0), so the prior
// plan was present; the defect was purely the misclassification + scaffold.
//
// Route these like a continuation → chitchat → answer from context, no scaffold.
//
// VI: anchored to the END so a trailing imperative ("…, nếu chưa thì sửa đi")
// cannot match — a pure status question ends with the interrogative marker
// "chưa" (optionally + rồi/nhỉ/vậy/ạ/punct), never with a directive verb.
// EN: yes/no question opening with an auxiliary and ending on a status word.
const STATUS_CHECK_VI_RE = /\bch[ưu]a\b\s*(r[ồo]i)?\s*(nh[ỉi]|v[ậa]y|[ạa]|nha|nhé|nhe)?\s*[?.!…]*\s*$/i;
const STATUS_CHECK_EN_RE =
  /^(so\s+)?(do|did|have|has|are|is|was)\s+(you|it|that|the|there)\b[^?.!\n]{0,60}\b(yet|done|ready|finish(?:ed)?|complete[d]?|ready|available)\b[?.!]*\s*$/i;

/**
 * True when the prompt is a conversational STATUS/META question about work
 * already discussed (not a fresh task request). Guarded: short prompts only,
 * and never when an explicit tool/command intent is present (those must keep
 * the toolset). See the regex comment above for the originating session.
 */
export function isStatusCheckQuestion(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 80) return false;
  if (hasActionableToolIntent(t)) return false;
  return STATUS_CHECK_VI_RE.test(t) || STATUS_CHECK_EN_RE.test(t);
}

// Detect language/domain from prompt content. Order matters: code fences first
// (highest signal), file extensions next, then bare keywords.
const DOMAIN_PATTERNS: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /```(?:ts|tsx|typescript)\b/i, domain: "typescript" },
  { pattern: /```(?:js|jsx|javascript)\b/i, domain: "javascript" },
  { pattern: /```(?:py|python)\b/i, domain: "python" },
  { pattern: /```(?:rs|rust)\b/i, domain: "rust" },
  { pattern: /```(?:go|golang)\b/i, domain: "go" },
  { pattern: /```(?:java)\b/i, domain: "java" },
  { pattern: /```(?:cs|csharp)\b/i, domain: "csharp" },
  { pattern: /```(?:rb|ruby)\b/i, domain: "ruby" },
  { pattern: /\.(tsx?)\b/i, domain: "typescript" },
  { pattern: /\.(jsx?)\b/i, domain: "javascript" },
  { pattern: /\.py\b/i, domain: "python" },
  { pattern: /\.rs\b/i, domain: "rust" },
  { pattern: /\.go\b/i, domain: "go" },
  { pattern: /\.java\b/i, domain: "java" },
  { pattern: /\.cs\b/i, domain: "csharp" },
  { pattern: /\.rb\b/i, domain: "ruby" },
  { pattern: /\b(typescript|tsconfig|tsc)\b/i, domain: "typescript" },
  { pattern: /\b(python|pip|venv|django|flask)\b/i, domain: "python" },
  { pattern: /\b(rust|cargo)\b/i, domain: "rust" },
  { pattern: /\b(golang)\b/i, domain: "go" },
];

function extractDomain(reason: string, raw: string): string | null {
  // Tree-sitter signals are highest-confidence (the parser actually understood the code).
  if (reason.includes("typescript")) return "typescript";
  if (reason.includes("python")) return "python";
  // Fall back to raw-prompt scan so regex-classified turns still get domain.
  for (const { pattern, domain } of DOMAIN_PATTERNS) {
    if (pattern.test(raw)) return domain;
  }
  return null;
}

// Regex-based outputStyle detection — catches explicit user requests in EN/VN
// before we ever ask the brain. Order: most-specific first.
const STYLE_PATTERNS: Array<{ pattern: RegExp; style: OutputStyle }> = [
  { pattern: /\b(concise|brief|terse|short answer|tl;?dr|một câu|ngắn gọn|vắn tắt|tóm tắt)\b/i, style: "concise" },
  {
    pattern: /\b(detailed|thorough|in depth|step by step|walk me through|chi tiết|cặn kẽ|đầy đủ|từng bước)\b/i,
    style: "detailed",
  },
  { pattern: /\b(balanced|normal|standard|cân bằng|bình thường)\b/i, style: "balanced" },
];

function _detectStyleFromText(raw: string): OutputStyle | null {
  for (const { pattern, style } of STYLE_PATTERNS) {
    if (pattern.test(raw)) return style;
  }
  return null;
}

export interface Layer1Options {
  /** Pass 4 LLM fallback closure — fires when brain returned null or confidence < 0.7. */
  llmFallback?: LlmClassifyFn;
  /**
   * WhoAmI v4.0 output-style baseline, derived once in the pipeline from the
   * device-local profile (via ../ee/bridge.js getWhoAmIProfile + outputStyleFromProfile).
   * Applied as the standing default when no per-turn style signal resolves — replaces
   * the generic "balanced" classifier-default. null/undefined ⇒ behaviour unchanged.
   * Passed in (not read here) to keep layer1 off the EE/profile import path.
   */
  profileStyleBaseline?: OutputStyle | null;
  /**
   * Compact digest of the last few conversation turns. Forwarded to the LLM
   * classifier so a terse follow-up that back-references heavy prior work
   * ("từ các phần đó", "làm tiếp") is scored on the real work, not the isolated
   * sentence. null/undefined ⇒ classifier sees the bare prompt (old behaviour).
   */
  recentTurns?: string | null;
}

// Explicit command/tool-execution signals (EN + VI). When any fires the turn
// is a real action request, so it must NEVER be classified chitchat — chitchat
// drops the entire toolset (incl. bash) in message-processor, leaving the
// agent unable to act. Found via harness session 817e508f57ee: the cheap LLM
// classifier labelled "Dùng bash tool chạy 1 lệnh…" as general → chitchat →
// bash dropped. High-precision tokens only; a false positive merely re-adds
// ~1.5K tokens of tool schema, while a false negative breaks the turn.
const TOOL_NAME_RE = /\b(bash|read_file|edit_file|write_file|ripgrep)\b/i;
const EXEC_INTENT_RE =
  /\b(run|execute|exec)\b[^.?!\n]{0,40}\b(command|cmd|commands|script|scripts|shell|bash|test|tests|build|lint)\b/i;
const VI_EXEC_RE = /\bch[ạa]y\b[^.?!\n]{0,40}\b(l[ệe]nh|command|cmd|script|shell|bash|test|build|lint)\b/i;

/**
 * True when the prompt is an explicit request to RUN a command / use a shell
 * tool. Used to veto a chitchat classification so the toolset is preserved.
 */
export function hasActionableToolIntent(raw: string): boolean {
  if (!raw) return false;
  return TOOL_NAME_RE.test(raw) || EXEC_INTENT_RE.test(raw) || VI_EXEC_RE.test(raw);
}

// Pure social-pleasantry vocabulary (EN + VI). CORE = greeting/thanks/ack/
// farewell tokens that carry the social intent; FILLER = pronouns, particles,
// articles, intensifiers, politeness words that legitimately surround them.
// Deliberately EXCLUDES any token that could carry work ("help", "fix",
// "make", "do", file names, …) so the all-tokens-whitelist test below can never
// match a real task.
const SOCIAL_CORE = new Set([
  // greetings
  "hi",
  "hello",
  "hey",
  "yo",
  "hiya",
  "heya",
  "hallo",
  "chào",
  "chao",
  "hola",
  // thanks
  "thanks",
  "thank",
  "thx",
  "ty",
  "tks",
  "thankyou",
  "cảm",
  "ơn",
  "cám",
  "cam",
  "ơn",
  "thankss",
  // farewells
  "bye",
  "goodbye",
  "cya",
  "tạm",
  "biệt",
  "biet",
  "farewell",
  // acknowledgements / affirmations
  "ok",
  "okay",
  "okie",
  "oke",
  "okey",
  "k",
  "great",
  "nice",
  "cool",
  "perfect",
  "awesome",
  "good",
  "fine",
  "sweet",
  "excellent",
  "brilliant",
  "wonderful",
  "amazing",
  "superb",
  "tuyệt",
  "tuyet",
  "vời",
  "voi",
  "ngon",
  "ổn",
  "yeah",
  "yep",
  "yup",
  "nice1",
]);
const SOCIAL_FILLER = new Set([
  // pronouns / address
  "you",
  "u",
  "ya",
  "bạn",
  "ban",
  "mình",
  "minh",
  "we",
  "i",
  // intensifiers / quantity
  "very",
  "much",
  "so",
  "really",
  "lot",
  "lots",
  "too",
  "rất",
  "rat",
  "nhiều",
  "nhieu",
  // articles / connectors / objects-of-thanks (safe: surrounding task words block the match)
  "a",
  "an",
  "the",
  "for",
  "all",
  "that",
  "this",
  "it",
  "everything",
  "again",
  "and",
  // time / address fillers
  "today",
  "now",
  "there",
  "here",
  "mate",
  "man",
  "friend",
  "bro",
  "guys",
  "team",
  // politeness / particles (VI + EN)
  "please",
  "pls",
  "plz",
  "nhé",
  "nhe",
  "nha",
  "ạ",
  "à",
  "ạ.",
  "dude",
  "buddy",
]);

/**
 * True when the prompt is a PURE social pleasantry (greeting / thanks / ack /
 * farewell) — even when it is longer than the 2-word hot-path that Pass 2.5
 * catches. Used to classify such turns as chitchat so message-processor can
 * drop the ~15-20K tool-schema tax (a thank-you never needs bash/read_file/MCP).
 *
 * STRICT by construction: EVERY whitespace token must be social CORE or FILLER
 * vocabulary, and at least one must be CORE. Any task/tool/file token (not in
 * the whitelist) makes it false, so it can never swallow a real request — the
 * bias is keep-tools. Live leak: "cảm ơn bạn rất nhiều nhé" (session
 * 40c726a31a37) paid toolCount=37 because the old gate required ≤10 chars.
 */
export function isSocialPleasantry(raw: string): boolean {
  if (!raw) return false;
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  let hasCore = false;
  for (const t of tokens) {
    if (SOCIAL_CORE.has(t)) {
      hasCore = true;
      continue;
    }
    if (SOCIAL_FILLER.has(t)) continue;
    return false;
  }
  return hasCore;
}

export async function layer1Intent(ctx: PipelineContext, opts: Layer1Options = {}): Promise<PipelineContext> {
  try {
    // Pass −1 — MODEL-FIRST classification (MUONROI_LLM_FIRST_CLASSIFY, default ON).
    //
    // The configured model classifies taskType/intentKind/style at the very top
    // of the turn; the keyword-regex cascade below becomes the OFFLINE fallback,
    // used only when the model is not wired (opts.llmFallback absent) or its call
    // fails. This is the structural fix for "classifying tasks via keyword regex
    // misses billions of natural-language cases" — regex no longer DECIDES intent,
    // it only catches the model-offline case. The EE brain still enriches
    // downstream (layer3 retrieval) as before. Trivial turns ("ok", greetings)
    // also go through the model so chitchat is a semantic decision, not a regex
    // whitelist; the model returns intentKind="chat" for pure pleasantries.
    // Model-first is the SOLE classifier whenever one is wired. The old
    // MUONROI_LLM_FIRST_CLASSIFY killswitch is gone: it used to select the
    // keyword-regex cascade, which was deleted (2026-07-07, no-regex rule).
    if (opts.llmFallback) {
      let llmRes: LlmClassifyResult | null = null;
      let classifyError: string | null = null;
      try {
        llmRes = await opts.llmFallback(ctx.raw, { recentTurns: opts.recentTurns });
      } catch (err) {
        classifyError = (err as Error)?.message ?? String(err);
      }
      if (llmRes) {
        let intentKind: "task" | "chitchat" = llmRes.intentKind;
        // Safety net (never weakens the model): an explicit command/tool-exec
        // request must never be chitchat — chitchat drops the whole toolset and
        // breaks the turn. Only ever upgrades chitchat → task.
        if (intentKind === "chitchat" && hasActionableToolIntent(ctx.raw)) intentKind = "task";
        // Style + complexity come from the MODEL, never a keyword regex. Style
        // is the model's word or null (layer4/6 handle null without regex).
        // Complexity is derived from the model's depthTier purely for the
        // telemetry trace — routing reads depthTier directly, not this.
        const outputStyle = llmRes.outputStyle;
        const domain = extractDomain("", ctx.raw);
        const complexity: "low" | "medium" | "high" =
          llmRes.depthTier === "heavy" ? "high" : llmRes.depthTier === "quick" ? "low" : "medium";
        const complexityScore = 0;
        const intentTrace: IntentDetectionTrace = {
          pass1Reason: "llm-first",
          pass1Confidence: llmRes.confidence,
          pass1TaskType: llmRes.taskType,
          pass1Hit: false,
          pass2Hit: false,
          pass2Pattern: undefined,
          pass25ChitchatHit: false,
          pass3UnifiedAttempted: false,
          pass3UnifiedSucceeded: false,
          pass3LegacyTaskAttempted: false,
          pass3LegacyTaskSucceeded: false,
          pass3LegacyStyleAttempted: false,
          pass3LegacyStyleSucceeded: false,
          pass4LlmAttempted: true,
          pass4LlmSucceeded: true,
          styleSource: llmRes.outputStyle ? "brain-unified" : "none",
          finalTaskType: llmRes.taskType,
          finalConfidence: llmRes.confidence,
          complexity,
          complexityScore,
        };

        // G3 (b1): reach the unified injection on the default (model-first)
        // path. Without this, _brainData stays null and layer3 falls back to a
        // legacy dense-only /api/search round-trip with divergent source
        // attribution. Populate _brainData from the SAME server-side unified
        // retrieval the offline cascade uses (one round-trip, bounded by budget)
        // so layer3 renders the richer source="unified" block AND records the
        // rateable ledger consistently. On chitchat / null / failure, _brainData
        // stays null → layer3 legacy path (behaviour unchanged). Gate:
        // MUONROI_LLM_FIRST_BRAIN=0 reverts.
        let llmFirstBrainData: BrainData | null = null;
        let llmFirstGsdPhase: GsdPhase | null = mapBrainGsdPhase(ctx.gsdPhase);
        if (isLlmFirstBrainEnabled() && intentKind !== "chitchat") {
          let brainRaw = ctx.raw;
          if (ctx.sessionId) {
            brainRaw =
              ctx.raw +
              ' [EE task checkpoints ("Context checkpoint summary" with ✔ DONE) from prior compactions are available via the ee.query tool. ' +
              "To keep full tool history this turn when you see pre-warn or compaction note, emit exact literal PRESERVE_FULL_CONTEXT in reasoning or assistant note. " +
              'Self-check "task finished?" or "compacted yet this turn?" using the checkpoints.]';
          }
          intentTrace.pass3UnifiedAttempted = true;
          // try/catch (not .catch) so a SYNC throw from pilContext (e.g. no EE
          // client configured, as in unit tests) is also swallowed — it must
          // never break the model-first return; _brainData just stays null.
          let resp: Awaited<ReturnType<typeof pilContext>> = null;
          try {
            resp = await pilContext(brainRaw, {
              projectCtx: domain ? { domain } : undefined,
              budgetMs: getUnifiedPilBudgetMs(),
            });
          } catch (err) {
            console.error(`[pil/layer1] llm-first unified brain fetch failed: ${(err as Error)?.message}`);
          }
          if (resp) {
            llmFirstBrainData = {
              t0_principles: resp.t0_principles,
              t1_rules: resp.t1_rules,
              t2_patterns: resp.t2_patterns,
              retrieval_skipped_reason: resp.retrieval_skipped_reason,
            };
            llmFirstGsdPhase = mapBrainGsdPhase(resp.gsd_phase) ?? llmFirstGsdPhase;
            intentTrace.pass3UnifiedSucceeded = true;
          }
        }

        return {
          ...ctx,
          taskType: llmRes.taskType,
          gsdPhase: llmFirstGsdPhase,
          domain,
          confidence: llmRes.confidence,
          outputStyle,
          intentKind,
          // Phase 2b: model-decided deliverable drives layer4/layer6 output
          // routing instead of keyword regex. null → those layers fall back to
          // their legacy regex predicates for this turn.
          deliverableKind: llmRes.deliverableKind,
          // Agent-first work depth: the model decides the GSD tier in the same
          // classify call (no extra round-trip). layer4 prefers this over the
          // regex scorer. null → layer4 defaults to "standard".
          modelDepthTier: llmRes.depthTier,
          // Agent-first scope + reply-language (same classify call). Replace the
          // ecosystem/diacritic regexes: layer4 reads these instead of scanning
          // the raw prompt.
          ecosystemScope: llmRes.ecosystemScope,
          scopeKind: llmRes.scopeKind,
          replyLanguage: llmRes.replyLanguage,
          // G3 (b1): populated from the unified pil-context fetch above so
          // layer3 renders source="unified" instead of its legacy dense-only
          // round-trip. null (chitchat / fetch failed) → layer3 legacy path.
          _brainData: llmFirstBrainData,
          _intentTrace: intentTrace,
          layers: [
            ...ctx.layers,
            {
              name: "intent-detection",
              applied: true,
              delta: `taskType=${llmRes.taskType},kind=${intentKind},deliverable=${llmRes.deliverableKind ?? "none"},depth=${llmRes.depthTier ?? "none"},conf=${llmRes.confidence.toFixed(2)},domain=${domain ?? "none"},style=${outputStyle ?? "none"},source=llm-first`,
            },
          ],
        };
      }
      // NO fallback. The configured chat model is the SOLE classifier — it is
      // the model the turn talks to, so it cannot be "offline". A null/failed
      // result is a real problem: log it loudly and surface it, NEVER paper over
      // it with a regex guess (which would be confidently wrong — the whole
      // reason we moved off keyword regex). Return an UNKNOWN classification
      // (taskType=null): no PIL scaffold is imposed and the chat model still
      // answers the turn directly — but nothing pretends to know the intent.
      console.error(
        "[pil.layer1] model-first classify produced no usable result — NOT falling back to regex. " +
          `reason=${classifyError ?? "null/unparseable model response"} ` +
          `model-classifier=wired rawPreview=${JSON.stringify(ctx.raw.slice(0, 120))}`,
      );
      // No regex on the failure path either — UNKNOWN classification carries a
      // neutral "medium" complexity for the telemetry trace, decided by nothing.
      const failComplexity: "low" | "medium" | "high" = "medium";
      const failComplexityScore = 0;
      return {
        ...ctx,
        taskType: null,
        domain: null,
        confidence: 0,
        outputStyle: null,
        // keep-tools: a classify failure must never strip the toolset.
        intentKind: "task",
        _brainData: null,
        _intentTrace: {
          pass1Reason: "llm-first-failed",
          pass1Confidence: 0,
          pass1TaskType: null,
          pass1Hit: false,
          pass2Hit: false,
          pass2Pattern: undefined,
          pass25ChitchatHit: false,
          pass3UnifiedAttempted: false,
          pass3UnifiedSucceeded: false,
          pass3LegacyTaskAttempted: false,
          pass3LegacyTaskSucceeded: false,
          pass3LegacyStyleAttempted: false,
          pass3LegacyStyleSucceeded: false,
          pass4LlmAttempted: true,
          pass4LlmSucceeded: false,
          styleSource: "none",
          finalTaskType: null,
          finalConfidence: 0,
          complexity: failComplexity,
          complexityScore: failComplexityScore,
        },
        layers: [
          ...ctx.layers,
          {
            name: "intent-detection",
            applied: false,
            delta: `llm-first=FAIL (${classifyError ?? "no-result"}) — surfaced, NO regex fallback`,
          },
        ],
      };
    }

    // No model classifier wired (opts.llmFallback absent) → the regex
    // classification cascade that used to run here was DELETED (2026-07-07,
    // no-regex rule). Degrade to UNKNOWN (keep-tools): no PIL scaffold is
    // imposed and the chat model still answers the turn, but nothing fabricates
    // an intent from keyword regex.
    console.error(
      "[pil.layer1] no model classifier wired (opts.llmFallback absent) — UNKNOWN classification, NO regex cascade.",
    );
    return {
      ...ctx,
      taskType: null,
      domain: null,
      confidence: 0,
      outputStyle: null,
      intentKind: "task",
      _brainData: null,
      _intentTrace: {
        pass1Reason: "no-classifier-wired",
        pass1Confidence: 0,
        pass1TaskType: null,
        pass1Hit: false,
        pass2Hit: false,
        pass2Pattern: undefined,
        pass25ChitchatHit: false,
        pass3UnifiedAttempted: false,
        pass3UnifiedSucceeded: false,
        pass3LegacyTaskAttempted: false,
        pass3LegacyTaskSucceeded: false,
        pass3LegacyStyleAttempted: false,
        pass3LegacyStyleSucceeded: false,
        pass4LlmAttempted: false,
        pass4LlmSucceeded: false,
        styleSource: "none",
        finalTaskType: null,
        finalConfidence: 0,
        complexity: "medium",
        complexityScore: 0,
      },
      layers: [
        ...ctx.layers,
        { name: "intent-detection", applied: false, delta: "no-model-classifier — UNKNOWN, NO regex cascade" },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "intent-detection", applied: false, delta: null }],
    };
  }
}

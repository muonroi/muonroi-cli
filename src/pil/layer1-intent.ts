/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection.
 * Pass 1 — classifier (regex + tree-sitter): maps all 14 possible reason strings to TaskType.
 * Pass 2 — keyword fallback: catches debug/plan/documentation that classifier misses.
 * Pass 3 — EE brain fallback via bridge.classifyViaBrain (replaces ollamaClassify).
 * Populates taskType, confidence, and domain on PipelineContext.
 * outputStyle is always null from Layer 1 — Layer 6 handles output style detection via bridge.
 * Fail-open: any error returns ctx unchanged with applied=false.
 */

import { classifyViaBrain, pilContext } from "../ee/bridge.js";
import { classify } from "../router/classifier/index.js";
import { isUnifiedPilEnabled } from "./config.js";
import type { LlmClassifyFn } from "./llm-classify.js";
import type { BrainData, IntentDetectionTrace, OutputStyle, PipelineContext, TaskType } from "./types.js";

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

// Maps every classifier reason string to a TaskType (or null for non-coding signals).
const REASON_TO_TASK_TYPE: Partial<Record<string, TaskType>> = {
  "regex:refactor": "refactor",
  "regex:edit": "generate",
  "regex:create-file": "generate",
  "regex:run-command": "analyze",
  "regex:explain": "analyze",
  "regex:search": "analyze",
  "regex:install": "analyze",
  // tree-sitter:* parses indicate code presence ONLY — no intent signal.
  // Mapping these to "refactor" caused 4/5 baseline misclassifications
  // (Phase 4, 4P-1). Leave undefined so Pass 2 keyword fallback decides.
  "tree-sitter:typescript": undefined,
  "tree-sitter:python": undefined,
  "regex:read": "analyze",
  "regex:git": "analyze",
  "regex:short-message": "general",
  "regex:design": "plan",
  "regex:debug": "debug",
  // no-match / error / cold / low-confidence → null (conversational passthrough)
  "regex:no-match": undefined,
  "tree-sitter:no-fenced-code": undefined,
  "tree-sitter:cold": undefined,
  "tree-sitter:typescript-parse-error": undefined,
  "tree-sitter:python-parse-error": undefined,
  "low-confidence": undefined,
};

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

// Keyword patterns for task types the classifier doesn't natively handle.
// Applied when classifier abstains OR matches the low-signal "general" path.
// Patterns are bilingual (EN + VN) — Vietnamese cues use accent-insensitive
// alternations so common diacritic drops still match.
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; taskType: TaskType; confidence: number }> = [
  {
    // EN: fix/bug/error/etc.  VN: sửa lỗi, lỗi, hỏng, không chạy
    pattern:
      /\b(fix|bug|error|exception|crash|fail(?:s|ed|ing)?|broken|wrong|issue|traceback)\b|(sửa lỗi|sua loi|báo lỗi|bao loi|\blỗi\b|\bloi\b|hỏng|hong|không chạy|khong chay)/i,
    taskType: "debug",
    confidence: 0.65,
  },
  {
    // EN: plan/roadmap/architecture.  VN: kế hoạch, thiết kế, kiến trúc, lộ trình
    pattern:
      /\b(plan|roadmap|phase|step(?:s)?|approach|design|architect(?:ure)?|strategy)\b|(kế hoạch|ke hoach|thiết kế|thiet ke|kiến trúc|kien truc|lộ trình|lo trinh)/i,
    taskType: "plan",
    confidence: 0.6,
  },
  {
    // EN: docs/readme/jsdoc.  VN: tài liệu, viết doc, ghi chú, comment
    pattern:
      /\b(doc(?:s|umentation)?|readme|comment|jsdoc|tsdoc|docstring)\b|(tài liệu|tai lieu|viết doc|viet doc|ghi chú|ghi chu)/i,
    taskType: "documentation",
    confidence: 0.6,
  },
  {
    // EN: test/spec/coverage.  VN: kiểm thử, viết test, kiểm tra
    pattern:
      /\b(test(?:s|ing)?|spec|unit test|coverage|assert(?:ion)?)\b|(kiểm thử|kiem thu|viết test|viet test|kiểm tra|kiem tra)/i,
    taskType: "analyze",
    confidence: 0.65,
  },
  {
    // EN: refactor.  VN: tái cấu trúc, viết lại, tổ chức lại
    pattern: /\brefactor(?:ing)?\b|(tái cấu trúc|tai cau truc|viết lại|viet lai|tổ chức lại|to chuc lai)/i,
    taskType: "refactor",
    confidence: 0.7,
  },
  {
    // EN: create/generate.  VN: tạo, sinh, viết mới
    pattern: /\b(generate|scaffold|bootstrap)\b|(tạo file|tao file|tạo module|tao module|sinh code|viết mới|viet moi)/i,
    taskType: "generate",
    confidence: 0.65,
  },
];

// Catch-all classifier reasons whose taskType assignment is weak — Pass 2 keyword
// rescue is allowed to override them when confidence is sub-threshold. Specific
// rules like `regex:run-command` / `regex:git` stay authoritative.
const CATCHALL_REASONS = new Set<string>(["regex:edit", "regex:create-file"]);
const HIGH_CONF_THRESHOLD_PASS2 = 0.7;

// Valid task types for bridge classification parsing (matches RESPONSE_SCHEMAS keys minus 'general').
const VALID_TASK_TYPES: TaskType[] = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];

const VALID_STYLES = ["concise", "balanced", "detailed"] as const;

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

function detectStyleFromText(raw: string): OutputStyle | null {
  for (const { pattern, style } of STYLE_PATTERNS) {
    if (pattern.test(raw)) return style;
  }
  return null;
}

export interface Layer1Options {
  /** Pass 4 LLM fallback closure — fires when brain returned null or confidence < 0.7. */
  llmFallback?: LlmClassifyFn;
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
    // Pass 0 — deterministic full-prompt overrides (Phase 5 BUG-B / BUG-D).
    // Two narrow patterns short-circuit the whole pipeline:
    //  - continuation phrase → general/chitchat
    //  - performance/optimization verbs → refactor/task
    // Both eliminate LLM-bridge nondeterminism on inputs whose correct
    // label is unambiguous from the prompt alone.
    if (isContinuationPhrase(ctx.raw)) {
      const { complexity, score: complexityScore } = scoreComplexity({
        rawText: ctx.raw,
        taskType: "general",
        t0HitCount: 0,
        hasMaxSprintsOne: false,
      });
      const intentTrace: IntentDetectionTrace = {
        pass1Reason: "pass0:continuation",
        pass1Confidence: 0.9,
        pass1TaskType: "general",
        pass1Hit: true,
        pass2Hit: false,
        pass25ChitchatHit: false,
        pass3UnifiedAttempted: false,
        pass3UnifiedSucceeded: false,
        pass3LegacyTaskAttempted: false,
        pass3LegacyTaskSucceeded: false,
        pass3LegacyStyleAttempted: false,
        pass3LegacyStyleSucceeded: false,
        pass4LlmAttempted: false,
        pass4LlmSucceeded: false,
        styleSource: "chitchat-default",
        finalTaskType: "general",
        finalConfidence: 0.9,
        complexity,
        complexityScore,
      };
      return {
        ...ctx,
        taskType: "general",
        domain: null,
        confidence: 0.9,
        outputStyle: "concise",
        intentKind: "chitchat",
        _brainData: null,
        _intentTrace: intentTrace,
        layers: [
          ...ctx.layers,
          {
            name: "intent-detection",
            applied: true,
            delta: "taskType=general,kind=chitchat,conf=0.90,domain=none,style=concise,pass0=continuation",
          },
        ],
      };
    }
    if (isStatusCheckQuestion(ctx.raw)) {
      // A meta question about prior work → conversational continuation. Route to
      // chitchat so layer4-gsd skips the "make a NEW plan + implement" scaffold
      // and the agent answers from the existing thread context (session
      // c6387d2c6e1b root cause). Mirrors the continuation branch above.
      const { complexity, score: complexityScore } = scoreComplexity({
        rawText: ctx.raw,
        taskType: "general",
        t0HitCount: 0,
        hasMaxSprintsOne: false,
      });
      const intentTrace: IntentDetectionTrace = {
        pass1Reason: "pass0:status-check",
        pass1Confidence: 0.9,
        pass1TaskType: "general",
        pass1Hit: true,
        pass2Hit: false,
        pass25ChitchatHit: false,
        pass3UnifiedAttempted: false,
        pass3UnifiedSucceeded: false,
        pass3LegacyTaskAttempted: false,
        pass3LegacyTaskSucceeded: false,
        pass3LegacyStyleAttempted: false,
        pass3LegacyStyleSucceeded: false,
        pass4LlmAttempted: false,
        pass4LlmSucceeded: false,
        styleSource: "chitchat-default",
        finalTaskType: "general",
        finalConfidence: 0.9,
        complexity,
        complexityScore,
      };
      return {
        ...ctx,
        taskType: "general",
        domain: null,
        confidence: 0.9,
        outputStyle: "concise",
        intentKind: "chitchat",
        _brainData: null,
        _intentTrace: intentTrace,
        layers: [
          ...ctx.layers,
          {
            name: "intent-detection",
            applied: true,
            delta: "taskType=general,kind=chitchat,conf=0.90,domain=none,style=concise,pass0=status-check",
          },
        ],
      };
    }
    if (isTestGenerationTask(ctx.raw)) {
      const domainPass0 = extractDomain("", ctx.raw);
      const styleFromText = detectStyleFromText(ctx.raw) ?? "balanced";
      const { complexity, score: complexityScore } = scoreComplexity({
        rawText: ctx.raw,
        taskType: "generate",
        t0HitCount: 0,
        hasMaxSprintsOne: false,
      });
      const intentTrace: IntentDetectionTrace = {
        pass1Reason: "pass0:test-generation",
        pass1Confidence: 0.9,
        pass1TaskType: "generate",
        pass1Hit: true,
        pass2Hit: false,
        pass25ChitchatHit: false,
        pass3UnifiedAttempted: false,
        pass3UnifiedSucceeded: false,
        pass3LegacyTaskAttempted: false,
        pass3LegacyTaskSucceeded: false,
        pass3LegacyStyleAttempted: false,
        pass3LegacyStyleSucceeded: false,
        pass4LlmAttempted: false,
        pass4LlmSucceeded: false,
        styleSource: detectStyleFromText(ctx.raw) ? "explicit-regex" : "classifier-default",
        finalTaskType: "generate",
        finalConfidence: 0.9,
        complexity,
        complexityScore,
      };
      return {
        ...ctx,
        taskType: "generate",
        domain: domainPass0,
        confidence: 0.9,
        outputStyle: styleFromText,
        intentKind: "task",
        _brainData: null,
        _intentTrace: intentTrace,
        layers: [
          ...ctx.layers,
          {
            name: "intent-detection",
            applied: true,
            delta: `taskType=generate,kind=task,conf=0.90,domain=${domainPass0 ?? "none"},style=${styleFromText},pass0=test-generation`,
          },
        ],
      };
    }
    if (isPerformanceRefactor(ctx.raw)) {
      const domainPass0 = extractDomain("", ctx.raw);
      const styleFromText = detectStyleFromText(ctx.raw) ?? "balanced";
      const { complexity, score: complexityScore } = scoreComplexity({
        rawText: ctx.raw,
        taskType: "refactor",
        t0HitCount: 0,
        hasMaxSprintsOne: false,
      });
      const intentTrace: IntentDetectionTrace = {
        pass1Reason: "pass0:performance",
        pass1Confidence: 0.85,
        pass1TaskType: "refactor",
        pass1Hit: true,
        pass2Hit: false,
        pass25ChitchatHit: false,
        pass3UnifiedAttempted: false,
        pass3UnifiedSucceeded: false,
        pass3LegacyTaskAttempted: false,
        pass3LegacyTaskSucceeded: false,
        pass3LegacyStyleAttempted: false,
        pass3LegacyStyleSucceeded: false,
        pass4LlmAttempted: false,
        pass4LlmSucceeded: false,
        styleSource: detectStyleFromText(ctx.raw) ? "explicit-regex" : "classifier-default",
        finalTaskType: "refactor",
        finalConfidence: 0.85,
        complexity,
        complexityScore,
      };
      return {
        ...ctx,
        taskType: "refactor",
        domain: domainPass0,
        confidence: 0.85,
        outputStyle: styleFromText,
        intentKind: "task",
        _brainData: null,
        _intentTrace: intentTrace,
        layers: [
          ...ctx.layers,
          {
            name: "intent-detection",
            applied: true,
            delta: `taskType=refactor,kind=task,conf=0.85,domain=${domainPass0 ?? "none"},style=${styleFromText},pass0=performance`,
          },
        ],
      };
    }

    // Pass 1: local classifier.
    const result = classify(ctx.raw);
    const pass1TaskType: TaskType | null = REASON_TO_TASK_TYPE[result.reason] ?? null;
    let taskType: TaskType | null = pass1TaskType;
    let confidence = result.confidence;
    const domain = extractDomain(result.reason, ctx.raw);
    let outputStyle: OutputStyle | null = null;
    let intentKind: "task" | "chitchat" | null = null;
    let brainData: BrainData | null = null;
    // Step-by-step trace — populated as each pass runs so cost reports can
    // attribute which pass actually decided the outcome.
    let pass2Pattern: string | undefined;
    let pass2Hit = false;
    let pass25ChitchatHit = false;
    let pass3UnifiedSucceeded = false;
    let pass3LegacyTaskAttempted = false;
    let pass3LegacyTaskSucceeded = false;
    let pass3LegacyStyleAttempted = false;
    let pass3LegacyStyleSucceeded = false;
    let styleSource: IntentDetectionTrace["styleSource"] = "none";

    // Pass 2: keyword fallback. Runs when classifier abstains OR when the
    // classifier match was a low-signal "general" (regex:short-message) OR
    // when the catch-all `regex:edit` / `regex:create-file` mapped a vague
    // "fix X" / "tạo X" verb to taskType=generate at sub-threshold confidence
    // (< 0.7). The catch-all v2 rules are deliberately weak (conf 0.55) so a
    // VN debug prompt like "ci/cd đang bị lỗi, check và fix cho tôi" still
    // routes through the keyword rescue here — which carries the bare-`lỗi`
    // and `\bfix\b` debug cues that the catch-all regex cannot tell apart
    // from generic edit.
    const lowSignal = taskType === "general" && result.reason === "regex:short-message";
    const catchAllRescue =
      taskType !== null && confidence < HIGH_CONF_THRESHOLD_PASS2 && CATCHALL_REASONS.has(result.reason);
    if (taskType === null || lowSignal || catchAllRescue) {
      for (const { pattern, taskType: kwType, confidence: kwConf } of KEYWORD_PATTERNS) {
        if (pattern.test(ctx.raw)) {
          taskType = kwType;
          confidence = kwConf;
          pass2Hit = true;
          pass2Pattern = pattern.source;
          break;
        }
      }
    }

    // Pass 2.5: hot-path chitchat short-circuit for ultra-short greetings
    // ("hi", "ok", "thanks", "ty") — mapped to taskType="general" without
    // burning a brain round-trip. Both conditions required (AND) so we don't
    // accidentally swallow phrases like "refactor this" or "fix the bug" that
    // happen to be short.
    //
    // TODO(WhoAmI-Pass0): when EE v4.0 Who Am I profile is available, read
    // communication.brevity + decision_speed here as outputStyle baseline.
    const trimmed = ctx.raw.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const noTaskSignal = taskType === null || (taskType === "general" && result.reason === "regex:short-message");
    if (noTaskSignal && trimmed.length < 10 && wordCount <= 2) {
      taskType = "general";
      confidence = 0.5;
      intentKind = "chitchat";
      outputStyle = "concise";
      pass25ChitchatHit = true;
      styleSource = "chitchat-default";
    }

    // Pass 2.6 — multi-word PURE social pleasantries ("cảm ơn bạn rất nhiều
    // nhé", "thank you so much", "ok great thanks") that the 2-word hot-path
    // above misses. Without this they fall through to the brain/LLM passes,
    // which classify intentKind inconsistently (live session 40c726a31a37
    // returned intentKind=null → toolCount=37, ~15-20K wasted tool-schema
    // tokens for a thank-you). isSocialPleasantry is strict (every token is
    // greeting/thanks/ack/filler vocab) so it can never swallow a task; the
    // hasActionableToolIntent veto is belt-and-suspenders. Classifying here is
    // also a cost win: it skips the brain round-trip (needsBrain requires
    // intentKind !== "chitchat").
    if (
      intentKind !== "chitchat" &&
      (taskType === null || taskType === "general") &&
      !hasActionableToolIntent(trimmed) &&
      isSocialPleasantry(trimmed)
    ) {
      taskType = "general";
      confidence = 0.5;
      intentKind = "chitchat";
      outputStyle = "concise";
      pass25ChitchatHit = true;
      styleSource = "chitchat-default";
    }

    // Pass 3 UNIFIED: single /api/pil-context call replaces the multi-call
    // cascade (classifier rescue + style brain). Fires only when flag is on
    // AND local signal is weak (no taskType or low confidence) AND we haven't
    // already short-circuited to chitchat.
    const HIGH_CONF_THRESHOLD = 0.7;
    const needsBrain =
      isUnifiedPilEnabled() && intentKind !== "chitchat" && (taskType === null || confidence < HIGH_CONF_THRESHOLD);

    let unifiedFailed = false;
    if (needsBrain) {
      // Step 8 (ee-anti-mu): enrich the raw passed to pilContext for sessions that may have
      // experienced compaction (or any sessionId-bearing turn) so the brain sees EE checkpoints
      // + the PRESERVE_FULL_CONTEXT veto token. Unconditional for any turn with sessionId
      // (covers _compactionStats.count > 0 or step > K cases even if local conf high).
      let brainRaw = ctx.raw;
      if (ctx.sessionId) {
        brainRaw =
          ctx.raw +
          ' [EE task checkpoints ("Context checkpoint summary" with ✔ DONE) from prior compactions are available via the ee.query tool. ' +
          "To keep full tool history this turn when you see pre-warn or compaction note, emit exact literal PRESERVE_FULL_CONTEXT in reasoning or assistant note. " +
          'Self-check "task finished?" or "compacted yet this turn?" using the checkpoints.]';
      }
      const resp = await pilContext(brainRaw, {
        projectCtx: domain ? { domain } : undefined,
        budgetMs: 1500,
      });
      if (resp) {
        if (resp.taskType) taskType = resp.taskType;
        if (resp.intentKind) intentKind = resp.intentKind;
        if (resp.outputStyle) {
          outputStyle = resp.outputStyle;
          styleSource = "brain-unified";
        }
        if (resp.confidence) confidence = resp.confidence;
        brainData = {
          t0_principles: resp.t0_principles,
          t1_rules: resp.t1_rules,
          t2_patterns: resp.t2_patterns,
          retrieval_skipped_reason: resp.retrieval_skipped_reason,
        };
        pass3UnifiedSucceeded = true;
      } else {
        unifiedFailed = true;
      }
    }

    // Pass 4 LLM FALLBACK: fires when the brain's confidence is below the
    // hot-path skip threshold (HIGH_CONF_THRESHOLD = 0.7).
    //
    // Earlier iteration tried a tighter floor (0.5) to skip Pass 4 on "good
    // enough" brain answers, but session eda85985dce9 showed the brain
    // routinely returns 0.55–0.65 for ambiguous prompts like "fix CI fail"
    // — and at that confidence band the brain's answer is wrong often
    // enough that skipping Pass 4 reintroduces the classification leak we
    // shipped Pass 4 to fix. The ~1s LLM round-trip is the price of
    // correctness on borderline turns; high-confidence turns (brain ≥ 0.7)
    // bypass Pass 4 entirely so the cost only hits weak signals.
    let pass4LlmAttempted = false;
    let pass4LlmSucceeded = false;
    const llmFallbackEligible =
      !!opts.llmFallback &&
      intentKind !== "chitchat" &&
      (taskType === null || unifiedFailed || confidence < HIGH_CONF_THRESHOLD);
    if (llmFallbackEligible) {
      pass4LlmAttempted = true;
      try {
        const llmRes = await opts.llmFallback!(ctx.raw);
        if (llmRes) {
          pass4LlmSucceeded = true;
          taskType = llmRes.taskType;
          confidence = llmRes.confidence;
          // Pass 4 is reached ONLY when intentKind !== "chitchat" (see
          // llmFallbackEligible above) — every genuine social pleasantry was
          // already short-circuited upstream by Pass 0 (continuation /
          // status-check), Pass 2.5 (ultra-short greeting) and Pass 2.6
          // (isSocialPleasantry). So a taskType="general" result HERE is a
          // SUBSTANTIVE question that slipped past the greeting detectors —
          // NOT chitchat. Live repro (session b51ba653e890): "bạn đang được
          // chạy bên trong CLI này thì ... CLI tác động thế nào đến bạn?" was
          // mapped general→chitchat, which nuked the entire action toolset
          // (message-processor.ts:1285 `isChitchat && !_priorTurnHadTools →
          // {}`). The model announced "Tôi cần điều tra code ... không đoán"
          // (Evidence-First contract) but had only respond_general — no
          // read_file/grep/bash to act with → narration → respond_general
          // spam-abort, zero answer. A general question is tool-capable:
          // classify it "task" so the toolset survives. Per the established
          // keep-tools precedent in this file (TOOL_NAME_RE veto), a false
          // "task" merely re-adds ~1.5K tokens of tool schema, while a false
          // "chitchat" BREAKS the turn.
          intentKind = "task";
          if (llmRes.outputStyle) {
            outputStyle = llmRes.outputStyle;
            styleSource = "brain-unified"; // closest existing source — LLM acts in same role
          }
        }
      } catch (err) {
        console.error(`[pil.layer1] LLM fallback failed: ${(err as Error)?.message}`);
      }
    }

    // Pass 3 LEGACY FALLBACK: only runs when flag off.
    // Cost optimization: when unified call FAILED, we skip the legacy brain
    // round-trips entirely. The unified pilContext already tried the same
    // backend; a second classifyViaBrain ~1.5s after a failure almost always
    // fails too, wasting tokens and ~2.3s of wall time. The cheap regex style
    // detector still runs below to recover explicit "ngắn gọn"/"detailed" cues.
    const runLegacyBrain = !isUnifiedPilEnabled();
    let legacyBrainAttempted = false;
    if (runLegacyBrain) {
      if (taskType === null) {
        legacyBrainAttempted = true;
        pass3LegacyTaskAttempted = true;
        // 4P-2: neutral bridge-classifier prompt. Earlier wording biased the
        // LLM toward `refactor` for any code touch (baseline trace
        // taskType=refactor,conf=0.75 on a clear feature-add). The rewrite:
        //   - Lists categories in neutral order (analyze first, refactor 4th).
        //   - Restricts refactor to explicit restructure verbs.
        //   - Tells the model to prefer 'general' over guessing when ambiguous.
        //   - Clarifies that feature additions are 'generate' even when they
        //     touch existing files.
        // 0.7 confidence threshold for Pass 2 keyword override remains
        // unchanged (HIGH_CONF_THRESHOLD_PASS2 above).
        const brainRaw = await classifyViaBrain(
          `You are a multilingual prompt classifier. The user's prompt may be in English, Vietnamese, or a mix of both.
Classify the prompt's INTENT (not its language). Reply with TWO lowercase words separated by a comma: <category>,<style>

Category — pick ONE (listed in neutral order, no precedence):
  analyze       — explain / inspect / review existing code (giải thích, phân tích, review)
  debug         — fix a bug or investigate failure (sửa lỗi, fix bug, lỗi, traceback)
  generate      — create new code/file or add new behavior (tạo, sinh code, viết function mới, thêm)
  refactor      — restructure existing code (tái cấu trúc, refactor)
  plan          — design / roadmap / architecture (kế hoạch, thiết kế, kiến trúc)
  documentation — write docs/comments (viết docs, comment, jsdoc)
  general       — chitchat OR unclear / ambiguous coding intent

Rules (Phase 4 4P-2 disambiguation):
- Only return refactor when the user EXPLICITLY uses one of: rename, restructure, reorganize, extract, inline, move, migrate, reshape — applied to EXISTING code WITHOUT adding new behavior.
- Feature additions ('add flag', 'thêm', 'create endpoint', 'thêm option'), changing a DEFAULT value, adding tests, or improving coverage are 'generate' — NOT refactor.
- 'improve', 'change', 'update', 'modify', 'đổi', 'cải thiện' alone do NOT imply refactor — pick the specific category by what the change actually does.
- When the request is ambiguous, prefer 'general' over guessing refactor.

Negative examples (NOT refactor):
- "đổi default --max-tool-rounds 8 sang 12" → generate
- "improve test coverage" → generate
- "tại sao X trả empty" → analyze
- "fix CI failing" → debug

Style — pick ONE:
  concise (ngắn gọn) | balanced (cân bằng) | detailed (chi tiết)

Examples:
  "Refactor this function" → refactor,balanced
  "tại sao test fail" → debug,balanced
  "thiết kế hệ thống auth" → plan,detailed
  "thêm flag --foo" → generate,concise
  "hi" → general,concise

Prompt: "${ctx.raw.slice(0, 500)}"`,
          1500,
        );
        if (brainRaw) {
          pass3LegacyTaskSucceeded = true;
          const lower = brainRaw.toLowerCase();
          // 4P-2: match `general` BEFORE the coding-category list so an
          // ambiguous prompt the model marked `general,*` doesn't accidentally
          // fall through to a substring hit later. `none` kept as legacy alias.
          if (/\bgeneral\b/.test(lower) || /\bnone\b/.test(lower)) {
            taskType = "general";
            confidence = 0.6;
            intentKind = "chitchat";
            if (outputStyle === null) {
              outputStyle = "concise";
              styleSource = "chitchat-default";
            }
          } else {
            const matched = VALID_TASK_TYPES.find((t) => lower.includes(t));
            if (matched) {
              taskType = matched;
              confidence = 0.55;
              intentKind = "task";
            }
          }
          const styleMatched = VALID_STYLES.find((s) => lower.includes(s));
          if (styleMatched) {
            outputStyle = styleMatched;
            styleSource = "brain-legacy";
          }
        }
      }

      // Pass 3.5: regex style detection — free, always runs before any brain call.
      // Catches explicit user cues ("ngắn gọn", "chi tiết", "step by step").
      if (outputStyle === null) {
        const regexStyle = detectStyleFromText(ctx.raw);
        if (regexStyle) {
          outputStyle = regexStyle;
          styleSource = "explicit-regex";
        }
      }

      // Pass 3b: style brain call — only when task detection ITSELF needed the
      // brain (pass3LegacyTaskAttempted). When pass1 or pass2 already decided
      // the task cheaply, the 800ms style call adds no signal (confirmed by
      // 112/112 wasted calls in production — 100% returned styleSource=none).
      // Default to "balanced" instead: clear, cheap, and accurate for most
      // coding turns.
      if (outputStyle === null && taskType !== null) {
        if (pass3LegacyTaskAttempted) {
          legacyBrainAttempted = true;
          pass3LegacyStyleAttempted = true;
          const brainRawStyle = await classifyViaBrain(
            `Detect the user's preferred output style. The prompt may be EN or VN.
Reply with ONE word: concise (ngắn gọn) | balanced (bình thường) | detailed (chi tiết).

Prompt: "${ctx.raw.slice(0, 300)}"`,
            800,
          );
          if (brainRawStyle) {
            pass3LegacyStyleSucceeded = true;
            const styleMatched = VALID_STYLES.find((s) => brainRawStyle.toLowerCase().includes(s));
            if (styleMatched) {
              outputStyle = styleMatched;
              styleSource = "brain-legacy";
            }
          }
        } else {
          outputStyle = "balanced";
          styleSource = "classifier-default";
        }
      }
    } else if (unifiedFailed && outputStyle === null) {
      // Cheap rescue path when unified PIL is enabled but its call failed:
      // run only the free regex style detector. The L6 brain-rescue call is
      // suppressed below by the `_brainData` sentinel so we don't repeat the
      // same network round-trip that just timed out.
      const regexStyle = detectStyleFromText(ctx.raw);
      if (regexStyle) {
        outputStyle = regexStyle;
        styleSource = "explicit-regex";
      }
    }

    if (intentKind === null && taskType !== null && taskType !== "general") {
      intentKind = "task";
    }

    // Safety net (harness 817e508f57ee): an explicit command/tool-execution
    // request must NEVER be chitchat. Chitchat drops the whole toolset (incl.
    // bash) in message-processor, so a "run this command" turn would leave the
    // agent unable to act. Only ever UPGRADES chitchat → task (never the
    // reverse), so the token-saving for genuine greetings is preserved.
    if (intentKind === "chitchat" && hasActionableToolIntent(ctx.raw)) {
      intentKind = "task";
    }

    // L6 brain-rescue suppression sentinel. L6 only checks truthiness of
    // _brainData to decide whether to spend another 50ms brain round-trip on
    // style detection. If we either (a) succeeded with unified pilContext,
    // (b) failed unified (network already down), or (c) attempted a legacy
    // brain call here, then L6 has nothing new to learn — set a sentinel.
    const brainDataOut: BrainData | null =
      brainData ??
      (unifiedFailed || legacyBrainAttempted
        ? {
            t0_principles: [],
            t1_rules: [],
            t2_patterns: [],
            retrieval_skipped_reason: unifiedFailed ? "unified-failed" : "legacy-attempted",
          }
        : null);

    // pass1Hit = Pass 1 alone decided the final outcome (no later pass overrode).
    // Note: chitchat short-circuit overrides Pass 1, so we exclude that case.
    const pass1Hit =
      pass1TaskType !== null &&
      taskType === pass1TaskType &&
      !pass2Hit &&
      !pass25ChitchatHit &&
      !pass3UnifiedSucceeded &&
      !pass3LegacyTaskSucceeded;

    const { complexity, score: complexityScore } = scoreComplexity({
      rawText: ctx.raw,
      taskType,
      t0HitCount: 0, // TODO P2: feed from prior-run state.md if available
      hasMaxSprintsOne: false, // TODO P2: thread CLI flag down through ctx
    });

    const intentTrace: IntentDetectionTrace = {
      pass1Reason: result.reason,
      pass1Confidence: result.confidence,
      pass1TaskType,
      pass1Hit,
      pass2Hit,
      pass2Pattern,
      pass25ChitchatHit,
      pass3UnifiedAttempted: needsBrain,
      pass3UnifiedSucceeded,
      pass3LegacyTaskAttempted,
      pass3LegacyTaskSucceeded,
      pass3LegacyStyleAttempted,
      pass3LegacyStyleSucceeded,
      pass4LlmAttempted,
      pass4LlmSucceeded,
      styleSource,
      finalTaskType: taskType,
      finalConfidence: confidence,
      complexity,
      complexityScore,
    };

    return {
      ...ctx,
      taskType,
      domain,
      confidence,
      outputStyle,
      intentKind,
      _brainData: brainDataOut,
      _intentTrace: intentTrace,
      layers: [
        ...ctx.layers,
        {
          name: "intent-detection",
          applied: taskType !== null,
          delta:
            taskType !== null
              ? `taskType=${taskType},kind=${intentKind ?? "unknown"},conf=${confidence.toFixed(2)},domain=${domain ?? "none"},style=${outputStyle ?? "none"},unified=${brainData ? "ok" : unifiedFailed ? "fail" : "skip"},llm=${pass4LlmSucceeded ? "ok" : pass4LlmAttempted ? "fail" : "skip"}`
              : unifiedFailed
                ? `taskType=null,unified=fail,llm=${pass4LlmSucceeded ? "ok" : pass4LlmAttempted ? "fail" : "skip"}`
                : null,
        },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "intent-detection", applied: false, delta: null }],
    };
  }
}

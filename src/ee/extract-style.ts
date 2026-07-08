// src/ee/extract-style.ts
//
// Personality / working-style extraction — the WRITE arm that CLOSES the who-am-i loop.
//
// The READ arm (who-am-i-brain.ts) derives a WhoAmIProfile from the `experience-behavioral`
// brain: it searches the user's accumulated style rules and classifies them into dims that
// the PIL layers read. But on a thin-client NOTHING was feeding that collection with style
// signals mined from the user's OWN muonroi-cli sessions — the general server extract
// (`extractFromSession`) only mines TECHNICAL mistakes/lessons (detectExperience → extractQA),
// never "the user prefers concise answers / rejects hand-holding / decides fast". So the loop
// was open: who-am-i could only read rules the user hand-authored or the Claude Code Stop hook
// happened to capture.
//
// This module runs at session-end (alongside extractSession) and mines the transcript for the
// USER's working-style, writing each high-confidence signal as a natural-language behavioral
// rule into `experience-behavioral` via writeExperienceEE. Next session, who-am-i-brain reads
// those rules back and classifies them into dims → the loop is closed.
//
// Design guarantees:
//   • Agent-first (no keyword regex): the transcript→style mapping is decided by the brain LLM
//     (classifyViaBrain), honouring the repo rule that classification is never regex. The only
//     regex here is tolerant JSON extraction from the LLM reply.
//   • Natural-language interface (NOT a shared enum): the WRITE side emits plain style
//     sentences; the READ side (who-am-i-brain) re-classifies them with its own DIM_VOCAB.
//     Neither side imports the other's vocabulary — so there is no cross-module enum coupling
//     to drift (contrast the EE-side DIM_VOCAB lockstep this deliberately avoids).
//   • Anti-pollution: experience-behavioral also drives passive hint injection, so a wrong or
//     low-confidence guess is actively harmful (it feeds who-am-i AND every passive hint). We
//     gate HARD — high confidence floor, length bounds, a small per-session cap, and a stable
//     per-signal title so repeated sessions MERGE instead of accreting near-duplicates.
//   • Fail-open: any gap (classifier null, unparseable output, dep throws, EE down) writes
//     nothing and never throws. Style converges over many sessions; missing one is harmless.

import type { WriteExperienceResult } from "./search.js";

/** The collection who-am-i-brain reads back — keep in lockstep with BEHAVIORAL_COLLECTION there. */
const BEHAVIORAL_COLLECTION = "experience-behavioral";

/**
 * Only signals at/above this confidence are written. High on purpose: a style rule that lands
 * in experience-behavioral influences who-am-i AND passive hints, so a confident-but-wrong
 * guess is worse than silence. The brain self-reports confidence per the prompt contract.
 */
const STYLE_WRITE_MIN_CONFIDENCE = 0.7;
/** At most this many style rules per session — style is slow-moving; a burst is almost always noise. */
const MAX_STYLE_RULES_PER_SESSION = 3;
/** A style rule shorter than this is too vague to guide anything; longer than this is task prose leaking in. */
const MIN_RULE_CHARS = 15;
const MAX_RULE_CHARS = 240;

/**
 * Off the hot path (fire-and-forget at session-end), so a wide budget. The server's strong
 * brainExtractModel is a reasoning model (deepseek-v4-flash) whose think+emit cycle runs
 * ~4-10s on this transcript-sized prompt (verified live). 20s clears the tail; it never blocks
 * anything (background). Mirrors who-am-i-brain's budget.
 */
const STYLE_CLASSIFY_TIMEOUT_MS = 20000;
/**
 * The rules JSON itself is tiny (~150 tokens), but the server's extract model
 * (deepseek-v4-flash) is a REASONING model — its thinking tokens count against this same
 * budget and land in a separate reasoning_content field, NOT the JSON. A tight cap (500) let
 * the reasoning consume the whole budget and truncate the actual JSON to empty → intermittent
 * zero-rule results (verified live: identical input gave 3 rules then 0). Give thinking ample
 * headroom so the JSON always survives; the extra tokens are only spent when the model
 * actually reasons, and this is an off-hot-path background call.
 */
const STYLE_CLASSIFY_MAX_TOKENS = 3000;

/**
 * System-prompt override — REQUIRED, same reason as who-am-i-brain: the EE brain proxy's
 * default system prompt is a tier-classifier ("output ONE word … ignore content") that
 * hijacks structured output into garbage. Verified on the live VPS (2026-07-05).
 */
const STYLE_SYSTEM_PROMPT =
  "You mine a developer's WORKING STYLE from a session transcript — how they prefer to " +
  "communicate, decide, delegate, receive feedback, and handle risk. Follow the user " +
  "message instructions EXACTLY and output ONLY the requested JSON object. Do not classify " +
  "task complexity, do not output single words, do not add prose before or after the JSON.";

/** Feature flag — default ON, opt out with MUONROI_STYLE_EXTRACT=0. */
export function isStyleExtractEnabled(): boolean {
  return process.env.MUONROI_STYLE_EXTRACT !== "0";
}

/**
 * PURE: build the style-mining prompt. Asks the brain to emit 0..N natural-language style
 * rules about the USER (never the task), each standalone and reusable as future guidance,
 * with a self-reported confidence. Emitting NOTHING when the transcript shows no clear style
 * is explicitly the right answer — we would rather miss a session than pollute the brain.
 */
export function buildStyleExtractPrompt(transcript: string): string {
  return [
    "From the session transcript below, extract DURABLE signals about the DEVELOPER's working",
    "style — not the task, not the code. Look for how they prefer to communicate (concise vs",
    "detailed), decide (fast/intuitive vs deliberate), delegate (autonomous vs collaborative),",
    "receive feedback (blunt correction vs gentle), and tolerate risk.",
    "",
    "Output ONLY a JSON object of the form:",
    '{"rules": [{"rule": "<one imperative sentence of durable style guidance>", "confidence": 0.0-1.0}]}',
    "",
    "Rules:",
    '- Each `rule` must be a standalone, reusable instruction (e.g. "The user prefers concise',
    '  answers — skip preamble and lead with the recommendation."). NOT a fact about this task.',
    "- Emit a signal ONLY when the transcript gives clear, repeated evidence. When in doubt, omit it.",
    "- An EMPTY array is the correct answer for a task-only session with no style signal.",
    "- Never invent a preference the transcript does not actually demonstrate.",
    "- confidence reflects how strongly the transcript supports the rule.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export interface StyleRule {
  rule: string;
  confidence: number;
}

/**
 * PURE: coerce a brain reply (JSON string, fenced block, or already-parsed object) into a
 * gated list of style rules. Applies the confidence floor, length bounds, dedup by normalized
 * text, and the per-session cap. Returns [] when nothing usable survives (fail-open).
 */
export function parseStyleRules(raw: unknown): StyleRule[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const json = extractJsonObject(raw);
    if (!json) return [];
    try {
      obj = JSON.parse(json);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const arr = (obj as { rules?: unknown }).rules;
  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  const out: StyleRule[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rule = typeof (item as { rule?: unknown }).rule === "string" ? (item as { rule: string }).rule.trim() : "";
    const confidence = Number((item as { confidence?: unknown }).confidence);
    if (!rule || !Number.isFinite(confidence)) continue;
    if (confidence < STYLE_WRITE_MIN_CONFIDENCE) continue;
    if (rule.length < MIN_RULE_CHARS || rule.length > MAX_RULE_CHARS) continue;
    const norm = rule.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ rule, confidence });
    if (out.length >= MAX_STYLE_RULES_PER_SESSION) break;
  }
  return out;
}

/** Tolerantly extract the first balanced JSON object from an LLM reply. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * PURE: a stable title for a style rule so repeated sessions MERGE server-side instead of
 * accreting near-duplicates. Derived deterministically from the rule text (lowercased, first
 * few significant words) — same recurring preference → same title → storeImportedExperience
 * can collapse them. Marked with a "user-style:" prefix so the entries are identifiable and
 * prunable as a class.
 */
export function styleRuleTitle(rule: string): string {
  const words = rule
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 5)
    .join("-");
  return `user-style:${words || "general"}`;
}

const STOPWORDS = new Set([
  "the",
  "user",
  "prefers",
  "wants",
  "with",
  "that",
  "this",
  "they",
  "them",
  "their",
  "when",
  "into",
  "over",
  "from",
  "answers",
  "answer",
  "reply",
  "replies",
]);

export interface StyleExtractDeps {
  classifyViaBrain: (
    prompt: string,
    timeoutMs?: number,
    options?: {
      systemPrompt?: string;
      responseFormat?: { type: string };
      maxTokens?: number;
      useExtractModel?: boolean;
    },
  ) => Promise<string | null>;
  writeExperience: (
    lesson: string,
    opts: { collection?: string; title?: string; projectSlug?: string; confidence?: number },
  ) => Promise<WriteExperienceResult>;
}

/**
 * Classify the transcript into gated style rules. Fail-open []: a degraded brain must never
 * break session teardown.
 */
export async function extractStyleSignals(deps: StyleExtractDeps, transcript: string): Promise<StyleRule[]> {
  try {
    if (!transcript || transcript.trim().length < 100) return [];
    const reply = await deps.classifyViaBrain(buildStyleExtractPrompt(transcript), STYLE_CLASSIFY_TIMEOUT_MS, {
      systemPrompt: STYLE_SYSTEM_PROMPT,
      responseFormat: { type: "json_object" },
      maxTokens: STYLE_CLASSIFY_MAX_TOKENS,
      // Structured multi-signal extraction needs the server's stronger brainExtractModel;
      // the hot-path model is too weak (verified on the live VPS for the READ side too).
      useExtractModel: true,
    });
    if (!reply) return [];
    return parseStyleRules(reply);
  } catch {
    return [];
  }
}

/**
 * End-to-end WRITE arm: mine style rules from the transcript and persist each to
 * experience-behavioral. Returns the number written. Fire-and-forget from extractSession —
 * fail-open, never throws. `projectSlug` scopes the rule; confidence carries through so the
 * brain can weight it.
 */
export async function writeStyleSignals(
  deps: StyleExtractDeps,
  transcript: string,
  opts: { projectSlug?: string } = {},
): Promise<number> {
  if (!isStyleExtractEnabled()) return 0;
  const rules = await extractStyleSignals(deps, transcript);
  let written = 0;
  for (const r of rules) {
    try {
      const res = await deps.writeExperience(r.rule, {
        collection: BEHAVIORAL_COLLECTION,
        title: styleRuleTitle(r.rule),
        projectSlug: opts.projectSlug,
        confidence: r.confidence,
      });
      if (res.ok) written++;
    } catch {
      // fail-open per rule — one bad write must not abort the rest
    }
  }
  return written;
}

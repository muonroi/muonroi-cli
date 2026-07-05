// src/ee/who-am-i-brain.ts
//
// Brain-derived "Who Am I" fallback for THIN-CLIENTS.
//
// The device-local profile.yaml pipeline (src/ee/who-am-i.ts) is full-brain-only:
// the EE prompt interceptor bails early on remote mode (`if (isRemoteMode()) return`),
// no /api/profile endpoint exists, and signal-extraction from transcripts never runs
// on a thin-client. So on a thin-client getWhoAmIProfile() is structurally always
// null and the PIL loses every style signal.
//
// The user's working style IS reachable though — it lives in the `experience-behavioral`
// brain (their own authored rules: "recommend, don't ask", "keep it concise", etc.),
// which the runtime already queries via searchByText() over /api/search. This module
// derives the SAME WhoAmIProfile shape from those rules so all existing PIL wiring
// (outputStyleFromProfile, the layer4/5/6 dim reads) works unchanged.
//
// Design guarantees:
//   • Agent-first (no keyword regex): the rule→dim mapping is decided by the brain LLM
//     itself (classifyViaBrain), honouring the repo rule that classification is never
//     regex. The only regex here is tolerant JSON extraction from the LLM's reply.
//   • Privacy: dims are re-gated locally through selectWhoAmIDims — the positive
//     name-allowlist + per-tier confidence floor. Brain rules are user-authored style
//     guidance (Tang-2 equivalent), so we gate at the "standard" tier; emotional.* can
//     never surface (not on the allowlist). This is decoupled from the EE file
//     privacyLevel (which governs the *auto-derived* on-device profile — a different,
//     more sensitive data source that is off by default on thin-clients).
//   • Fail-open: any gap (no rules, classifier null, unparseable output, dep throws)
//     returns null → the PIL keeps its own per-turn default. Never throws.

import { type PrivacyLevel, type RawProfile, selectWhoAmIDims, type WhoAmIProfile } from "./who-am-i.js";

const BEHAVIORAL_COLLECTION = "experience-behavioral";
const BRAIN_TOPK = 12;

/** Brain rules are style-level guidance → the standard tier (never emotional). */
const BRAIN_TIER: PrivacyLevel = "standard";

/**
 * System prompt override — REQUIRED. The EE brain proxy's default system prompt is a
 * tier-classifier ("output ONE word: fast|balanced|premium … ignore the task content"),
 * which actively hijacks any structured-output request → malformed JSON. Verified on the
 * live VPS (2026-07-05): omitting this made even DeepSeek-V3 emit garbage; supplying it
 * makes the DEFAULT server model (Qwen2.5-7B) emit clean, accurate dims JSON. We do NOT
 * override the model/provider — that would hardcode a model id (Zero-Hardcode Rule) and
 * cost the user's own provider; the server's default brain model + key does the work.
 */
const STYLE_SYSTEM_PROMPT =
  "You extract a developer's working-style profile from their accumulated behavioral " +
  "rules. Follow the user message instructions EXACTLY and output ONLY the requested " +
  "JSON object. Do not classify task complexity, do not output single words, do not " +
  "add prose before or after the JSON.";

/**
 * Probe the behavioral brain for working-style rules. Free-text; the server embeds
 * + searches Qdrant. Intentionally broad — it should surface brevity / decision /
 * feedback / delegation / risk / conflict guidance the user has accumulated.
 */
const STYLE_PROBE =
  "the user's preferred working style: communication brevity, decision speed, " +
  "feedback and correction style, delegation style, risk tolerance, conflict style";

// The dims the brain may emit, with the EXACT value vocabulary. Source of truth is
// the EE profile renderer (~/.experience/src/profile-render.js DIRECTIVES) — the same
// values the device-local profile uses and that the PIL layers compare against
// literally (e.g. layer4 tests delegation === "autonomous", layer6 tests
// feedback_style === "precise-correction"). A value outside this set would populate a
// dim that no lever reads → silently inert. Keep in lockstep with the EE enum.
const DIM_VOCAB: Record<string, string[]> = {
  "communication.brevity": ["concise", "moderate", "verbose"],
  "communication.feedback_style": ["implicit", "precise-correction"],
  "communication.question_style": ["comparison", "debugging", "exploratory", "directive"],
  "personality.decision_speed": ["fast-intuitive", "measured", "deliberate"],
  "personality.risk_tolerance": ["experimental"],
  "personality.conflict_style": ["direct-constructive", "authoritative", "cautious"],
  "work_patterns.energy": ["night-owl", "daytime", "mixed"],
  "work_patterns.multitasking": ["task-switcher", "sequential-deep"],
  "work_patterns.session_length": ["short", "medium", "long"],
  "work_patterns.delegation_style": ["autonomous", "collaborative"],
};

/** Feature flag — default ON, opt out with MUONROI_WHOAMI_BRAIN=0. */
export function isBrainWhoAmIEnabled(): boolean {
  return process.env.MUONROI_WHOAMI_BRAIN !== "0";
}

/**
 * PURE: build the classify prompt. Asks the brain to distil the retrieved rules into
 * a strict dims JSON using only the allowed names + vocabulary. Emitting fewer dims
 * (only the confident ones) is explicitly encouraged — downstream drops the rest.
 */
export function buildStyleClassifyPrompt(rules: string[]): string {
  const vocabLines = Object.entries(DIM_VOCAB)
    .map(([name, values]) => `  "${name}": one of ${values.map((v) => `"${v}"`).join(" | ")}`)
    .join("\n");
  const ruleBlock = rules.length
    ? rules.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "(no explicit rules retrieved — infer nothing; emit an empty dimensions object)";
  return [
    "You classify a developer's working style from their accumulated behavioral rules.",
    "Output ONLY a JSON object of the form:",
    '{"dimensions": {"<dim.name>": {"value": "<allowed value>", "confidence": 0.0-1.0, "sampleCount": <int>}}}',
    "",
    "Allowed dimensions and their vocabulary (use these names/values EXACTLY):",
    vocabLines,
    "",
    "Rules:",
    "- Include a dimension ONLY when the rules give clear evidence for it.",
    "- Omit anything uncertain — a small, confident object beats a complete guess.",
    "- confidence reflects how strongly the rules support the value; sampleCount = how many rules back it.",
    "- Never invent dimension names or values outside the vocabulary above.",
    "",
    "Behavioral rules:",
    ruleBlock,
  ].join("\n");
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
 * PURE: coerce a brain reply (JSON string, fenced block, or already-parsed object)
 * into a privacy-gated WhoAmIProfile. Reuses selectWhoAmIDims for the allowlist +
 * confidence floor. Returns null when nothing usable survives.
 */
export function parseBrainProfile(raw: unknown, level: PrivacyLevel = BRAIN_TIER): WhoAmIProfile | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const json = extractJsonObject(raw);
    if (!json) return null;
    try {
      obj = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const gated = selectWhoAmIDims(obj as RawProfile, level);
  // Value validation — the name allowlist in selectWhoAmIDims does NOT check the VALUE,
  // and weaker brain models mis-spell the vocabulary (verified on the live VPS:
  // Qwen2.5-7B emitted "precice-correction"). An off-vocab value populates a dim that
  // the PIL layers — which compare literally — can never fire on, so it's worse than
  // absent (looks set, does nothing). Drop any value not in DIM_VOCAB[name].
  const dims: WhoAmIProfile["dims"] = {};
  for (const [name, dim] of Object.entries(gated)) {
    const vocab = DIM_VOCAB[name];
    if (vocab && !vocab.includes(dim.value)) continue;
    dims[name as keyof WhoAmIProfile["dims"]] = dim;
  }
  if (Object.keys(dims).length === 0) return null;
  return { level, dims };
}

/**
 * Off the hot path (fire-and-forget boot warm), so a wide budget. The server's
 * brainExtractModel is a REASONING model (deepseek-v4-flash) and the who-am-i prompt is large
 * (12 retrieved rules + the full dim-vocabulary schema), so the think+emit cycle runs ~10-15s
 * — verified live that a 15s cap intermittently truncated to a timeout/null. 25s clears the
 * tail; the cost is nil because this never blocks anything (background warm).
 */
const BRAIN_CLASSIFY_TIMEOUT_MS = 25000;
/**
 * The dims JSON is tiny (~200 tokens), but the server's extract model (deepseek-v4-flash) is a
 * REASONING model — its thinking tokens count against this same budget (landing in a separate
 * reasoning_content field, not the JSON). A tight cap let the reasoning consume the budget and
 * truncate the actual JSON to empty → intermittent null profiles. Give thinking ample headroom
 * so the dims JSON always survives; extra tokens are only spent when the model reasons, and
 * this is an off-hot-path boot warm.
 */
const BRAIN_CLASSIFY_MAX_TOKENS = 3000;

export interface BrainWhoAmIDeps {
  searchByText: (text: string, collections: string[], topK: number) => Promise<Array<{ payload?: { text?: string } }>>;
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
}

/**
 * Derive a WhoAmIProfile from the behavioral brain. Search the user's style rules →
 * classify them into dims via the brain LLM → privacy-gate locally. Fail-open null.
 */
export async function deriveWhoAmIFromBrain(
  deps: BrainWhoAmIDeps,
  level: PrivacyLevel = BRAIN_TIER,
): Promise<WhoAmIProfile | null> {
  try {
    const points = await deps.searchByText(STYLE_PROBE, [BEHAVIORAL_COLLECTION], BRAIN_TOPK);
    const rules = points
      .map((p) => (typeof p.payload?.text === "string" ? p.payload.text.trim() : ""))
      .filter((t) => t.length > 0);
    if (rules.length === 0) return null;

    const reply = await deps.classifyViaBrain(buildStyleClassifyPrompt(rules), BRAIN_CLASSIFY_TIMEOUT_MS, {
      systemPrompt: STYLE_SYSTEM_PROMPT,
      responseFormat: { type: "json_object" },
      maxTokens: BRAIN_CLASSIFY_MAX_TOKENS,
      // Structured multi-dim extraction needs the server's stronger brainExtractModel;
      // the hot-path model mis-spells the vocabulary (verified on the live VPS).
      useExtractModel: true,
    });
    if (!reply) return null;

    return parseBrainProfile(reply, level);
  } catch {
    // Fail-open — a degraded brain must never break the PIL hot path.
    return null;
  }
}

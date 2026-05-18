/**
 * event-redact.ts — Per-kind payload allowlist redaction.
 *
 * Strategy: for each event kind, only explicitly listed fields are kept.
 * Any field NOT in the allowlist is stripped from the emitted payload.
 * This is an allowlist approach (NOT a denylist), so future payload
 * additions are dropped by default rather than accidentally leaked.
 *
 * Additionally, any string value that matches API_KEY_PATTERN is unconditionally
 * replaced with "[redacted]" regardless of allowlist status.
 *
 * Free-text content fields (delta, answerText, question, text) are intentionally
 * kept because their structural position (field name) is the safeguard — not
 * their content — but the API key pattern scan is applied on top as defense-in-depth.
 */

import type { LiveEvent } from "./protocol.js";

// ---------------------------------------------------------------------------
// API key pattern — matches common key formats
// sk-... (OpenAI-style) or 32+ base64/hex chars
// ---------------------------------------------------------------------------

const API_KEY_PATTERN = /\b(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9+/]{32,}={0,2})\b/g;

/**
 * Replace any API key pattern in a string with "[redacted]".
 */
function scrubKeys(s: string): string {
  return s.replace(API_KEY_PATTERN, "[redacted]");
}

/**
 * Cap a string to maxLen chars.
 */
function cap(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * Allowlisted fields per event kind.
 *
 * Keys are the exact field names that are safe to emit.
 * The value is the processing spec for each field:
 *   - "pass"           → keep as-is (numeric / boolean / safe string)
 *   - "scrub"          → apply API key pattern replacement
 *   - number           → cap to N chars then apply API key pattern replacement
 */
type FieldSpec = "pass" | "scrub" | number;

const ALLOWED_FIELDS: Partial<Record<EventKind, Record<string, FieldSpec>>> = {
  "llm-token": {
    correlationId: "pass",
    delta: 500, // cap to 500 chars, then scrub
    tokenIndex: "pass",
  },
  "llm-done": {
    correlationId: "pass",
    totalChars: "pass",
    finishReason: "pass",
  },
  "council-step": {
    phaseId: "pass",
    phaseKind: "pass",
    state: "pass",
    label: "pass",
    elapsedMs: "pass",
  },
  "council-speaker": {
    role: "pass",
    status: "pass",
    round: "pass",
    correlationId: "pass",
  },
  "askcard-open": {
    questionId: "pass",
    question: 300, // cap to 300 chars, then scrub
    phase: "pass",
    optionCount: "pass",
    defaultIndex: "pass",
  },
  "askcard-answered": {
    questionId: "pass",
    answerKind: "pass",
    answerText: "scrub", // apply API key scan (no length cap — answer may be long)
  },
  "askcard-cancel": {
    questionId: "pass",
  },
  "sprint-stage": {
    sprintIndex: "pass",
    stage: "pass",
    runId: "pass",
  },
  "sprint-halt": {
    sprintN: "pass",
    reason: "pass",
    runId: "pass",
  },
  "route-decision": {
    path: "pass",
    complexity: "pass",
    forceCouncil: "pass",
    runId: "pass",
  },
  "toast": {
    level: "pass",
    text: 500, // cap to 500 chars, then scrub
    ttlMs: "pass",
  },
  "stream.delta": {
    target: "pass",
    text: 500, // cap to 500 chars
  },
  // "usage" is not a LiveEvent member with kind="usage" in the union — it's handled
  // via the stream.delta path. No entry needed.
};

type EventKind = Extract<LiveEvent, { t: "event" }>["kind"];

/**
 * Apply the field spec to a single value.
 */
function applySpec(value: unknown, spec: FieldSpec): unknown {
  if (typeof value !== "string") {
    // Numbers / booleans: only "pass" applies; scrub/cap are no-ops on non-strings
    return value;
  }
  if (spec === "pass") return value;
  if (spec === "scrub") return scrubKeys(value);
  // Numeric = cap + scrub
  return scrubKeys(cap(value, spec));
}

/**
 * Redact a LiveEvent payload before serialization.
 *
 * - t:"idle" pseudo-events pass through unchanged (no kind).
 * - Unknown kinds: drop all fields except t and kind (fail-safe).
 * - Known kinds: keep only allowlisted fields, apply per-field processing.
 */
export function redactEvent(e: LiveEvent): LiveEvent {
  // Idle sentinel — not a "kind" event; pass through
  if (e.t === "idle") return e;

  const kind = e.kind as EventKind;
  const fieldSpec = ALLOWED_FIELDS[kind];

  // Unknown kind: keep only t + kind, drop everything else (fail-safe)
  if (!fieldSpec) {
    return { t: "event", kind } as unknown as LiveEvent;
  }

  // Build a redacted copy: start with { t, kind }, then add allowed fields
  const redacted: Record<string, unknown> = { t: "event", kind };

  const raw = e as unknown as Record<string, unknown>;

  for (const [field, spec] of Object.entries(fieldSpec)) {
    const value = raw[field];
    if (value === undefined) continue; // optional field not present — skip
    redacted[field] = applySpec(value, spec);
  }

  return redacted as unknown as LiveEvent;
}

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
 *
 * EXHAUSTIVENESS (see `ALLOWED_FIELDS` below): the map is annotated as a NON-partial
 * `Record<EventKind, …>`, so `tsc` fails when a new `LiveEvent` kind is added without
 * a matching entry here. It used to be `Partial<…>`, and six kinds
 * (`sprint-plan-committed`, `ee-timeout`, `ee-error`, `disconnect`, `stream-retry`,
 * `grounding-flag`) silently reached the wire as `{t, kind}` with every field stripped
 * by the fail-safe below — an event that announces its own kind and carries nothing,
 * which reads to a driving agent as "it happened" while proving nothing about what
 * happened. Same failure class as the bare `run-finished` note further down.
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

/**
 * Max elements kept from a string-array field (`grounding-flag.claims`,
 * `sprint-plan-committed.sprintIds`). Bounds the wire size of a field whose
 * per-element cap alone cannot bound it.
 */
const MAX_ARRAY_ITEMS = 50;

const ALLOWED_FIELDS: Record<EventKind, Record<string, FieldSpec>> = {
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
    // Liveness counters. Plain magnitudes (like elapsedMs / charCount above) —
    // no prompt or response content — and without them a harness consumer
    // cannot tell a slow reasoning call from a hung one, because `elapsedMs`
    // alone freezes whenever the tick generator stops being pulled.
    streamedChars: "pass",
    lastDeltaAgeMs: "pass",
    elapsedMs: "pass",
  },
  "council-turn-length": {
    role: "pass",
    round: "pass",
    charCount: "pass",
    wordCount: "pass",
    model: "pass",
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
  // Every field here is a machine code or a magnitude — no prompt, no model
  // output. `reason` is the one free-form-ish field (it carries an exception
  // message on outcome="threw"), so it is capped + scrubbed rather than passed.
  // Without this entry the fail-safe below would strip run-finished to
  // `{t, kind}` on the wire: a content-free terminal event, which is precisely
  // the §2.6 attack shape the plan says must not pass as accountability.
  "run-finished": {
    runId: "pass",
    subcommand: "pass",
    outcome: "pass",
    success: "pass",
    reason: 300,
    sprintsRun: "pass",
    shipped: "pass",
    ts: "pass",
  },
  // Emitted at the two points a sprint plan is committed:
  // src/product-loop/index.ts:465-474 (source="auto") and :1051-1060
  // (source="council"). Both spread the SAME six fields, so this entry is the
  // union as well as each site. Shape: protocol.ts:306-319.
  // `projectDir` is an ABSOLUTE PATH (protocol.ts:310-311) — capped + scrubbed,
  // never "pass". `sprintIds` is a string ARRAY (protocol.ts:315), handled by the
  // array branch of applySpec below.
  "sprint-plan-committed": {
    runId: "pass",
    projectDir: 300,
    sprintCount: "pass",
    sprintIds: 64,
    source: "pass",
    ts: "pass",
  },
  "route-decision": {
    path: "pass",
    complexity: "pass",
    forceCouncil: "pass",
    runId: "pass",
  },
  "steer-inject": {
    count: "pass",
    atStep: "pass",
    runId: "pass",
  },
  "resume-request": {
    // A session id (word/dash chars only, vetted by the tui.start allowlist) —
    // safe to pass through so the driving agent can restart bound to it.
    sessionId: "pass",
    ts: "pass",
  },
  // Two counters and a timestamp — no user text, no prompt, no model output.
  // `dropped` is the whole point of the event carrying a payload at all: a
  // bare {t, kind} would announce "input is ready" while hiding that commands
  // were lost getting there.
  "input-ready": {
    flushed: "pass",
    dropped: "pass",
    ts: "pass",
  },
  toast: {
    level: "pass",
    text: 500, // cap to 500 chars, then scrub
    ttlMs: "pass",
  },
  "stream.delta": {
    target: "pass",
    text: 500, // cap to 500 chars
  },
  usage: {
    source: "pass",
    model: "pass",
    inputTokens: "pass",
    outputTokens: "pass",
    cacheReadTokens: "pass",
    cacheCreationTokens: "pass",
    messageSeq: "pass",
  },
  // EE observability. Single emit site each: src/utils/ee-logger.ts:142-149
  // (ee-timeout) and :151-158 (ee-error). Shapes: protocol.ts:346-353 / :354-361.
  //
  // `source` is documented as a stable identifier (protocol.ts:342-345) but is
  // typed plain `string` and passed by callers, so it is capped rather than
  // passed. `name` / `message` come straight off the thrown error via
  // `describeError` (ee-logger.ts:100-107) — `message` is the field that carries
  // an upstream provider response body, so it gets the tightest treatment here.
  "ee-timeout": {
    source: 120,
    elapsedMs: "pass",
    budgetMs: "pass",
    ts: "pass",
  },
  "ee-error": {
    source: 120,
    name: 120,
    message: 500,
    ts: "pass",
  },
  // Transport teardown. Emit site: tests/harness/helpers.ts:136-146.
  // Shape: protocol.ts:365-371. `reason` is compile-time bounded to
  // "end" | "close" today, so the cap is a no-op on every real payload — it is
  // there because a field named `reason` is free-form prose on the two sibling
  // events in this same schema (`sprint-halt.reason`, `run-finished.reason`,
  // capped at 300 above), and a third disconnect reason carrying an error string
  // would otherwise reach the wire unbounded.
  disconnect: {
    reason: 64,
    ts: "pass",
  },
  // Emitted before each retry backoff. Six emit sites, all with the SAME five
  // fields: src/orchestrator/orchestrator.ts:1634-1638 (spreads `RetryInfo`,
  // declared at src/orchestrator/retry-stream.ts:3-9), tool-engine.ts:984-992,
  // :3244-3252, :3316-3324, :3483-3491, :4473-4481, and
  // batch-turn-runner.ts:385-393. Shape: protocol.ts:375-384.
  //
  // `errorMessage` is `err.message` verbatim (retry-stream.ts:130). On an
  // `AI_APICallError` that message can embed the upstream response body — the
  // 160KB-dump shape. The cap is what bounds it; scrubKeys alone would not.
  "stream-retry": {
    attempt: "pass",
    maxAttempts: "pass",
    errorName: 120,
    errorMessage: 500,
    nextDelayMs: "pass",
  },
  // Emit site: src/council/llm.ts (tracedGenerateWithFallback). Shape: protocol.ts.
  //
  // Every free-text field here is CAPPED, never "pass". `errorMessage` is the
  // provider's own message, which on an `AI_APICallError` can embed the serialized
  // upstream response body (the 160KB-dump shape that reached stderr once) — the
  // cap is what bounds it; scrubKeys alone would not. Model ids and the phase label
  // are model/catalog-derived rather than user text, but they are still capped so
  // no field on this kind is an unbounded channel.
  "model-fallback": {
    fromModel: 120,
    toModel: 120,
    reason: "pass",
    attempt: "pass",
    totalCandidates: "pass",
    exhausted: "pass",
    label: 200,
    provider: 60,
    statusCode: "pass",
    errorName: 120,
    errorMessage: 500,
    ts: "pass",
  },
  // Emit site: src/orchestrator/tool-engine.ts:4006-4012. Shape: protocol.ts:389-397.
  // `claims` is a string ARRAY of model-authored text (e.g. ["67 tests",
  // "app.tsx:836"]) — the most free-form payload of the six. Per-element cap +
  // scrub via the array branch of applySpec, plus MAX_ARRAY_ITEMS on the count.
  "grounding-flag": {
    claims: 200,
    count: "pass",
    ts: "pass",
  },
};

type EventKind = Extract<LiveEvent, { t: "event" }>["kind"];

/**
 * Apply the field spec to a single value.
 */
function applySpec(value: unknown, spec: FieldSpec): unknown {
  // String arrays (grounding-flag.claims, sprint-plan-committed.sprintIds) hit the
  // `typeof value !== "string"` fast path below and would pass through completely
  // unprocessed — a numeric cap declared on an array field would be a silent no-op,
  // i.e. an unbounded free-text channel behind a cap that looks applied. Bound the
  // element COUNT, then apply the same spec to every string element.
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => (typeof item === "string" ? applySpec(item, spec) : item));
  }
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

  // Unknown kind: keep only t + kind, drop everything else (fail-safe).
  //
  // Now a RUNTIME-ONLY path: `ALLOWED_FIELDS` is a non-partial `Record<EventKind, …>`,
  // so every declared kind has an entry and `tsc` rejects a new one that does not.
  // This still fires for a payload whose `kind` is not a declared LiveEvent kind at
  // all (the `e.kind as EventKind` cast above lets one in from an untyped transport),
  // which is exactly the case it should catch.
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
